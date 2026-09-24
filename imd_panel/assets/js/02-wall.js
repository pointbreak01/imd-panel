// ================================================================ the wall: one module per task, drawn from its id
// Same idiom as imd.fun's front page: a grey wall of instrument modules on a cell grid, a monitor block with the
// live feed, modules lit by what happened to the task (accepted / rejected / pending / working now), the working
// ones moving, a few idle ones drifting every 15 s, a press flash on click. Everything is seeded by the task id,
// so a module looks the same on every visit.
const PAL={wall:"#7d7d79",face:"#d6d6d2",faceLit:"#e6ecdc",faceHot:"#f4f4f0",stroke:"#141414",screen:"#0a0a0a",glass:"#c9ecbf",phos:"#c9ecbf",phosDim:"#7fb37a",lamp:"#3ecf7a",bad:"#ff6b62",amber:"#ffcf5a",dimFace:"#c4c4bf"};
const TAU=Math.PI*2;
const hash32=s=>{let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}return h>>>0};
const rng=seed=>{let e=(Math.imul(2654435761,seed)+12345)>>>0;return()=>{let t=Math.imul((e+=1831565813)^e>>>15,1|e);t^=t+Math.imul(t^t>>>7,61|t);return((t^t>>>14)>>>0)/4294967296}};
const W={canvas:null,ctx:null,cell:40,cols:0,rows:0,width:0,height:0,units:[],grid:[],monitor:null,hot:null,warm:new Map(),flash:new Map(),lastDrift:0,raf:0,frameN:0,dirty:true,still:false,tip:null};

