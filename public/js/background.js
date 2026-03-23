function spawnPetals(){
  function c(){ const p=document.createElement('div'); p.className='petal'; const isDark=document.documentElement.getAttribute('data-theme')==='dark'; const hue=isDark?(310+Math.random()*35):(335+Math.random()*25); const sat=isDark?(55+Math.random()*30):(50+Math.random()*25); const light=isDark?(60+Math.random()*25):(78+Math.random()*14); const alpha=isDark?(0.2+Math.random()*0.45):(0.3+Math.random()*0.5); p.style.cssText=`left:${Math.random()*100}vw;animation-duration:${5+Math.random()*8}s;animation-delay:${Math.random()*4}s;width:${5+Math.random()*7}px;height:${6+Math.random()*8}px;transform:rotate(${Math.random()*360}deg);background:hsla(${hue},${sat}%,${light}%,${alpha})`; document.body.appendChild(p); setTimeout(()=>p.remove(),15000); }
  setInterval(c,600);
}



(function(){
  const mainCanvas=document.getElementById('bgCanvas');
  const mainCtx=mainCanvas.getContext('2d');
  let W,H,t=0;
  const branches=[];
  function makeBranch(x,y,angle,len,depth){ if(depth<=0||len<6) return; const ex=x+Math.cos(angle)*len,ey=y+Math.sin(angle)*len; branches.push({x1:x,y1:y,x2:ex,y2:ey,depth,len,phase:Math.random()*Math.PI*2}); const spread=0.35+depth*0.04; makeBranch(ex,ey,angle-spread*(0.7+Math.random()*0.3),len*0.68,depth-1); makeBranch(ex,ey,angle+spread*(0.7+Math.random()*0.3),len*0.65,depth-1); if(depth>3&&Math.random()>.5) makeBranch(ex,ey,angle+(Math.random()-.5)*0.5,len*0.5,depth-2); }
  const blossoms=[];
  function seedBlossoms(){ blossoms.length=0; branches.forEach(b=>{ if(b.len<28){ const count=Math.floor(2+Math.random()*5); for(let k=0;k<count;k++){ const scatter=b.len*0.8; const rnd=Math.random(); const r=rnd<0.6?(3+Math.random()*3):(6+Math.random()*5); blossoms.push({x:b.x2+(Math.random()-.5)*scatter,y:b.y2+(Math.random()-.5)*scatter,r,phase:Math.random()*Math.PI*2,speed:0.3+Math.random()*0.5,pink:Math.random()>.3}); } } }); }
  function buildTree(){ branches.length=0; makeBranch(W*0.08,H*1.05,-Math.PI/2+0.18,H*0.32,9); seedBlossoms(); }
  function drawLight(ctx){
    ctx.fillStyle='#f5ede6';ctx.fillRect(0,0,W,H);
    const mists=[{x:.5,y:.35,rx:.9,c:'rgba(255,245,248,0.55)',speed:.6},{x:.15,y:.6,rx:.55,c:'rgba(240,235,248,0.45)',speed:.4},{x:.82,y:.2,rx:.5,c:'rgba(255,240,245,0.5)',speed:.5}];
    mists.forEach((m,i)=>{ const mx=m.x*W+Math.sin(t*m.speed*0.4+i)*W*0.025,my=m.y*H+Math.cos(t*m.speed*0.3+i*0.7)*H*0.02; ctx.save();ctx.translate(mx,my);ctx.scale(1,0.45); const g=ctx.createRadialGradient(0,0,0,0,0,m.rx*Math.min(W,H)); g.addColorStop(0,m.c);g.addColorStop(1,'transparent'); ctx.fillStyle=g;ctx.beginPath();ctx.arc(0,0,m.rx*Math.min(W,H),0,Math.PI*2);ctx.fill();ctx.restore(); });
    branches.forEach(b=>{ const sway=Math.sin(t*0.5+b.phase)*0.8; ctx.save();ctx.translate(b.x1,b.y1);ctx.rotate(sway*(1/(b.depth+1))*0.015); ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(b.x2-b.x1,b.y2-b.y1); ctx.lineWidth=Math.max(0.5,b.depth*0.55); ctx.strokeStyle=`rgba(80,50,40,${Math.min(0.18+b.depth*0.04,0.55)})`; ctx.stroke();ctx.restore(); });
    blossoms.forEach(bl=>{ const r=bl.r*(0.9+Math.sin(t*bl.speed+bl.phase)*0.08); const sway=Math.sin(t*0.35+bl.phase)*2; const cx=bl.x+sway, cy=bl.y; const g=ctx.createRadialGradient(cx,cy,0,cx,cy,r); if(bl.pink){ g.addColorStop(0,'hsla(338,65%,72%,0.9)'); g.addColorStop(0.45,'hsla(338,55%,76%,0.7)'); g.addColorStop(0.8,'hsla(335,45%,82%,0.3)'); g.addColorStop(1,'transparent'); } else { g.addColorStop(0,'hsla(330,30%,88%,0.85)'); g.addColorStop(0.5,'hsla(330,25%,90%,0.5)'); g.addColorStop(1,'transparent'); } ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fillStyle=g;ctx.fill(); });
  }
  function drawDark(ctx){ ctx.fillStyle='#000';ctx.fillRect(0,0,W,H); const glow=ctx.createRadialGradient(W*.5,H,0,W*.5,H,H*.6); glow.addColorStop(0,'rgba(232,48,106,0.07)');glow.addColorStop(1,'transparent'); ctx.fillStyle=glow;ctx.fillRect(0,0,W,H); for(let i=0;i<30;i++){ const sx=((Math.sin(i*137.5)*.5+.5)*W+Math.sin(t*.25+i)*30)%W; const sy=((Math.cos(i*137.5)*.5+.5)*H+Math.cos(t*.3+i)*20)%H; const sa=0.15+Math.abs(Math.sin(t*.7+i*.6))*.35; ctx.fillStyle=i%3===0?`rgba(232,48,106,${sa})`:`rgba(255,255,255,${sa*.6})`; ctx.beginPath();ctx.arc(sx,sy,0.4+Math.abs(Math.sin(t*1.2+i))*1.0,0,Math.PI*2);ctx.fill(); } }
  function resize(){ W=window.innerWidth;H=window.innerHeight; mainCanvas.width=W;mainCanvas.height=H; const inner=document.getElementById('bgCanvasInner'); if(inner){inner.width=W;inner.height=H;} buildTree(); }
  function draw(){
    t+=0.006;
    const isDark=document.documentElement.getAttribute('data-theme')==='dark';
    mainCtx.clearRect(0,0,W,H);
    if(isDark) drawDark(mainCtx); else drawLight(mainCtx);
    const inner=document.getElementById('bgCanvasInner');
    if(inner){
      const appOpen=document.getElementById('app').style.display==='flex';
      if(appOpen){ inner.style.opacity='0'; inner.getContext('2d').clearRect(0,0,W,H); requestAnimationFrame(draw); return; }
      const hasVideo=document.getElementById('videoArea')?.classList.contains('has-video');
      if(!isDark&&!hasVideo){
        inner.style.opacity='1';
        const ictx=inner.getContext('2d');
        ictx.clearRect(0,0,W,H);
        ictx.drawImage(mainCanvas,0,0);
      } else {
        inner.style.opacity='0';
        inner.getContext('2d').clearRect(0,0,W,H);
      }
    }
    requestAnimationFrame(draw);
  }
  window.addEventListener('resize',resize);
  resize();draw();
})();
