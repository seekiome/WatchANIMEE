function connectWS(){
  const proto=location.protocol==='https:'?'wss':'ws';
  ws=new WebSocket(`${proto}://${location.host}`);
  if(!myClientId) myClientId=sessionStorage.getItem('wt-clientId')||rid(8);
  sessionStorage.setItem('wt-clientId',myClientId);
  let _pingTime=Date.now();
  ws.onopen=()=>{
    _pingTime=Date.now();
    ws.send(JSON.stringify({type:'join',roomId,isHost,clientId:myClientId}));
    sysMsg(i('joined',myName,isHost));
  };
  ws.onmessage=async(e)=>{
    const msg=JSON.parse(e.data);
    if(msg.type==='init'){
      _networkLatency=(Date.now()-_pingTime)/2;
      document.getElementById('viewersCount').textContent=msg.viewers;
      if(msg.isHost!==undefined) isHost=msg.isHost;
    }
    if(msg.type==='viewers') document.getElementById('viewersCount').textContent=msg.count;
    if(msg.type==='video_ready'){
      if(!isHost){
        document.getElementById('waitingText').textContent=i('waitRecv');
        loadVideoFromServer(msg.streamUrl,msg.state||null,msg.serverTime||null);
        sysMsg(i('videoReceived'));
      } else if(msg.state && document.getElementById('videoPlayer').style.display==='none'){
        loadVideoFromServer(msg.streamUrl,msg.state,msg.serverTime||null);
      }
      if(msg.queueIdx!==undefined) queueCurrentIdx=msg.queueIdx;
    }
    if(msg.type==='host_left') sysMsg(i('hostLeft'));
    if(msg.type==='sync'&&!isHost){
      const v=document.getElementById('videoPlayer');
      if(!v.src) return;
      isSyncing=true;
      const latency=_networkLatency/1000;
      const targetTime=msg.playing?msg.time+latency:msg.time;
      const drift=Math.abs(v.currentTime-targetTime);
      // Не трогаем позицию пока буферизирует — иначе будет прыжок
      const isBuffering=v.readyState<3;
      if(!isBuffering){
        if(drift>5.0){
          // Хост перемотал далеко — жёсткая синхронизация
          v.currentTime=targetTime;
          showSyncIndicator();
        } else if(drift>1.5){
          // Небольшое отставание — плавная корректировка
          v.playbackRate=msg.playing?(v.currentTime<targetTime?1.1:0.9):1;
          setTimeout(()=>{ v.playbackRate=1; },3000);
        }
      }
      if(msg.playing&&v.paused&&!isBuffering) v.play().catch(()=>{});
      if(!msg.playing&&!v.paused) v.pause();
      setPlayIcon(!msg.playing);
      setTimeout(()=>isSyncing=false,500);
    }
    if(msg.type==='queue_update'){
      queue=msg.queue.map(q=>({id:q.id,filename:q.origName,origName:q.origName,uploaded:true,serverFile:null,streamUrl:`/video-stream/${roomId}`}));
      queueCurrentIdx=msg.queueIdx;
      renderQueue(); updateQueueBadge();
      if(queue.length>0) document.getElementById('queueBtn').style.display='flex';
    }
    if(msg.type==='chat') addMsg(msg.name,msg.text,msg.avatar);
    if(msg.type==='error') sysMsg('Error: '+msg.message);
  };
  ws.onclose=()=>{
    sysMsg(i('disconnected'));
    if(roomId&&!_intentionalDisconnect) setTimeout(()=>{ if(roomId&&!_intentionalDisconnect&&(!ws||ws.readyState===3)) connectWS(); },3000);
  };
}

function showSyncIndicator(){
  const el=document.getElementById('syncIndicator');
  el.textContent=i('syncingMsg'); el.classList.add('show');
  setTimeout(()=>el.classList.remove('show'),2000);
}