function wallInit(){
  W.canvas=$("#wall");if(!W.canvas)return;W.ctx=W.canvas.getContext("2d");W.tip=$("#wtip");
  W.still=matchMedia("(prefers-reduced-motion: reduce)").matches;
  new ResizeObserver(()=>{wallLayout();W.dirty=true}).observe(W.canvas.parentElement);
  W.canvas.addEventListener("mousemove",wallMove);W.canvas.addEventListener("mouseleave",()=>{W.hot=null;W.tip.classList.remove("on");W.canvas.style.cursor="";W.dirty=true});
  W.canvas.addEventListener("click",wallClick);
  if(!W.still)W.raf=requestAnimationFrame(wallFrame);
}
// units: working tasks first, then newest first; a working or expensive task takes a 2x2 console
function wallUnits(){
  const run=new Map((D.running||[]).map(t=>[t.id,t]));
  const T=inRange().filter(t=>t.status!=="no-journal");
  const seen=new Set();const out=[];
  for(const r of run.values()){seen.add(r.id);out.push(mkUnit(r,true))}
  T.sort((a,b)=>b.acceptedAt-a.acceptedAt).forEach(t=>{if(seen.has(t.id))return;seen.add(t.id);out.push(mkUnit(t,false))});
  return out;
}
function mkUnit(t,working){
  const seed=hash32(t.id);const r=rng(seed);
  const big=working||(t.costUSD||0)>=1.2;
  const state=working?"work":t.verdict==="accepted"?"ok":isBad(t.verdict)?"bad":(t.status==="rate-limited"||isClosed(t.verdict))?"none":"pend";
  return{id:t.id,task:t,working,w:big?2:1,h:big?2:1,seed,kind:big?Math.floor(r()*8):Math.floor(r()*16),phase:r()*TAU,r:0,c:0,state,filler:false};
}
function wallLayout(){
  if(!W.canvas||!D)return;
  const el=W.canvas.parentElement;const width=el.clientWidth;if(!width)return;
  const cols=Math.max(8,Math.round(width/40));const cell=width/cols;
  let units=wallUnits();
  const mw=Math.min(cols-2,Math.max(7,Math.round(cols*.36))),mh=4;
  // on a phone the wall would run for screens: keep the working modules and the newest tasks that fit in ~40% of the viewport
  let omitted=0;if(width<720){const budgetRows=Math.max(7,Math.min(11,Math.floor((innerHeight||700)*.42/cell)));let left=budgetRows*cols-mw*mh;const keep=[];for(const u of units){const a=u.w*u.h;if(u.working||a<=left){keep.push(u);left-=a}else omitted++}units=keep}
  W.omitted=omitted;const om=document.getElementById("wallOmit");if(om)om.textContent=omitted?`${omitted} older task${omitted===1?"":"s"} not on the wall (small screen) — they are all in the Tasks tab.`:"";
  const area=units.reduce((a,u)=>a+u.w*u.h,0)+mw*mh;
  let rows=Math.max(7,Math.ceil(area/cols)+1);
  const grid=[];const free=(c,r,w,h)=>{if(c+w>cols)return false;for(let y=r;y<r+h;y++)for(let x=c;x<c+w;x++)if(grid[y]&&grid[y][x])return false;return true};
  const take=(u,c,r)=>{u.c=c;u.r=r;for(let y=r;y<r+u.h;y++){grid[y]=grid[y]||[];for(let x=c;x<c+u.w;x++)grid[y][x]=u}};
  W.monitor={c:0,r:0,w:mw,h:mh};take(W.monitor,0,0);W.monitor.mon=true;
  for(const u of units){let placed=false;for(let r=0;!placed;r++){for(let c=0;c<cols;c++){if(free(c,r,u.w,u.h)){take(u,c,r);placed=true;break}}if(r>400)break}}
  rows=Math.max(rows,grid.length);
  // the rest of the wall: seats nobody sat in, drawn plain
  const fill=[];for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){if(grid[r]&&grid[r][c])continue;const seed=hash32(`seat-${c}-${r}`);const g=rng(seed);const u={id:`seat-${c}-${r}`,task:null,working:false,w:1,h:1,seed,kind:Math.floor(g()*16),phase:g()*TAU,c,r,state:"none",filler:true};take(u,c,r);fill.push(u)}
  W.units=units.concat(fill);W.grid=grid;W.cols=cols;W.rows=rows;W.cell=cell;W.width=width;W.height=rows*cell;
  const dpr=Math.min(2,devicePixelRatio||1);W.canvas.width=Math.round(width*dpr);W.canvas.height=Math.round(W.height*dpr);W.canvas.style.height=W.height+"px";
  W.ctx.setTransform(dpr,0,0,dpr,0,0);W.ctx.lineJoin="round";W.dirty=true;
  if(W.still)wallDraw(performance.now());
}
function wallFrame(t){
  W.frameN++;
  if(W.frameN%2){W.raf=requestAnimationFrame(wallFrame);return}
  if(t-W.lastDrift>15000)wallDrift(t);
  for(const[k,v]of W.warm)if(t>v){W.warm.delete(k);W.dirty=true}
  for(const[k,v]of W.flash)if(t>v){W.flash.delete(k);W.dirty=true}
  const live=W.units.some(u=>u.working)||W.warm.size||W.flash.size||W.hot;
  if(W.dirty||live)wallDraw(t);
  W.raf=requestAnimationFrame(wallFrame);
}
function wallDrift(t){
  W.lastDrift=t;const idle=W.units.filter(u=>!u.working);const n=Math.max(1,Math.round(idle.length*.06));
  for(let i=0;i<n&&idle.length;i++){const u=idle[Math.floor(Math.random()*idle.length)];u.phase=Math.random()*TAU;W.warm.set(u.id,t+1400+Math.random()*900)}
  W.dirty=true;
}
function wallDraw(t){
  const{ctx,cell}=W;if(!ctx||!W.cols)return;W.dirty=false;
  ctx.fillStyle=PAL.wall;ctx.fillRect(0,0,W.width,W.height);
  for(const u of W.units)drawUnit(u,t);
  drawMonitor(t);
}
function drawUnit(u,t){
  const{ctx,cell}=W;const x=u.c*cell+1,y=u.r*cell+1,w=u.w*cell-2,h=u.h*cell-2;
  const hot=W.hot===u,warm=W.warm.has(u.id),anim=u.working||warm;
  ctx.fillStyle=u.working?PAL.faceHot:u.state==="ok"?PAL.faceLit:u.filler?PAL.dimFace:PAL.face;
  ctx.fillRect(x,y,w,h);
  ctx.strokeStyle=PAL.stroke;ctx.lineWidth=1;ctx.globalAlpha=u.filler?.55:.9;ctx.strokeRect(x+.5,y+.5,w-1,h-1);ctx.globalAlpha=1;
  if(u.w>1){ctx.lineWidth=1.5;ctx.strokeRect(x+.75,y+.75,w-1.5,h-1.5);ctx.lineWidth=1;screws(x,y,w,h)}
  const P={x,y,w,h,cx:x+w/2,cy:y+h/2,m:Math.min(w,h),g:rng(u.seed+7),ph:u.phase,anim,t};
  if(u.w>1)bigModule(u.kind,P,u);else smallModule(u.kind,P);
  // lamp: what happened to the task
  if(!u.filler){const lr=Math.max(1.6,cell*.06),lx=x+w-lr*2.4,ly=y+lr*2.4;ctx.beginPath();ctx.arc(lx,ly,lr,0,TAU);
    if(u.working){ctx.fillStyle=PAL.lamp;ctx.globalAlpha=.55+.45*Math.sin(t/300);ctx.fill();ctx.globalAlpha=1}
    else if(u.state==="ok"){ctx.fillStyle=PAL.lamp;ctx.fill()}else if(u.state==="bad"){ctx.fillStyle=PAL.bad;ctx.fill()}
    else{ctx.strokeStyle=u.state==="pend"?"#8a6a10":PAL.stroke;ctx.lineWidth=1;ctx.stroke()}}
  if(u.working){ctx.strokeStyle=PAL.lamp;ctx.lineWidth=2;ctx.strokeRect(x+1.5,y+1.5,w-3,h-3);ctx.lineWidth=1}
  else if(u.state==="bad"){ctx.strokeStyle=PAL.bad;ctx.lineWidth=1.5;ctx.globalAlpha=.8;ctx.strokeRect(x+1.5,y+1.5,w-3,h-3);ctx.globalAlpha=1;ctx.lineWidth=1}
  if(hot&&!u.filler){ctx.fillStyle="#fff";ctx.globalAlpha=.18;ctx.fillRect(x,y,w,h);ctx.globalAlpha=1}
  const f=W.flash.get(u.id);if(f){ctx.fillStyle="#fff";ctx.globalAlpha=Math.min(.5,(f-t)/90*.5);ctx.fillRect(x,y,w,h);ctx.globalAlpha=1}
}
function screws(x,y,w,h){const{ctx}=W;const e=Math.max(1.2,W.cell*.05),o=e*2.2;ctx.strokeStyle=PAL.stroke;ctx.globalAlpha=.55;ctx.lineWidth=1;
  for(const[cx,cy]of[[x+o,y+o],[x+w-o,y+o],[x+o,y+h-o],[x+w-o,y+h-o]]){ctx.beginPath();ctx.arc(cx,cy,e,0,TAU);ctx.stroke();ctx.beginPath();ctx.moveTo(cx-.7*e,cy+.3*e);ctx.lineTo(cx+.7*e,cy-.3*e);ctx.stroke()}ctx.globalAlpha=1}
