function playQueueItem(idx){
  if(idx<0||idx>=queue.length) return;
  const item=queue[idx];
  if(!item.uploaded||!item.serverFile) return;
  queueCurrentIdx=idx;
  if(ws&&ws.readyState===1) ws.send(JSON.stringify({type:'queue_play',idx}));
  loadVideoFromServer(`/video-stream/${roomId}`,null,null);
  sysMsg(`▶ Now playing: ${item.filename||item.origName}`);
  renderQueue(); updateQueueBadge();
}

function onVideoEnded(){
  if(!isHost) return;
  const nextIdx=queueCurrentIdx+1;
  if(nextIdx<queue.length&&queue[nextIdx].uploaded){
    playQueueItem(nextIdx); updateQueueBadge();
  } else if(ws&&ws.readyState===1){
    ws.send(JSON.stringify({type:'queue_next'}));
  }
}

function renderQueue(){
  const list=document.getElementById('queueList');
  const empty=document.getElementById('queueEmpty');
  document.getElementById('queueCount').textContent=queue.length;
  if(queue.length===0){
    if(empty) empty.style.display='block';
    Array.from(list.children).forEach(c=>{ if(c.id!=='queueEmpty') c.remove(); });
    return;
  }
  if(empty) empty.style.display='none';
  Array.from(list.children).forEach(c=>{ if(c.id!=='queueEmpty') c.remove(); });
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
