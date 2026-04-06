const MAX_MESSAGES = 200;

function addMsg(author, text, avatar) {
  _appendMsg('messages', author, text, avatar);
  _appendMsg('fsChatMessages', author, text, avatar);
}

function _appendMsg(containerId, author, text, avatar) {
  const m = document.getElementById(containerId);
  if (!m) return;
  // Лимит сообщений — удаляем старые
  while (m.children.length >= MAX_MESSAGES) m.removeChild(m.firstChild);
  const d = document.createElement('div');
  d.className = 'msg';
  const av = avatar ? `<span style="margin-right:.3rem">${esc(avatar)}</span>` : '';
  d.innerHTML = `<div class="msg-author">${av}${esc(author)}</div><div class="msg-text">${esc(text)}</div>`;
  m.appendChild(d);
  m.scrollTop = m.scrollHeight;
}

function sysMsg(text) {
  ['messages', 'fsChatMessages'].forEach(id => {
    const m = document.getElementById(id);
    if (!m) return;
    while (m.children.length >= MAX_MESSAGES) m.removeChild(m.firstChild);
    const d = document.createElement('div');
    d.className = 'msg msg-system';
    d.innerHTML = `<div class="msg-text">· ${esc(text)}</div>`;
    m.appendChild(d);
    m.scrollTop = m.scrollHeight;
  });
}

function sendChat() {
  const inp = document.getElementById('chatInput');
  const txt = inp.value.trim();
  if (!txt || !ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'chat', name: myName, text: txt }));
  inp.value = '';
}