// ---- 16 small modules (1x1): dial, clock, trace, quad squares, nine dots, disc, ring, diamond, cross, half cell, toggle, lamp, square lamp, filled square, hollow square, square clock
function smallModule(k,P){
  const{ctx}=W;const{cx,cy,m,g,ph,anim,t}=P;const u=m/20,lw=Math.max(1,Math.min(2,Math.round(m/22*2)/2));
  ctx.lineWidth=lw;ctx.strokeStyle=PAL.stroke;ctx.fillStyle=PAL.stroke;ctx.lineCap="round";
  const tm=anim?t:0;
  if(k===0){ctx.beginPath();ctx.arc(cx,cy,.46*m,0,TAU);ctx.stroke();const a=ph+(anim?.8*Math.sin(t/500):0);ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(cx+Math.cos(a)*m*.34,cy+Math.sin(a)*m*.34);ctx.stroke();ctx.beginPath();ctx.arc(cx,cy,1.2*u,0,TAU);ctx.fill()}
  else if(k===1||k===15){const sq=k===15;const step=m<16?3:1;for(let i=0;i<12;i+=step){const a=i*Math.PI/6,ca=Math.cos(a),sa=Math.sin(a);let r0,r1;if(sq){r1=.44*m/Math.max(Math.abs(ca),Math.abs(sa));r0=r1*(i%3?.85:.72)}else{r0=m*(i%3?.4:.34);r1=.46*m}ctx.beginPath();ctx.moveTo(cx+ca*r0,cy+sa*r0);ctx.lineTo(cx+ca*r1,cy+sa*r1);ctx.stroke()}
    const h1=ph+(anim?t/6000:0),h2=ph*1.7+(anim?t/500:0);ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(cx+Math.cos(h1)*m*.2,cy+Math.sin(h1)*m*.2);ctx.moveTo(cx,cy);ctx.lineTo(cx+Math.cos(h2)*m*.32,cy+Math.sin(h2)*m*.32);ctx.stroke()}
  else if(k===2){const p=Math.max(2,Math.round(2.5*u)),x=P.x+p,y=P.y+p,w=P.w-2*p,h=P.h-2*p;ctx.fillStyle=PAL.screen;ctx.fillRect(x,y,w,h);
    ctx.save();ctx.beginPath();ctx.rect(x+1,y+1,w-2,h-2);ctx.clip();ctx.strokeStyle=PAL.glass;ctx.beginPath();const mg=Math.max(2,.14*w),mid=y+h/2;
    for(let i=0;i<=8;i++){const px=x+mg+(w-2*mg)*i/8,py=mid+(anim?Math.sin(1.1*i+t/260+ph):Math.sin(1.1*i+ph)*.6)*h*.22;i?ctx.lineTo(px,py):ctx.moveTo(px,py)}ctx.stroke();ctx.restore()}
  else if(k===3){const s=.36*m,e=.08*m,on=anim?Math.floor(t/400)%4:Math.floor(ph/TAU*4);for(let i=0;i<4;i++){const x=cx-s-e/2+(i%2)*(s+e),y=cy-s-e/2+Math.floor(i/2)*(s+e);ctx.strokeRect(x+.5,y+.5,s-1,s-1);if(i===on||g()<.25)ctx.fillRect(x+1,y+1,s-2,s-2)}}
  else if(k===4){const s=.28*m,r=Math.max(1,1.6*u);for(let yy=-1;yy<=1;yy++)for(let xx=-1;xx<=1;xx++){ctx.beginPath();ctx.arc(cx+xx*s,cy+yy*s,r,0,TAU);((xx+yy+3+(anim?Math.floor(t/350):Math.floor(ph)))%3===0)?ctx.fill():ctx.stroke()}}
  else if(k===5){ctx.beginPath();ctx.arc(cx,cy,.36*m,0,TAU);ctx.fill();ctx.strokeStyle=PAL.face;ctx.beginPath();ctx.arc(cx,cy,.16*m,0,TAU);ctx.stroke()}
  else if(k===6){ctx.lineWidth=Math.max(2,.12*m);ctx.beginPath();ctx.arc(cx,cy,.3*m,0,TAU);ctx.stroke()}
  else if(k===7){const s=.3*m;ctx.beginPath();ctx.moveTo(cx,cy-s);ctx.lineTo(cx+s,cy);ctx.lineTo(cx,cy+s);ctx.lineTo(cx-s,cy);ctx.closePath();ctx.stroke()}
  else if(k===8){const s=.3*m;ctx.lineWidth=Math.max(2,.16*m);ctx.lineCap="butt";ctx.beginPath();ctx.moveTo(cx-s,cy);ctx.lineTo(cx+s,cy);ctx.moveTo(cx,cy-s);ctx.lineTo(cx,cy+s);ctx.stroke()}
  else if(k===9){const top=anim?Math.floor(t/900)%2===0:ph<Math.PI;ctx.fillRect(P.x+1,top?P.y+1:cy,P.w-2,P.h/2-1)}
  else if(k===10){const w=.34*m,h=.62*m;const up=(ph<Math.PI)!==(anim&&Math.floor(t/700)%2===0);ctx.strokeRect(cx-w/2+.5,cy-h/2+.5,w-1,h-1);ctx.fillRect(cx-w/2+1,up?cy-h/2+1:cy,w-2,h/2-1)}
  else if(k===11){const on=anim?Math.floor(t/500+P.x)%3===0:ph<2;ctx.beginPath();ctx.arc(cx,cy,.14*m,0,TAU);on?ctx.fill():ctx.stroke()}
  else if(k===12){const on=anim?Math.floor(t/500+P.x)%3===0:ph<2,e=.14*m;on?ctx.fillRect(Math.round(cx-e),Math.round(cy-e),Math.round(2*e),Math.round(2*e)):ctx.strokeRect(Math.round(cx-e)+.5,Math.round(cy-e)+.5,Math.round(2*e)-1,Math.round(2*e)-1)}
  else if(k===13){const s=.36*m;ctx.fillRect(Math.round(cx-s),Math.round(cy-s),Math.round(2*s),Math.round(2*s));ctx.strokeStyle=PAL.face;const e=.16*m;ctx.strokeRect(Math.round(cx-e)+.5,Math.round(cy-e)+.5,Math.round(2*e)-1,Math.round(2*e)-1)}
  else{const s=.3*m;ctx.lineWidth=Math.max(2,.12*m);ctx.strokeRect(Math.round(cx-s)+.5,Math.round(cy-s)+.5,Math.round(2*s)-1,Math.round(2*s)-1)}
  ctx.lineCap="butt";ctx.lineWidth=1;
}
// ---- 8 big modules (2x2): knobs, VU meter, radar, seven-segment readout, tape reels, sliders, LED column, scope
function bigModule(k,P,u){
  const{ctx}=W;const{x,y,w,h,cx,cy,m,g,ph,anim,t}=P;const pad=Math.max(4,m*.09);
  ctx.strokeStyle=PAL.stroke;ctx.fillStyle=PAL.stroke;ctx.lineWidth=1.2;ctx.lineCap="round";
  if(k===0){const r=m*.16,dx=m*.26;for(let i=0;i<4;i++){const kx=cx+(i%2?dx:-dx),ky=cy+(i<2?-dx:dx);ctx.beginPath();ctx.arc(kx,ky,r,0,TAU);ctx.fillStyle=PAL.face;ctx.fill();ctx.stroke();
    for(let j=0;j<8;j++){const a=j*TAU/8;ctx.beginPath();ctx.moveTo(kx+Math.cos(a)*r*1.18,ky+Math.sin(a)*r*1.18);ctx.lineTo(kx+Math.cos(a)*r*1.32,ky+Math.sin(a)*r*1.32);ctx.stroke()}
    const a=ph*(i+1)+(anim?Math.sin(t/700+i)*.6:0);ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(kx,ky);ctx.lineTo(kx+Math.cos(a)*r*.8,ky+Math.sin(a)*r*.8);ctx.stroke();ctx.lineWidth=1.2}ctx.fillStyle=PAL.stroke}
  else if(k===1){const fx=x+pad,fy=y+pad,fw=w-2*pad,fh=h*.62-pad;ctx.fillStyle="#f3f0e4";ctx.fillRect(fx,fy,fw,fh);ctx.strokeRect(fx+.5,fy+.5,fw-1,fh-1);
    const px=cx,py=fy+fh*.95,R=fh*.85;for(let i=0;i<=10;i++){const a=Math.PI*(1-i/10)*.75+Math.PI*.125;const r0=R*(i%5?.9:.84);ctx.strokeStyle=i>=8?PAL.bad:PAL.stroke;ctx.beginPath();ctx.moveTo(px+Math.cos(a)*r0,py-Math.sin(a)*r0);ctx.lineTo(px+Math.cos(a)*R,py-Math.sin(a)*R);ctx.stroke()}
    const lvl=anim?.5+.4*Math.sin(t/230+ph)*Math.sin(t/1700):(u.task?Math.min(1,(u.task.costUSD||0)/2):g());const a=Math.PI*(1-lvl)*.75+Math.PI*.125;ctx.strokeStyle="#b3261e";ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(px,py);ctx.lineTo(px+Math.cos(a)*R*.95,py-Math.sin(a)*R*.95);ctx.stroke();ctx.fillStyle=PAL.stroke;ctx.beginPath();ctx.arc(px,py,2.5,0,TAU);ctx.fill();
    ctx.font=`${Math.max(7,m*.09)}px ${MONO}`;ctx.textAlign="center";ctx.fillText("VU",cx,fy+fh*.55);const kr=m*.08;for(let i=0;i<3;i++){const kx=x+w*(.25+.25*i),ky=y+h*.8;ctx.beginPath();ctx.arc(kx,ky,kr,0,TAU);ctx.stroke();const a=ph*(i+2);ctx.beginPath();ctx.moveTo(kx,ky);ctx.lineTo(kx+Math.cos(a)*kr*.8,ky+Math.sin(a)*kr*.8);ctx.stroke()}}
  else if(k===2){const r=m*.4;ctx.fillStyle=PAL.screen;ctx.beginPath();ctx.arc(cx,cy,r,0,TAU);ctx.fill();ctx.strokeStyle=PAL.glass;ctx.globalAlpha=.35;for(let i=1;i<=3;i++){ctx.beginPath();ctx.arc(cx,cy,r*i/3,0,TAU);ctx.stroke()}ctx.beginPath();ctx.moveTo(cx-r,cy);ctx.lineTo(cx+r,cy);ctx.moveTo(cx,cy-r);ctx.lineTo(cx,cy+r);ctx.stroke();ctx.globalAlpha=1;
    const a=anim?t/900:ph;const grd=ctx.createConicGradient?ctx.createConicGradient(a-1.2,cx,cy):null;if(grd){grd.addColorStop(0,"rgba(62,207,122,0)");grd.addColorStop(.19,"rgba(62,207,122,.55)");grd.addColorStop(.191,"rgba(62,207,122,0)");grd.addColorStop(1,"rgba(62,207,122,0)");ctx.fillStyle=grd;ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,r,0,TAU);ctx.fill()}
    ctx.strokeStyle=PAL.lamp;ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(cx+Math.cos(a)*r,cy+Math.sin(a)*r);ctx.stroke();const gg=rng(u.seed+3);for(let i=0;i<3;i++){const ba=gg()*TAU,br=gg()*r*.85;ctx.fillStyle=PAL.lamp;ctx.globalAlpha=.5+.5*((Math.cos(ba-a)+1)/2);ctx.beginPath();ctx.arc(cx+Math.cos(ba)*br,cy+Math.sin(ba)*br,1.8,0,TAU);ctx.fill()}ctx.globalAlpha=1;ctx.fillStyle=PAL.stroke}
  else if(k===3){const sx=x+pad,sy=y+pad*1.4,sw=w-2*pad,sh=h*.42;ctx.fillStyle=PAL.screen;ctx.fillRect(sx,sy,sw,sh);const task=u.task;const val=task?(anim?Math.round((t/50+ph*100)%10000):(task.turns||0)):Math.round(ph*1000);
    sevenSeg(String(val).padStart(4,"0").slice(-4),sx+sw*.1,sy+sh*.18,sw*.8,sh*.64,u.working?PAL.lamp:PAL.bad);
    ctx.fillStyle=PAL.stroke;ctx.font=`${Math.max(7,m*.085)}px ${MONO}`;ctx.textAlign="left";ctx.fillText(task?"TURNS":"COUNT",sx,y+h-pad*1.2);const br=m*.05;for(let i=0;i<4;i++){ctx.beginPath();ctx.arc(x+w-pad-i*br*3.2,y+h-pad*1.6,br,0,TAU);(i===0&&anim)||(g()<.4)?ctx.fill():ctx.stroke()}}
  else if(k===4){const r=m*.2,dx=m*.24;ctx.fillStyle=PAL.screen;for(const s of[-1,1]){const rx=cx+s*dx,ry=cy-m*.06;ctx.beginPath();ctx.arc(rx,ry,r,0,TAU);ctx.fillStyle="#2a2a28";ctx.fill();ctx.strokeStyle=PAL.stroke;ctx.stroke();
    const a=(anim?t/700:0)*s+ph;ctx.strokeStyle=PAL.face;ctx.lineWidth=1.2;for(let i=0;i<3;i++){const aa=a+i*TAU/3;ctx.beginPath();ctx.moveTo(rx+Math.cos(aa)*r*.3,ry+Math.sin(aa)*r*.3);ctx.lineTo(rx+Math.cos(aa)*r*.85,ry+Math.sin(aa)*r*.85);ctx.stroke()}ctx.beginPath();ctx.arc(rx,ry,r*.22,0,TAU);ctx.fillStyle=PAL.face;ctx.fill()}
    ctx.strokeStyle=PAL.stroke;ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(cx-dx,cy-m*.06+r);ctx.quadraticCurveTo(cx,cy+m*.22,cx+dx,cy-m*.06+r);ctx.stroke();for(let i=0;i<3;i++){const bx=x+w*(.3+.2*i),by=y+h*.86;ctx.strokeRect(bx-m*.05,by-m*.04,m*.1,m*.08)}ctx.fillStyle=PAL.stroke}
  else if(k===5){const n=5,gap=(w-2*pad)/n;for(let i=0;i<n;i++){const sx=x+pad+gap*(i+.5),top=y+pad,bot=y+h-pad;ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(sx,top);ctx.lineTo(sx,bot);ctx.stroke();for(let j=0;j<=6;j++){const ty=top+(bot-top)*j/6;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(sx-3,ty);ctx.lineTo(sx+3,ty);ctx.stroke()}
    const lv=anim?(Math.sin(t/900+i+ph)+1)/2:g();const ky=top+(bot-top)*lv;ctx.fillStyle=PAL.stroke;ctx.fillRect(sx-gap*.28,ky-m*.045,gap*.56,m*.09);ctx.fillStyle="#fff";ctx.fillRect(sx-gap*.28,ky-.75,gap*.56,1.5);ctx.fillStyle=PAL.stroke}}
  else if(k===6){const n=4,gap=(w-2*pad)/n,rows=8;for(let i=0;i<n;i++){const lv=anim?Math.round(rows*((Math.sin(t/300+i*1.3+ph)+1)/2)):Math.round(rows*g());for(let j=0;j<rows;j++){const bx=x+pad+gap*i+gap*.2,by=y+h-pad-(j+1)*((h-2*pad)/rows)+2,bw=gap*.6,bh=(h-2*pad)/rows-4;const on=j<lv;ctx.fillStyle=on?(j>=rows-2?PAL.bad:j>=rows-4?PAL.amber:PAL.lamp):"#b9b9b4";ctx.fillRect(bx,by,bw,bh)}}ctx.fillStyle=PAL.stroke}
  else{const sx=x+pad,sy=y+pad,sw=w-2*pad,sh=h-2*pad;ctx.fillStyle=PAL.screen;ctx.fillRect(sx,sy,sw,sh);ctx.save();ctx.beginPath();ctx.rect(sx+1,sy+1,sw-2,sh-2);ctx.clip();ctx.strokeStyle=PAL.glass;ctx.globalAlpha=.25;ctx.lineWidth=1;for(let i=1;i<4;i++){ctx.beginPath();ctx.moveTo(sx,sy+sh*i/4);ctx.lineTo(sx+sw,sy+sh*i/4);ctx.moveTo(sx+sw*i/4,sy);ctx.lineTo(sx+sw*i/4,sy+sh);ctx.stroke()}ctx.globalAlpha=1;
    ctx.strokeStyle=PAL.lamp;ctx.lineWidth=1.5;ctx.shadowColor=PAL.lamp;ctx.shadowBlur=4;ctx.beginPath();const N=40;for(let i=0;i<=N;i++){const px=sx+sw*i/N,py=sy+sh/2+Math.sin(i/N*TAU*2+(anim?t/250:0)+ph)*sh*.3*Math.sin(i/N*Math.PI);i?ctx.lineTo(px,py):ctx.moveTo(px,py)}ctx.stroke();ctx.shadowBlur=0;ctx.restore();ctx.fillStyle=PAL.stroke}
  ctx.lineCap="butt";ctx.lineWidth=1;ctx.textAlign="left";
}
const SEG=["1111110","0110000","1101101","1111001","0110011","1011011","1011111","1110000","1111111","1111011"];
function sevenSeg(str,x,y,w,h,col){const{ctx}=W;const dw=w/str.length,t=Math.max(1,h*.12);for(let i=0;i<str.length;i++){const s=SEG[+str[i]]||"0000000",gx=x+dw*i+dw*.1,gw=dw*.7;
  [[gx,y,gw,t],[gx+gw-t,y,t,h/2],[gx+gw-t,y+h/2,t,h/2],[gx,y+h-t,gw,t],[gx,y+h/2,t,h/2],[gx,y,t,h/2],[gx,y+h/2-t/2,gw,t]].forEach((r,j)=>{ctx.fillStyle=col;ctx.globalAlpha=s[j]==="1"?1:.1;ctx.fillRect(r[0],r[1],r[2],r[3])})}ctx.globalAlpha=1}
