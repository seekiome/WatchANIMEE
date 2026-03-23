function setTheme(t){
  document.documentElement.setAttribute('data-theme',t);
  localStorage.setItem('wt-theme',t);
  document.getElementById('themeLightBtn').classList.toggle('active',t==='light');
  document.getElementById('themeDarkBtn').classList.toggle('active',t==='dark');
}
function setLang(l){
  lang=l;
  document.querySelectorAll('.lang-btn').forEach((b,idx)=>b.classList.toggle('active',['en','ru','uk','ja'][idx]===l));
  const t=T[l];
  const s=(id,v)=>{ const el=document.getElementById(id); if(el) el.textContent=v; };
  const p=(id,v)=>{ const el=document.getElementById(id); if(el) el.placeholder=v; };
  s('tabHost',t.tabHost); s('tabJoin',t.tabJoin);
  s('labelNameHost',t.labelNameHost); s('labelNameJoin',t.labelNameJoin); s('labelCode',t.labelCode);
  p('hostName',t.hostNamePh); p('joinName',t.joinNamePh); p('joinCode',t.codePh);
  s('btnCreateText',t.btnCreate); s('btnJoinText',t.btnJoin);
  s('uploadTitle',t.uploadTitle); s('chatLabel',t.chatLabel); s('fsChatLabel',t.chatLabel);
  p('chatInput',t.chatPh);
  s('modalTitle',t.modalTitle); s('modalSub',t.modalSub);
  s('orCode',t.orCode); s('copyBtnLabel',t.copyBtn); s('modalCloseText',t.modalClose);
  s('waitingText',t.waitingHost);
}
