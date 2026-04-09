function selectVideo(input){
  const f=input.files[0]; if(!f) return;
  uploadAndQueue(f, queue.length===0 && document.getElementById('videoPlayer').style.display!=='block');
  input.value='';
}

// Загружает файл. playImmediately=true — сразу запускает, false — добавляет в очередь
function uploadAndQueue(file, playImmediately){
  const id=_nextQueueId++;
  queue.push({id,filename:file.name,origName:file.name,uploaded:false,serverFile:null,_pct:0});
  const queueIdx=queue.length-1;
  if(playImmediately) queueCurrentIdx=queueIdx;
  renderQueue(); updateQueueBadge();
  document.getElementById('queueBtn').style.display='flex';

  // Показываем прогресс загрузки
  const uploadZone=document.getElementById('uploadZone');
  const wrap=document.getElementById('uploadProgressWrap');
  if(playImmediately){
    uploadZone.style.display='none';
    wrap.classList.add('active');
    document.getElementById('uploadPct').textContent='0%';
    document.getElementById('uploadFill').style.width='0%';
    document.getElementById('uploadInfo').textContent='';
  }

  const xhr=new XMLHttpRequest();
  xhr.open('POST',`/upload/${roomId}`);
  const uploadStart=Date.now();
  xhr.upload.onprogress=(e)=>{
    if(!e.lengthComputable) return;
    const pct=Math.round(e.loaded/e.total*100);
    const item=queue.find(q=>q.id===id);
    if(item) item._pct=pct;
    if(playImmediately){
      const elapsed=(Date.now()-uploadStart)/1000||0.001;
      const speed=e.loaded/elapsed;
      const remaining=(e.total-e.loaded)/speed;
      document.getElementById('uploadPct').textContent=pct+'%';
      document.getElementById('uploadFill').style.width=pct+'%';
      const speedStr=speed>1048576?`${(speed/1048576).toFixed(1)} MB/s`:`${(speed/1024).toFixed(0)} KB/s`;
      const etaStr=isFinite(remaining)?(remaining>60?`${Math.ceil(remaining/60)}m left`:`${Math.ceil(remaining)}s left`):'';
      document.getElementById('uploadInfo').textContent=`${speedStr}${etaStr?' · '+etaStr:''}`;
    } else {
      renderQueue();
    }
  };
  xhr.onload=()=>{
    if(playImmediately) wrap.classList.remove('active');
    if(xhr.status!==200){ sysMsg('Upload failed ('+xhr.status+')'); if(playImmediately) uploadZone.style.display='flex'; return; }
    const res=JSON.parse(xhr.responseText);
    const item=queue.find(q=>q.id===id);
    if(item){ item.uploaded=true; item.serverFile=res.serverFile; item._pct=100; }
    renderQueue(); updateQueueBadge();
    if(playImmediately){
      if(ws&&ws.readyState===1) ws.send(JSON.stringify({type:'video_ready',origName:res.origName,serverFile:res.serverFile}));
      loadVideoFromServer(`/video-stream/${roomId}`,null,null);
      sysMsg(i('videoSelected'));
    } else {
      // Добавляем в очередь на сервере
      if(ws&&ws.readyState===1) ws.send(JSON.stringify({type:'queue_add',id,origName:res.origName,serverFile:res.serverFile}));
      sysMsg(`Added to queue: ${file.name}`);
    }
  };
  xhr.onerror=()=>{ if(playImmediately) wrap.classList.remove('active'); sysMsg('Upload error'); };
  xhr.send((()=>{ const fd=new FormData(); fd.append('video',file); return fd; })());
}

function addToQueue(input){
  const files=Array.from(input.files);
  files.forEach(file=>uploadAndQueue(file));
  input.value='';
}

function removeFromQueue(id){
  const idx=queue.findIndex(q=>q.id===id);
  if(idx===-1) return;
  queue.splice(idx,1);
  if(idx<queueCurrentIdx) queueCurrentIdx--;
  else if(idx===queueCurrentIdx) queueCurrentIdx=Math.max(-1,queueCurrentIdx-1);
  if(ws&&ws.readyState===1) ws.send(JSON.stringify({type:'queue_remove',id}));
  renderQueue(); updateQueueBadge();
}

function loadVideoFromServer(src,state,serverTime){
  _eventsSetup=false;
  if(_titleObserver){ _titleObserver.disconnect(); _titleObserver=null; }
  const video=document.getElementById('videoPlayer');
  video.src=''; video.src=src;
  _titleObserver=new MutationObserver(()=>{ document.title='Watch Together'; });
  _titleObserver.observe(document.querySelector('title'),{childList:true,characterData:true,subtree:true});
  video.addEventListener('canplay',()=>{
    document.getElementById('uploadProgressWrap').classList.remove('active');
    document.getElementById('uploadZone').style.display='none';
    showPlayer(); setupEvents();
    if(state){
      let targetTime=state.time||0;
      if(state.playing&&serverTime){ const elapsed=(Date.now()-serverTime)/1000+_networkLatency/1000; targetTime+=elapsed; }
      video.currentTime=Math.min(targetTime,video.duration||targetTime);
      if(state.playing) video.play().catch(()=>{});
      setPlayIcon(!state.playing);
    }
  },{once:true});
}

