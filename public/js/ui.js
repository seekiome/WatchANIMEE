function toggleQueue(){ queuePopupOpen=!queuePopupOpen; document.getElementById('queuePopup').classList.toggle('open',queuePopupOpen); }
document.addEventListener('click',e=>{ const popup=document.getElementById('queuePopup'); const btn=document.getElementById('queueBtn'); if(queuePopupOpen&&popup&&!popup.contains(e.target)&&btn&&!btn.contains(e.target)){ queuePopupOpen=false; popup.classList.remove('open'); } });
function copyRoomLink(){ if(!roomId) return; navigator.clipboard.writeText(`${location.origin}?room=${roomId}`); const btn=document.getElementById('roomCopyBtn'); if(btn){ btn.style.color='var(--accent)'; setTimeout(()=>btn.style.color='',1500); } }
function openShare(){ document.getElementById('shareLink').value=`${location.origin}?room=${roomId}`; document.getElementById('shareCode').textContent=roomId; document.getElementById('shareModal').classList.add('open'); }
function closeShare(){ document.getElementById('shareModal').classList.remove('open'); }
function copyLink(){ navigator.clipboard.writeText(document.getElementById('shareLink').value); const b=document.getElementById('copyBtnLabel'); b.textContent=i('copyDone'); setTimeout(()=>b.textContent=i('copyBtn'),2000); }

function spawnPetals(){
  function c(){ const p=document.createElement('div'); p.className='petal'; const isDark=document.documentElement.getAttribute('data-theme')==='dark'; const hue=isDark?(310+Math.random()*35):(335+Math.random()*25); const sat=isDark?(55+Math.random()*30):(50+Math.random()*25); const light=isDark?(60+Math.random()*25):(78+Math.random()*14); const alpha=isDark?(0.2+Math.random()*0.45):(0.3+Math.random()*0.5); p.style.cssText=`left:${Math.random()*100}vw;animation-duration:${5+Math.random()*8}s;animation-delay:${Math.random()*4}s;width:${5+Math.random()*7}px;height:${6+Math.random()*8}px;transform:rotate(${Math.random()*360}deg);background:hsla(${hue},${sat}%,${light}%,${alpha})`; document.body.appendChild(p); setTimeout(()=>p.remove(),15000); }
  setInterval(c,600);
}
