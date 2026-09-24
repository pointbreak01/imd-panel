// ================================================================ pepe: the sprite from imd.fun's front page, lightly retouched
// 17 frames of 480 x 520 in one row. At load the shirt is recoloured from blue to charcoal (pixel pass on an
// offscreen canvas, shading kept), so he matches the black-and-white room; the poses and the animation script
// are the same idle / poke / walk-off behaviour as the front page.
const PEPE_FRAMES=["stand","walk1","walk2","lookup_mid","lookup","scratch1","scratch2","side_stand","side_walk1","side_walk2","side_walk3","side_walk4","q34_back","q34_front","front_stand","front_lookup","front_scratch"];
const PEPE_FW=480,PEPE_FH=520;let PEPE_SHEET=null;
function pepeSheet(){return new Promise(res=>{const img=new Image();img.onload=()=>{try{const c=document.createElement("canvas");c.width=img.width;c.height=img.height;const x=c.getContext("2d",{willReadFrequently:true});x.drawImage(img,0,0);
    const d=x.getImageData(0,0,c.width,c.height),p=d.data;
    for(let i=0;i<p.length;i+=4){const r=p[i],g=p[i+1],b=p[i+2];if(p[i+3]>0&&b>r+50&&b>g+30){const l=Math.min(1,(r*.3+g*.59+b*.11)/170);const v=Math.round(44+l*100);p[i]=v;p[i+1]=v;p[i+2]=v}}
    x.putImageData(d,0,0);res(c)}catch(e){res(img)}};img.onerror=()=>res(null);img.src="/assets/pepe.webp"})}
function drawPepe(ctx,pose,Wd){const H=Wd*PEPE_FH/PEPE_FW;ctx.clearRect(0,0,Wd,H);if(!PEPE_SHEET)return;const i=Math.max(0,PEPE_FRAMES.indexOf(pose));
  ctx.beginPath();ctx.ellipse(Wd/2,H*.985,Wd*.28,H*.035,0,0,TAU);ctx.fillStyle="rgba(0,0,0,.22)";ctx.fill();
  ctx.drawImage(PEPE_SHEET,i*PEPE_FW,0,PEPE_FW,PEPE_FH,0,0,Wd,H)}