function showPlayer(){
  document.getElementById('videoPlayer').style.display='block';
  document.getElementById('uploadZone').style.display='none';
  document.getElementById('waitingScreen').style.display='none';
  document.getElementById('controls').style.display='block';
  document.getElementById('videoArea').classList.add('has-video');
  if(isHost){ document.getElementById('changeVideoBtn').style.display='flex'; document.getElementById('playPauseBtn').style.display='flex'; document.getElementById('queueBtn').style.display='flex'; }
  else { document.getElementById('playPauseBtn').style.display='none'; document.getElementById('progressBg').style.cursor='default'; }
}

let _eventsSetup=false, _controlsTimer=null, _mouseOverControls=false;
function showControls(){
  const c=document.getElementById('controls'); c.classList.add('visible');
  clearTimeout(_controlsTimer);
  const v=document.getElementById('videoPlayer');
  _controlsTimer=setTimeout(()=>{ if(!_mouseOverControls) c.classList.remove('visible'); },v&&v.paused?3000:1000);
}

function setupEvents(){
  if(_eventsSetup) return; _eventsSetup=true;
  const v=document.getElementById('videoPlayer');
  if(!!window.chrome&&!window.opr) v.addEventListener('error',()=>{ document.getElementById('codecWarning').classList.add('show'); },{once:true});
  v.addEventListener('timeupdate',()=>{
    if(v.duration){ const pct=(v.currentTime/v.duration)*100; document.getElementById('progressFill').style.width=pct+'%'; document.getElementById('progressThumb').style.left=pct+'%'; document.getElementById('timeLabel').textContent=`${ft(v.currentTime)} / ${ft(v.duration)}`; }
    if(isHost&&!isSyncing) throttleSync(v);
  });
  v.addEventListener('play',()=>{ setPlayIcon(false); if(isHost) syncHost(); showControls(); });
  v.addEventListener('pause',()=>{ setPlayIcon(true); if(isHost) syncHost(); showControls(); });
  v.addEventListener('ended',onVideoEnded);
  v.addEventListener('dblclick',toggleFullscreen);
  const va=document.getElementById('videoArea');
  va.addEventListener('mousemove',()=>{ showControls(); const app=document.getElementById('app'); if(app.classList.contains('fs-mode')) app.classList.add('show-ctrl'); });
  va.addEventListener('mouseleave',()=>{ document.getElementById('app').classList.remove('show-ctrl'); });
  va.addEventListener('touchstart',()=>showControls(),{passive:true});
  const ctrl=document.getElementById('controls');
  ctrl.addEventListener('mouseenter',()=>{ _mouseOverControls=true; clearTimeout(_controlsTimer); });
  ctrl.addEventListener('mouseleave',()=>{ _mouseOverControls=false; showControls(); });
  showControls();
}

function setPlayIcon(showPlay){
  const path=document.querySelector('#playIcon path');
  if(path) path.setAttribute('d',showPlay?'M5 3l14 9-14 9V3z':'M6 19h4V5H6v14zm8-14v14h4V5h-4z');
}
let _syncTimer=null;
function throttleSync(v){ if(_syncTimer) return; _syncTimer=setTimeout(()=>{ _syncTimer=null; if(!isSyncing&&ws&&ws.readyState===1) ws.send(JSON.stringify({type:'sync',playing:!v.paused,time:v.currentTime})); },400); }
function syncHost(){ if(!isHost||isSyncing) return; const v=document.getElementById('videoPlayer'); if(!v.src) return; if(ws&&ws.readyState===1) ws.send(JSON.stringify({type:'sync',playing:!v.paused,time:v.currentTime})); }
function togglePlay(){ if(!isHost) return; const v=document.getElementById('videoPlayer'); if(!v.src) return; v.paused?v.play():v.pause(); }
function seekByClick(e){ if(!isHost) return; const v=document.getElementById('videoPlayer'); if(!v.duration) return; const rect=document.getElementById('progressBg').getBoundingClientRect(); const pct=Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width)); v.currentTime=pct*v.duration; document.getElementById('progressFill').style.width=(pct*100)+'%'; document.getElementById('progressThumb').style.left=(pct*100)+'%'; syncHost(); }
let _dragging=false;
function startDrag(e){ if(isHost){ _dragging=true; e.preventDefault(); } }
document.addEventListener('mousemove',e=>{ if(!_dragging||!isHost) return; const v=document.getElementById('videoPlayer'); if(!v.duration) return; const rect=document.getElementById('progressBg').getBoundingClientRect(); const pct=Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width)); v.currentTime=pct*v.duration; document.getElementById('progressFill').style.width=(pct*100)+'%'; document.getElementById('progressThumb').style.left=(pct*100)+'%'; document.getElementById('timeLabel').textContent=`${ft(v.currentTime)} / ${ft(v.duration)}`; showControls(); });
document.addEventListener('mouseup',()=>{ if(_dragging){ _dragging=false; syncHost(); } });
function skipTime(sec){ if(!isHost) return; const v=document.getElementById('videoPlayer'); if(!v.duration) return; v.currentTime=Math.max(0,Math.min(v.duration,v.currentTime+sec)); syncHost(); showControls(); }

