let ws, roomId, myName, myClientId, isHost=false, isSyncing=false;
let _networkLatency=0;
let _intentionalDisconnect=false;

function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function ft(s){ s=Math.floor(s||0); return `${Math.floor(s/60)}:${(s%60).toString().padStart(2,'0')}`; }
function rid(n=6){ return Math.random().toString(36).substr(2,n).toUpperCase(); }
