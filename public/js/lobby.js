function switchTab(tab){
  document.querySelectorAll('.tab').forEach((t,idx)=>t.classList.toggle('active',(tab==='host'&&idx===0)||(tab==='join'&&idx===1)));
  document.getElementById('hostTab').style.display=tab==='host'?'block':'none';
  document.getElementById('joinTab').style.display=tab==='join'?'block':'none';
}

window.addEventListener('load',()=>{
  const p=new URLSearchParams(location.search);
  if(p.get('room')){ document.getElementById('joinCode').value=p.get('room'); switchTab('join'); }
  setTheme(localStorage.getItem('wt-theme')||'dark');
  setLang('en');
  spawnPetals();
});

function createRoom(){
  const n=document.getElementById('hostName').value.trim();
  if(!n) return;
  myName=n; isHost=true; roomId=rid();
  startApp();
}
function joinRoom(){
  const n=document.getElementById('joinName').value.trim();
  const c=document.getElementById('joinCode').value.trim().toUpperCase();
  if(!n||!c) return;
  myName=n; isHost=false; roomId=c;
  startApp();
}

function goHome(){
  _intentionalDisconnect=true;
  roomId=null;
  if(ws){ ws.onclose=null; ws.close(); ws=null; }
  const v=document.getElementById('videoPlayer');
  try{ v.pause(); }catch(e){}
  if(v.src&&v.src.startsWith('blob:')) URL.revokeObjectURL(v.src);
  v.removeAttribute('src'); v.srcObject=null; v.style.display='none';
  try{ v.load(); }catch(e){}
  isHost=false; isSyncing=false; _eventsSetup=false; myClientId=null; sessionStorage.removeItem('wt-clientId');
  document.getElementById('controls').style.display='none';
  document.getElementById('uploadZone').style.display='none';
  document.getElementById('waitingScreen').style.display='none';
  document.getElementById('uploadProgressWrap').classList.remove('active');
  document.getElementById('messages').innerHTML='';
  if(_titleObserver){ _titleObserver.disconnect(); _titleObserver=null; }
  document.getElementById('videoArea').classList.remove('has-video');
  queue=[]; queueCurrentIdx=-1; queuePopupOpen=false;
  document.getElementById('queuePopup').classList.remove('open');
  const qb=document.getElementById('queueBadge');
  if(qb) qb.classList.remove('show');
  const app=document.getElementById('app');
  if(app.classList.contains('fs-mode')) app.classList.remove('fs-mode','show-ctrl');
  document.getElementById('app').style.display='none';
  document.getElementById('lobby').style.display='flex';
  // Очищаем внутренний canvas чтобы не было артефактов при смене темы
  const inner=document.getElementById('bgCanvasInner');
  if(inner){ inner.getContext('2d').clearRect(0,0,inner.width,inner.height); inner.style.opacity='0'; }
  history.replaceState(null,'',location.pathname);
}

function startApp(){
  _intentionalDisconnect=false;
  document.getElementById('lobby').style.display='none';
  document.getElementById('app').style.display='flex';
  document.getElementById('roomCodeDisplay').textContent=roomId;
  if(isHost) document.getElementById('uploadZone').style.display='flex';
  else { document.getElementById('waitingScreen').style.display='flex'; document.getElementById('waitingText').textContent=i('waitingHost'); }
  connectWS();
}