document.addEventListener('keydown',e=>{
  const tag=document.activeElement.tagName;
  if(tag==='INPUT'||tag==='TEXTAREA') return;
  if(document.getElementById('app').style.display==='none') return;
  const v=document.getElementById('videoPlayer');
  if(!v||v.style.display==='none') return;
  if(e.code==='Space'){ e.preventDefault(); if(isHost) togglePlay(); showControls(); }
  if(e.code==='ArrowRight'&&isHost){ e.preventDefault(); skipTime(5); }
  if(e.code==='ArrowLeft'&&isHost){ e.preventDefault(); skipTime(-5); }
  if(e.code==='ArrowUp'){ e.preventDefault(); const sl=document.getElementById('volSlider'); const nv=Math.min(1,parseFloat(sl.value)+0.1); sl.value=nv; setVolume(nv); }
  if(e.code==='ArrowDown'){ e.preventDefault(); const sl=document.getElementById('volSlider'); const nv=Math.max(0,parseFloat(sl.value)-0.1); sl.value=nv; setVolume(nv); }
  if(e.code==='KeyF'){ e.preventDefault(); toggleFullscreen(); }
  if(e.code==='KeyM'){ e.preventDefault(); toggleMute(); }
});

function setVolume(val){ const v=document.getElementById('videoPlayer'); v.volume=parseFloat(val); v.muted=false; updateVolIcon(parseFloat(val)); }
function toggleMute(){ const v=document.getElementById('videoPlayer'); const sl=document.getElementById('volSlider'); if(v.muted||v.volume===0){ v.muted=false; v.volume=sl._lastVol||0.8; sl.value=v.volume; } else { sl._lastVol=v.volume; v.muted=true; sl.value=0; } updateVolIcon(v.muted?0:v.volume); }
function updateVolIcon(vol){ const icon=document.getElementById('volIcon'); if(!icon) return; if(vol<=0) icon.innerHTML='<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>'; else if(vol<0.5) icon.innerHTML='<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 010 7.07"/>'; else icon.innerHTML='<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 010 14.14"/><path d="M15.54 8.46a5 5 0 010 7.07"/>'; }

function toggleFullscreen(){
  const app=document.getElementById('app');
  const isFs=!!document.fullscreenElement||!!document.webkitFullscreenElement;
  if(!isFs){ const req=app.requestFullscreen||app.webkitRequestFullscreen||app.mozRequestFullScreen; if(req) req.call(app); else enterFsMode(); }
  else { const exit=document.exitFullscreen||document.webkitExitFullscreen||document.mozCancelFullScreen; if(exit) exit.call(document); else exitFsMode(); }
}
function enterFsMode(){ document.getElementById('app').classList.add('fs-mode'); document.getElementById('fsIcon').innerHTML='<path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3"/>'; syncFsChat(); showControls(); }
function exitFsMode(){ document.getElementById('app').classList.remove('fs-mode','show-ctrl'); document.getElementById('fsIcon').innerHTML='<path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/>'; }
function onFsChange(){ const isFs=!!document.fullscreenElement||!!document.webkitFullscreenElement; if(isFs) enterFsMode(); else exitFsMode(); }
document.addEventListener('fullscreenchange',onFsChange);
document.addEventListener('webkitfullscreenchange',onFsChange);
document.addEventListener('mozfullscreenchange',onFsChange);
function syncFsChat(){ const dst=document.getElementById('fsChatMessages'); dst.innerHTML=document.getElementById('messages').innerHTML; dst.scrollTop=dst.scrollHeight; }
function sendFsChat(){ const inp=document.getElementById('fsChatInput'); const txt=inp.value.trim(); if(!txt||!ws) return; ws.send(JSON.stringify({type:'chat',name:myName,text:txt})); inp.value=''; }

let queue=[], queueCurrentIdx=-1, queuePopupOpen=false, _nextQueueId=1;