function pepeStart(el){
  const cv=el;const dpr=Math.min(2,devicePixelRatio||1);let cw=0;
  const fit=()=>{const w=cv.clientWidth||60,h=w*PEPE_FH/PEPE_FW;if(w===cw)return;cw=w;cv.width=Math.round(w*dpr);cv.height=Math.round(h*dpr);cv.style.height=h+"px";cv.getContext("2d").setTransform(dpr,0,0,dpr,0,0)};
  new ResizeObserver(()=>{fit();face(cur)}).observe(cv);
  let cur="stand";const face=n=>{cur=n;fit();drawPepe(cv.getContext("2d"),n,cw)};
  // x/y in px, s = size, sy = vertical squash, r = degrees (pivot at the feet), f = 1 | -1 mirror
  const pos={x:0,y:0,s:1,sy:1,r:0,f:1};const place=()=>{cv.style.transform=`translate(${pos.x}px, ${pos.y}px) rotate(${pos.r}deg) scale(${pos.s*pos.f}, ${pos.s*pos.sy})`};
  pepeSheet().then(s=>{PEPE_SHEET=s;cw=0;face(cur)});
  face("stand");place();
  if(matchMedia("(prefers-reduced-motion: reduce)").matches)return;
  const H=()=>cv.offsetHeight||60,Wd=()=>cv.offsetWidth||50;
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const play=async seq=>{for(const[n,ms]of seq){face(n);await sleep(ms)}};
  const visible=()=>document.visibilityState==="visible";
  const waitVisible=async()=>{while(!visible())await sleep(1000)};
  const waitClick=ms=>new Promise(res=>{const c=new AbortController();const done=v=>{c.abort();res(v)};cv.addEventListener("click",()=>done(true),{once:true,signal:c.signal});setTimeout(()=>done(false),ms)});
  const ease={lin:k=>k,out:k=>1-(1-k)*(1-k),inq:k=>k*k,arc:k=>4*k*(1-k)};
  // tween some of pos to `to` over ms; frames cycle every fms; `end` frame at the finish; y may follow an arc
  const tw=(to,ms,o={})=>new Promise(res=>{const from={...pos};let last=-1,acc=0,t0=performance.now();const e=ease[o.ease||"lin"];const step=now=>{acc+=Math.min(100,now-t0);t0=now;const k=Math.min(1,acc/ms),ek=e(k);
    for(const key in to)pos[key]=from[key]+(to[key]-from[key])*ek;if(o.arc)pos.y=from.y+(to.y!=null?(to.y-from.y)*ek:0)-o.arc*ease.arc(k);
    if(o.frames){const f=Math.floor(acc/(o.fms||140));if(f!==last)face(o.frames[(last=f)%o.frames.length])}else if(o.frame&&last<0){last=0;face(o.frame)}
    place();k>=1?(o.end&&face(o.end),res()):requestAnimationFrame(step)};requestAnimationFrame(step)});
  const SIDE=["side_walk1","side_walk2","side_walk3","side_walk4"],WALK=["walk1","stand","walk2","stand"];
  const look=[["lookup_mid",140],["lookup",1300],["lookup_mid",140],["stand",300]];
  const idles=[look,[["scratch1",220],["scratch2",220],["scratch1",220],["scratch2",220],["scratch1",220],["scratch2",220],["stand",300]],[["walk1",170],["stand",170],["walk2",170],["stand",170],["walk1",170],["stand",170],["walk2",170],["stand",300]]];
  const turnFront=[["q34_back",200],["side_stand",200],["q34_front",220],["front_stand",500]],turnBack=[["q34_front",220],["side_stand",200],["q34_back",200],["stand",300]];
  // ---- the tricks
  const hop=async(h)=>{await tw({sy:.86},110,{frame:"stand",ease:"out"});await tw({sy:1.06,y:-h},240,{frame:"lookup",ease:"out"});await tw({y:0,sy:1},230,{frame:"lookup_mid",ease:"inq"});await tw({sy:.88},80,{frame:"stand"});await tw({sy:1},140)};
  const jump=async()=>{await hop(H()*.8);await sleep(150);await hop(H()*1.1);await play([["stand",200]])};
  const roll=async()=>{await play([["q34_front",180],["side_stand",220]]);await tw({x:Wd()*1.6,r:360},850,{frame:"side_stand",ease:"lin"});pos.r=0;place();await play([["side_stand",250]]);
    pos.f=-1;place();await tw({x:0,r:-360},850,{frame:"side_stand"});pos.r=0;pos.f=1;place();await play([["side_stand",200],["q34_back",200],["stand",300]])};
  const spin=async()=>{const seq=[["q34_back",1],["side_stand",1],["q34_front",1],["front_stand",1],["q34_front",-1],["side_stand",-1],["q34_back",-1],["stand",1]];for(let n=0;n<2;n++)for(const[fr,f]of seq){pos.f=f;place();face(fr);await sleep(n?70:110)}pos.f=1;place();await play([["stand",120],["lookup_mid",120],["lookup",600],["stand",250]])};
  const dance=async()=>{for(let i=0;i<8;i++){const sd=i%2?1:-1;await tw({x:sd*Wd()*.12,r:sd*9,sy:.94},150,{frame:i%2?"walk1":"walk2",ease:"out"});await tw({sy:1},90)}await tw({x:0,r:0},160,{end:"stand"});await sleep(200)};
  const moonwalk=async()=>{await play([["q34_front",180],["side_stand",200]]);await tw({x:-Wd()*1.4},1300,{frames:SIDE,fms:150});await play([["side_stand",300]]);pos.f=-1;place();await tw({x:0},1000,{frames:SIDE,fms:140});pos.f=1;place();await play([["side_stand",200],["q34_back",200],["stand",300]])};
  const headshake=async()=>{await play(turnFront);for(let i=0;i<5;i++){await tw({r:i%2?-9:9},110,{frame:"front_stand"})}await tw({r:0},110);await play([["front_lookup",900],["front_stand",300]]);await play(turnBack)};
  const faint=async()=>{await play(turnFront);await play([["front_lookup",500]]);await tw({r:-88,x:-Wd()*.35},420,{frame:"front_stand",ease:"inq"});await sleep(1400);await tw({r:0,x:0},550,{frame:"front_scratch",ease:"out"});await play([["front_scratch",240],["front_stand",200],["front_scratch",240],["front_stand",400]]);await play(turnBack)};
  const greet=async(n)=>{await play(turnFront);await play(n%2?[["front_lookup",1100],["front_stand",500]]:[["front_scratch",240],["front_stand",200],["front_scratch",240],["front_stand",200],["front_scratch",240],["front_stand",500]]);await play(turnBack)};
  const walkOff=async()=>{const parent=cv.parentElement.clientWidth,pw=Wd(),off={x:-(.6*pw),y:.1*pw,s:1.08},left=-(cv.offsetLeft+pw*off.s+20),right=parent-cv.offsetLeft+20,speed=3500/(off.x-left);
    await play([["q34_front",220],["side_stand",300]]);await tw({x:right,y:off.y,s:off.s},speed*right,{frames:SIDE,fms:140,end:"side_stand"});await sleep(5000);Object.assign(pos,off,{x:left});place();await waitVisible();
    await tw(off,3500,{frames:SIDE,fms:140,end:"side_stand"});await play([["side_stand",350],["q34_back",200],["stand",250]]);await tw({x:0,y:0,s:1},1300,{frames:WALK,fms:170,end:"stand"});await play([["stand",500],...look])};
  // roll and spin exist but are out of the draw: a rotated flat sprite looks fake
  const tricks=[jump,dance,moonwalk,headshake,faint,greet,walkOff];let lastTrick=-1,pokes=0;
  (async()=>{let i=0;for(;;){await waitVisible();const clicked=await waitClick(3000+5000*Math.random());if(!visible())continue;
    if(!clicked){if(Math.random()<.12){await hop(H()*.35);continue}if(Math.random()<.7)i=(i+1+Math.floor(Math.random()*(idles.length-1)))%idles.length;await play(idles[i]);continue}
    pokes++;let t;do t=Math.floor(Math.random()*tricks.length);while(t===lastTrick||(tricks[t]===walkOff&&pokes<3));lastTrick=t;
    try{await tricks[t](pokes)}catch(e){}Object.assign(pos,{x:0,y:0,s:1,sy:1,r:0,f:1});place();face("stand")}})();
  // for the console: pepe.do("roll") · pepe.list
  const byName={jump,roll,spin,dance,moonwalk,headshake,faint,greet,walkOff};
  return{list:Object.keys(byName),do:async n=>{if(byName[n]){await byName[n](1);Object.assign(pos,{x:0,y:0,s:1,sy:1,r:0,f:1});place();face("stand")}},pos};
}