const MONO='"IBM Plex Mono",ui-monospace,Menlo,monospace';
// ---- the monitor block: the live feed on phosphor
function drawMonitor(t){
  const{ctx,cell}=W,b=W.monitor;if(!b)return;const x=b.c*cell+1,y=b.r*cell+1,w=b.w*cell-2,h=b.h*cell-2;
  ctx.fillStyle=PAL.face;ctx.fillRect(x,y,w,h);ctx.strokeStyle=PAL.stroke;ctx.lineWidth=1.5;ctx.strokeRect(x+.75,y+.75,w-1.5,h-1.5);ctx.lineWidth=1;screws(x,y,w,h);
  const p=Math.max(6,cell*.22);const sx=x+p,sy=y+p,sw=w-2*p,sh=h-2*p;ctx.fillStyle=PAL.screen;ctx.fillRect(sx,sy,sw,sh);ctx.strokeStyle=PAL.glass;ctx.globalAlpha=.18;ctx.strokeRect(sx+1.5,sy+1.5,sw-3,sh-3);ctx.globalAlpha=1;
  const fs=Math.max(9,Math.min(12,cell*.29)),lh=fs*1.45;ctx.font=`${fs}px ${MONO}`;ctx.textBaseline="top";
  const R=D.running||[],la=D.lastAlive||{},age=la.ts?Date.now()/1000-la.ts:1e9;
  const lines=[];const push=(lead,who,what,col)=>lines.push({lead,who,what,col});
  push("⏺","node",`${D.hostName||"worker"} · ${age>300?"silent for "+dur(age):R.length?"working":"online, waiting"}${la.fleetOnline?` · fleet ${la.fleetOnline}/${la.fleetEnrolled}`:""}`,PAL.phosDim);
  R.forEach(r=>{push("⎿",r.id,`${r.kindLabel||r.kind||""} · ${r.tier||"?"} · ${r.model?mi(r.model).n:""} · ${dur(r.elapsedS)} · turn ${r.turns}${r.maxTurns?"/"+r.maxTurns:""} · ${usd(r.costUSD)}`,"#e8ffe9");if(r.lastText)push(" ","",("› "+r.lastText).replace(/\s+/g," "),PAL.phosDim)});
  if(!R.length)push("⎿","queue","no task in progress",PAL.phos);
  (D.events||[]).slice(-8).reverse().forEach(e=>push("⎿",hm(e.ts),e.msg,e.type==="rate-limit"?PAL.bad:e.type==="update"?"#e8ffe9":PAL.phos));
  ctx.save();ctx.beginPath();ctx.rect(sx+3,sy+3,sw-6,sh-6);ctx.clip();
  const c0=sx+fs*.7,c1=c0+fs*1.2,c2=c1+fs*5.6;const maxLines=Math.floor((sh-fs)/lh);
  lines.slice(0,maxLines).forEach((l,i)=>{const ly=sy+fs*.6+i*lh;ctx.fillStyle=l.col===PAL.bad?PAL.bad:PAL.phosDim;ctx.fillText(l.lead,c0,ly);ctx.fillText(l.who,c1,ly);ctx.fillStyle=l.col;
    let s=l.what;const maxW=sx+sw-c2-fs;while(s.length>2&&ctx.measureText(s).width>maxW)s=s.slice(0,-2);if(s!==l.what)s=s.slice(0,-1)+"…";ctx.fillText(s,c2,ly)});
  if(Math.floor(t/500)%2===0){const n=Math.min(lines.length,maxLines);ctx.fillStyle=PAL.lamp;ctx.fillRect(c0,sy+fs*.6+n*lh,fs*.6,fs)}
  ctx.restore();ctx.textBaseline="alphabetic";
}
// ---- pointer: tooltip on a task module, press + open on click
function unitAt(e){const r=W.canvas.getBoundingClientRect();const c=Math.floor((e.clientX-r.left)/W.cell),row=Math.floor((e.clientY-r.top)/W.cell);return(W.grid[row]||[])[c]||null}
function wallMove(e){const u=unitAt(e);const hot=u&&!u.mon&&!u.filler?u:null;if(hot!==W.hot){W.hot=hot;W.dirty=true}
  W.canvas.style.cursor=hot?"pointer":"";if(!hot){W.tip.classList.remove("on");return}
  const t=hot.task;const r=W.canvas.getBoundingClientRect();const st=hot.working?"working now":t.verdict==="accepted"?"accepted":t.verdict==="rejected"?"rejected":t.verdict==="failed"?"failed on the network":t.verdict==="noquorum"?"no quorum (panel never agreed)":t.verdict==="blocked"?"job blocked on the network":t.status==="rate-limited"?"released on rate limit":"pending";
  W.tip.innerHTML=`<div class="th"><b>${esc(t.id)}</b> <span>${st}</span></div><div>${esc(t.kindLabel||t.kind||"")} · ${t.model?mi(t.model).n+(t.effort?" · "+t.effort:""):"no model"} · ${t.tier||"?"} · ${usd(t.costUSD)} · ${t.turns||0} turns · ${dur(t.durationS||t.elapsedS||0)}</div>${t.title?`<div class="tt">${esc(t.title).slice(0,120)}</div>`:""}${t.reason&&t.reason.reason?`<div class="tb">${esc(t.reason.reason)}</div>`:t.explorer&&(t.explorer.answer||t.explorer.word)?`<div class="tt">${esc([t.explorer.answer?"answer "+t.explorer.answer:"",t.explorer.word].filter(Boolean).join(" · "))}</div>`:""}<div class="tk">click to open the transcript${t.jobPublished===false?" · job page not published yet":""}</div>`;
  W.tip.classList.add("on");const tw=W.tip.offsetWidth||260,th=W.tip.offsetHeight||80;
  const x=(hot.c+hot.w/2)*W.cell,y=hot.r*W.cell;const below=y<th+16;W.tip.style.left=Math.max(8+tw/2,Math.min(W.width-8-tw/2,x))+"px";W.tip.style.top=(below?(hot.r+hot.h)*W.cell+8:y-8)+"px";W.tip.classList.toggle("below",below);
}
function wallClick(e){const u=unitAt(e);if(!u||u.mon)return;const t=performance.now();W.flash.set(u.id,t+90);W.warm.set(u.id,t+4000);W.dirty=true;if(u.task)openTranscript(u.task.id)}

