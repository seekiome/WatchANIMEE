function playQueueItem(idx){
  if(idx<0||idx>=queue.length) return;
  const item=queue[idx];
  if(!item.uploaded||!item.serverFile) return;
  queueCurrentIdx=idx;
  if(ws&&ws.readyState===1) ws.send(JSON.stringify({type:'queue_play',idx}));
  loadVideoFromServer(`/video-stream/${roomId}`,null,null);
  sysMsg(`▶ Now playing: ${item.filename}`);
  renderQueue(); updateQueueBadge();
}

function renderQueue(){
  const list=document.getElementById('queueList');
  const empty=document.getElementById('queueEmpty');
  document.getElementById('queueCount').textContent=queue.length;
  if(queue.length===0){ empty.style.display='block'; list.innerHTML=''; list.appendChild(empty); return; }
  empty.style.display='none'; list.innerHTML='';
  queue.forEach((item,idx)=>{
    const isActive=idx===queueCurrentIdx;
    const div=document.createElement('div');
    div.className='queue-item'+(isActive?' active-item':'');
    div.dataset.idx=idx; div.draggable=true;
    const shortName=(item.filename||item.origName||'').replace(/\.[^.]+$/,'').replace(/_/g,' ');
    const pctText=(!item.uploaded&&item._pct!==undefined)?` (${item._pct}%)`:'';
    div.innerHTML=`<div class="queue-drag-handle"><svg viewBox="0 0 24 24"><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="18" x2="16" y2="18"/></svg></div><div class="queue-item-num">${idx+1}</div><div class="queue-item-icon"><svg viewBox="0 0 24 24"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg></div><div class="queue-item-name" title="${esc(item.filename||item.origName||'')}">${esc(shortName)}${pctText}</div><div class="queue-item-playing">▶ NOW</div><button class="queue-delete-btn"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;
    div.querySelector('.queue-delete-btn').addEventListener('click',e=>{ e.stopPropagation(); removeFromQueue(item.id); });
    div.addEventListener('dblclick',()=>{ if(isHost) playQueueItem(idx); });
    div.addEventListener('dragstart',e=>{ e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain',idx); div.classList.add('dragging'); });
    div.addEventListener('dragend',()=>div.classList.remove('dragging'));
    div.addEventListener('dragover',e=>{ e.preventDefault(); div.classList.add('drag-over'); });
    div.addEventListener('dragleave',()=>div.classList.remove('drag-over'));
    div.addEventListener('drop',e=>{
      e.preventDefault(); div.classList.remove('drag-over');
      const fromIdx=parseInt(e.dataTransfer.getData('text/plain'));
      const toIdx=idx; if(fromIdx===toIdx) return;
      const moved=queue.splice(fromIdx,1)[0]; queue.splice(toIdx,0,moved);
      if(queueCurrentIdx===fromIdx) queueCurrentIdx=toIdx;
      else if(fromIdx<queueCurrentIdx&&toIdx>=queueCurrentIdx) queueCurrentIdx--;
      else if(fromIdx>queueCurrentIdx&&toIdx<=queueCurrentIdx) queueCurrentIdx++;
      if(ws&&ws.readyState===1) ws.send(JSON.stringify({type:'queue_reorder',fromIdx,toIdx}));
      renderQueue();
    });
    list.appendChild(div);
  });
}

function updateQueueBadge(){
  const badge=document.getElementById('queueBadge');
  if(!badge) return;
  const remaining=queue.length-(queueCurrentIdx+1);
  if(remaining>0){ badge.textContent=remaining; badge.classList.add('show'); }
  else badge.classList.remove('show');
}

function onVideoEnded(){
  if(!isHost) return;
  const nextIdx=queueCurrentIdx+1;
  if(nextIdx<queue.length){
    playQueueItem(nextIdx); updateQueueBadge();
  } else {
    // Очередь кончилась — сообщаем серверу
    if(ws&&ws.readyState===1) ws.send(JSON.stringify({type:'queue_next'}));
  }
}

function uploadVideo(file){
  // Для зрителей — прямая загрузка без очереди
  const uploadZone=document.getElementById('uploadZone');
  const wrap=document.getElementById('uploadProgressWrap');
  uploadZone.style.display='none'; wrap.classList.add('active');
  document.getElementById('uploadPct').textContent='0%';
  document.getElementById('uploadFill').style.width='0%';
  document.getElementById('uploadInfo').textContent='';
  const xhr=new XMLHttpRequest();
  xhr.open('POST',`/upload/${roomId}`);
  const uploadStart=Date.now();
  xhr.upload.onprogress=(e)=>{
    if(e.lengthComputable){
      const pct=Math.round((e.loaded/e.total)*100);
      const elapsed=(Date.now()-uploadStart)/1000||0.001;
      const speed=e.loaded/elapsed;
      const remaining=(e.total-e.loaded)/speed;
      document.getElementById('uploadPct').textContent=pct+'%';
      document.getElementById('uploadFill').style.width=pct+'%';
      const speedStr=speed>1048576?`${(speed/1048576).toFixed(1)} MB/s`:`${(speed/1024).toFixed(0)} KB/s`;
      const etaStr=isFinite(remaining)?(remaining>60?`${Math.ceil(remaining/60)}m left`:`${Math.ceil(remaining)}s left`):'';
      document.getElementById('uploadInfo').textContent=`${speedStr}${etaStr?' · '+etaStr:''}`;
    }
  };
  xhr.onload=()=>{
    wrap.classList.remove('active');
    if(xhr.status!==200){ sysMsg('Upload failed ('+xhr.status+')'); uploadZone.style.display='flex'; return; }
    const res=JSON.parse(xhr.responseText);
    loadVideoFromServer(`/video-stream/${roomId}`,null,null);
    if(ws&&ws.readyState===1) ws.send(JSON.stringify({type:'video_ready',origName:res.origName,serverFile:res.serverFile}));
    sysMsg(i('videoSelected'));
  };
  xhr.onerror=()=>{ wrap.classList.remove('active'); uploadZone.style.display='flex'; sysMsg('Upload failed'); };
  xhr.send((()=>{ const fd=new FormData(); fd.append('video',file); return fd; })());
}

let _titleObserver=null;
