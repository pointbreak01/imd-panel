// ================================================================ the swarm: a radar scope of the fleet + its own panel
// Every blip is a seat the control plane lists (/swarm + /workers). Ring = what it is doing (working / delivered in the
// last day / idle), colour = runtime, size = accepted all-time. The sweep lights blips as it passes; joins ping;
// wires run from our seat to the seats we share the most jobs with. Nothing here is decorative: each motion is a field.
const RD={canvas:null,ctx:null,tip:null,w:0,h:0,cx:0,cy:0,R:0,blips:new Map(),sweep:0,last:0,raf:0,hot:null,on:false,pings:new Map(),seen:new Set(),static:false,dataAt:0};
const RCOL={claude:"#3ecf7a",codex:"#ffcf5a",none:"#5f8f6a",us:"#e8ffe9",wire:"#c9ecbf"};
const rcol=s=>s.runtime==="claude"?RCOL.claude:s.runtime==="codex"?RCOL.codex:RCOL.none;
const mname=m=>!m?"":m.startsWith("claude")?mi(m).n:m.replace(/^gpt-(\d[\w.]*)-(\w+)$/,"gpt-$1 $2");
const sw=()=>D&&D.swarm&&!D.swarm.error?D.swarm:null;
function radarInit(){RD.canvas=$("#radar");if(!RD.canvas)return;RD.ctx=RD.canvas.getContext("2d");RD.tip=$("#rtip");RD.static=matchMedia("(prefers-reduced-motion:reduce)").matches;
  new ResizeObserver(()=>radarSize()).observe(RD.canvas.parentElement);
  RD.canvas.addEventListener("mousemove",radarMove);RD.canvas.addEventListener("mouseleave",()=>{RD.hot=null;RD.tip.classList.remove("on");RD.canvas.style.cursor="";if(RD.static)radarDraw(performance.now())});
  RD.canvas.addEventListener("click",()=>{if(RD.hot)window.open("https://explorer.imd.fun/agents/"+RD.hot.id,"_blank","noopener")});
  document.addEventListener("visibilitychange",()=>{if(document.hidden){if(RD.raf){cancelAnimationFrame(RD.raf);RD.raf=0}}else if(RD.on)radarStart()});
}
function radarSize(){if(!RD.canvas)return;const w=RD.canvas.parentElement.clientWidth;if(!w)return;const h=Math.round(Math.max(340,Math.min(560,w*.4)));RD.w=w;RD.h=h;
  const dpr=Math.min(2,devicePixelRatio||1);RD.canvas.width=Math.round(w*dpr);RD.canvas.height=Math.round(h*dpr);RD.canvas.style.height=h+"px";RD.ctx.setTransform(dpr,0,0,dpr,0,0);
  const side=w>=760;RD.R=Math.round(h/2-26);RD.cx=side?RD.R+34:w/2;RD.cy=h/2;RD.side=side;radarLayout();radarDraw(performance.now())}
function radarStart(){RD.on=true;if(RD.static){radarDraw(performance.now());return}if(!RD.raf){RD.last=performance.now();RD.raf=requestAnimationFrame(radarFrame)}}
function radarStop(){RD.on=false;if(RD.raf){cancelAnimationFrame(RD.raf);RD.raf=0}}
// ring + angle for a seat: ring 0 working, 1 delivered in the last 24 h, 2 idle; angle and radial jitter are hashed from the id so a seat keeps its bearing
function radarLayout(){const S=sw();if(!S||!RD.R)return;const now=Date.now();const live=new Set();
  const ours=S.ours;const crewTop=new Set((S.crew||[]).slice(0,12).map(c=>c.tokenId));
  for(const s of S.seats){if(!s.online&&!s.working)continue;live.add(s.tokenId);const h=hash32("seat"+s.tokenId);const a=(h%3600)/3600*TAU;const jit=((h>>>12)%1000)/1000;
    const lastT=s.last?Date.parse(s.last.replace(" ","T").replace(/\+00$/,"Z")):0;const ring=s.working?0:(now-lastT<86400e3?1:2);
    const band=[[.06,.30],[.40,.66],[.74,.97]][ring];const tr=(band[0]+(band[1]-band[0])*jit)*RD.R;
    let b=RD.blips.get(s.tokenId);const size=1.6+Math.min(3.4,Math.sqrt((s.accepted||0)/24));
    if(!b){b={id:s.tokenId,a,r:tr,alpha:0};RD.blips.set(s.tokenId,b);if(RD.seen.size&&!RD.seen.has(s.tokenId))RD.pings.set("join:"+s.tokenId,now)}
    Object.assign(b,{tr,ring,size,col:rcol(s),us:s.tokenId===ours,crew:crewTop.has(s.tokenId),seat:s,gone:false})}
  for(const[id,b]of RD.blips){if(!live.has(id))b.gone=true}
  RD.seen=live;
  // joins reported by the network in the last two minutes ping too (a seat that reconnects is not new to us)
  for(const e of S.events||[]){if(e.kind==="agent"&&e.state==="joined"){const t=Date.parse(e.at);if(now-t<120e3&&!RD.pings.has("ev:"+e.at+e.tokenId)&&!RD.seenEv?.has(e.at+e.tokenId))RD.pings.set("ev:"+e.at+e.tokenId,Math.max(t,now-1500))}}
  RD.seenEv=new Set((S.events||[]).map(e=>e.at+e.tokenId));RD.dataAt=now;
}
function radarFrame(t){RD.raf=0;if(!RD.on||document.hidden)return;const dt=Math.min(100,t-RD.last);RD.last=t;RD.sweep=(RD.sweep+dt*TAU/7000)%TAU;radarDraw(t);RD.raf=requestAnimationFrame(radarFrame)}
function radarDraw(t){const ctx=RD.ctx;if(!ctx||!RD.w)return;const S=sw();const{cx,cy,R,w,h}=RD;const now=Date.now();
  ctx.fillStyle="#050705";ctx.fillRect(0,0,w,h);
  // scanlines + vignette so it reads as a tube, not a chart
  ctx.fillStyle="rgba(201,236,191,.035)";for(let y=0;y<h;y+=3)ctx.fillRect(0,y,w,1);
  const vg=ctx.createRadialGradient(cx,cy,R*.2,cx,cy,R*1.05);vg.addColorStop(0,"rgba(30,60,30,.22)");vg.addColorStop(1,"rgba(0,0,0,0)");ctx.fillStyle=vg;ctx.beginPath();ctx.arc(cx,cy,R,0,TAU);ctx.fill();
  // graticule
  ctx.strokeStyle=RCOL.wire;ctx.lineWidth=1;ctx.globalAlpha=.16;[.33,.68,1].forEach(f=>{ctx.beginPath();ctx.arc(cx,cy,R*f,0,TAU);ctx.stroke()});
  ctx.beginPath();ctx.moveTo(cx-R,cy);ctx.lineTo(cx+R,cy);ctx.moveTo(cx,cy-R);ctx.lineTo(cx,cy+R);ctx.stroke();
  ctx.globalAlpha=.28;for(let i=0;i<72;i++){const a=i*TAU/72,l=i%6?3:7;ctx.beginPath();ctx.moveTo(cx+Math.cos(a)*(R-l),cy+Math.sin(a)*(R-l));ctx.lineTo(cx+Math.cos(a)*R,cy+Math.sin(a)*R);ctx.stroke()}ctx.globalAlpha=1;
  const rc=[0,0,0];for(const b of RD.blips.values())if(!b.gone)rc[b.ring]++;
  ptext(ctx,cx+4,cy-R*.33-3,`working · ${rc[0]}`,8,rc[0]?PAL.phos:PAL.phosDim);ptext(ctx,cx+4,cy-R*.68-3,`delivered <24h · ${rc[1]}`,8,PAL.phosDim);ptext(ctx,cx+4,cy-R+9,`idle · ${rc[2]}`,8,PAL.phosDim);
  // sweep
  if(!RD.static){ctx.save();ctx.beginPath();ctx.arc(cx,cy,R,0,TAU);ctx.clip();
    if(ctx.createConicGradient){const g=ctx.createConicGradient(RD.sweep-TAU*.32,cx,cy);g.addColorStop(0,"rgba(62,207,122,0)");g.addColorStop(.32,"rgba(62,207,122,.34)");g.addColorStop(.3201,"rgba(62,207,122,0)");g.addColorStop(1,"rgba(62,207,122,0)");ctx.fillStyle=g;ctx.fillRect(cx-R,cy-R,2*R,2*R)}
    ctx.strokeStyle="#9ff2b8";ctx.lineWidth=1.5;ctx.globalAlpha=.9;ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(cx+Math.cos(RD.sweep)*R,cy+Math.sin(RD.sweep)*R);ctx.stroke();ctx.globalAlpha=1;ctx.restore()}
  // motion: blips slide to their ring, fade in / out
  const k=RD.static?1:.06;for(const[id,b]of[...RD.blips]){b.r+=(b.tr-b.r)*k;b.alpha+=((b.gone?0:1)-b.alpha)*(RD.static?1:.08);if(b.gone&&b.alpha<.02)RD.blips.delete(id)}
  const us=[...RD.blips.values()].find(b=>b.us);const pos=b=>[cx+Math.cos(b.a)*b.r,cy+Math.sin(b.a)*b.r];
  const glowAt=a=>{const d=((RD.sweep-a)%TAU+TAU)%TAU;return RD.static?.55:Math.pow(1-d/TAU,3)};
  // wires to the crew
  if(us){const[ux,uy]=pos(us);for(const b of RD.blips.values()){if(!b.crew||b.gone)continue;const[x,y]=pos(b);const g=glowAt(b.a);ctx.strokeStyle=RCOL.wire;ctx.globalAlpha=(.10+.5*g)*b.alpha;ctx.lineWidth=Math.max(.6,Math.min(2.4,(b.seat.sharedJobs||0)/50));ctx.beginPath();ctx.moveTo(ux,uy);ctx.lineTo(x,y);ctx.stroke()}ctx.globalAlpha=1}
  // blips
  for(const b of RD.blips.values()){if(b.us)continue;const[x,y]=pos(b);const g=glowAt(b.a);const hot=RD.hot===b;const al=(.22+.78*g)*b.alpha;
    let sz=b.size;if(b.seat.working&&!RD.static)sz+=Math.sin(t/260)*.9+.9;
    ctx.globalAlpha=al;ctx.fillStyle=b.col;if(g>.6||hot||b.seat.working)glow(ctx,b.col);ctx.beginPath();ctx.arc(x,y,sz,0,TAU);ctx.fill();noglow(ctx);
    if(b.seat.working){ctx.strokeStyle=b.col;ctx.lineWidth=1;ctx.beginPath();ctx.arc(x,y,sz+4+(RD.static?0:(t/9%14)),0,TAU);ctx.globalAlpha=al*.6*(RD.static?1:1-(t/9%14)/14);ctx.stroke()}
    if(b.seat.queued){ctx.strokeStyle=PAL.amber;ctx.globalAlpha=al;ctx.lineWidth=1;ctx.beginPath();ctx.arc(x,y,sz+3,0,TAU);ctx.stroke()}
    if(hot){ctx.globalAlpha=1;ctx.strokeStyle="#fff";ctx.lineWidth=1;ctx.strokeRect(x-sz-4,y-sz-4,2*sz+8,2*sz+8)}}
  ctx.globalAlpha=1;
  // pings (joins)
  for(const[key,t0]of[...RD.pings]){const age=(now-t0)/1800;if(age>1){RD.pings.delete(key);continue}const id=key.split(":").pop().replace(/^.*Z/,"");const b=RD.blips.get(key.startsWith("join:")?key.slice(5):(RD.blips.has(id)?id:null));if(!b)continue;const[x,y]=pos(b);
    ctx.strokeStyle="#c9ecbf";ctx.globalAlpha=(1-age)*.8;ctx.lineWidth=1.2;ctx.beginPath();ctx.arc(x,y,4+age*26,0,TAU);ctx.stroke();ctx.globalAlpha=(1-age)*.4;ctx.beginPath();ctx.arc(x,y,2+age*14,0,TAU);ctx.stroke()}
  ctx.globalAlpha=1;
  // our seat: a crosshair
  if(us){const[x,y]=pos(us);const g=Math.max(.5,glowAt(us.a));ctx.strokeStyle=RCOL.us;ctx.lineWidth=1.4;glow(ctx,RCOL.us);ctx.globalAlpha=.55+.45*g;ctx.beginPath();ctx.arc(x,y,6,0,TAU);ctx.stroke();ctx.beginPath();[[-11,0,-4,0],[4,0,11,0],[0,-11,0,-4],[0,4,0,11]].forEach(([a1,b1,c1,d1])=>{ctx.moveTo(x+a1,y+b1);ctx.lineTo(x+c1,y+d1)});ctx.stroke();noglow(ctx);
    ctx.fillStyle=RCOL.us;ctx.beginPath();ctx.arc(x,y,2.2,0,TAU);ctx.fill();ctx.globalAlpha=1;ptext(ctx,x+13,y+4,`#${us.id} you`,9,RCOL.us,600)}
  // bezel readouts
  const H=S?S.health||{}:{};const on=S?S.seats.filter(s=>s.online).length:0,wk=S?S.seats.filter(s=>s.working).length:0;
  label(ctx,14,20,"the swarm",false,PAL.phos);
  if(!S){ptext(ctx,cx,cy+4,esc((D&&D.swarm&&D.swarm.error)||"no swarm data yet"),11,PAL.phosDim,400,"center")}
  if(RD.side&&S){const x0=cx+R+40,x1=w-16;const cw=x1-x0;if(cw>160){
    const big=[["online",on],["working",wk],["enrolled",H.seatsEnrolled??"–"]];const bw=cw/big.length;big.forEach(([l,v],i)=>{const x=x0+i*bw;glow(ctx,PAL.lamp);ptext(ctx,x,58,String(v),Math.min(30,bw*.32),PAL.lamp,700);noglow(ctx);ptext(ctx,x,72,l,8,PAL.phosDim)});
    let y=100;ptext(ctx,x0,y,`${H.acceptedLastDay??"–"} accepted · ${H.jobsDoneLastDay??"–"} jobs · ${H.oraclesDoneLastDay??"–"} oracles in the last day`,9,PAL.phos);y+=16;
    const F=S.fleet||{};const rt=F.runtime||{},md=F.model||{};ptext(ctx,x0,y,`runtimes: claude ${rt.claude||0} · codex ${rt.codex||0}   premium: fable ${md["claude-fable-5-1"]||0} · gpt ${Object.entries(md).filter(([k])=>k.startsWith("gpt")).reduce((a,[,v])=>a+v,0)} · none ${md["no premium"]||0}`,9,PAL.phosDim);y+=22;
    [["claude runtime",RCOL.claude],["codex runtime",RCOL.codex],["no premium model",RCOL.none]].forEach(([l,c],i)=>{ctx.fillStyle=c;glow(ctx,c);ctx.beginPath();ctx.arc(x0+5+i*(cw/3),y-3,3.2,0,TAU);ctx.fill();noglow(ctx);ptext(ctx,x0+13+i*(cw/3),y,l,8,PAL.phosDim)});y+=14;
    ptext(ctx,x0,y,"size = accepted all-time · ring pulse = working · amber ring = queued · wires = your crew",8,PAL.phosDim);y+=22;
    label(ctx,x0,y,"last on the wire",false,PAL.phosDim);y+=6;const ev=(S.events||[]).slice(0,Math.max(3,Math.floor((h-y-14)/15)));
    ev.forEach(e=>{y+=15;const tt=(e.at||"").slice(11,16);const who=e.tokenId&&e.tokenId!=="None"?`#${e.tokenId} `:"";const txt=e.kind==="agent"?`${who}${e.state}`:`${who}${e.step||"job"} ${e.state||""}${e.objective?" · "+e.objective.replace(/\s+/g," ").slice(0,60):""}`;let s2=`${tt}  ${txt}`;ctx.font=`9px ${MONO}`;while(s2.length>8&&ctx.measureText(s2).width>cw)s2=s2.slice(0,-3);ptext(ctx,x0,y,s2,9,e.kind==="node"?PAL.phos:PAL.phosDim)})}}
  if(S)ptext(ctx,w-14,h-10,`api.imd.fun/swarm · ${S.at?new Date(S.at).toISOString().slice(11,19):""} UTC${RD.static?" · reduced motion":""}`,8,PAL.phosDim,400,"right");
}
function radarMove(e){const r=RD.canvas.getBoundingClientRect();const mx=e.clientX-r.left,my=e.clientY-r.top;let best=null,bd=100;
  for(const b of RD.blips.values()){if(b.gone)continue;const x=RD.cx+Math.cos(b.a)*b.r,y=RD.cy+Math.sin(b.a)*b.r;const d=(x-mx)**2+(y-my)**2;if(d<bd){bd=d;best=b}}
  if(best!==RD.hot){RD.hot=best;if(RD.static)radarDraw(performance.now())}RD.canvas.style.cursor=best?"pointer":"";
  if(!best){RD.tip.classList.remove("on");return}const s=best.seat;const who=s.ownerName||(s.owner?s.owner.slice(0,8)+"…":"");
  RD.tip.innerHTML=`<div class="th"><b>seat #${esc(s.tokenId)}</b> <span>${best.us?"this node":s.working?"working now":best.ring===1?"delivered <24h":"idle"}${s.queued?" · queued":""}</span></div><div>${who?esc(who)+" · ":""}${esc(s.runtime||"?")}${s.model?" · "+esc(mname(s.model)):" · no premium"}${s.os?" · "+esc(s.os):""}</div><div>${s.accepted||0} accepted · ${s.failed||0} failed · last ${ago(s.last)}</div>${s.sharedJobs?`<div class="tt">${s.sharedJobs} jobs shared with you${s.agreed||s.differed?` · oracles: ${s.agreed} agreed, ${s.differed} differed`:""}</div>`:""}<div class="tk">click for the agent page on the explorer</div>`;
  RD.tip.classList.add("on");const tw=RD.tip.offsetWidth||260,th=RD.tip.offsetHeight||70;const x=RD.cx+Math.cos(best.a)*best.r,y=RD.cy+Math.sin(best.a)*best.r;const below=y<th+16;RD.tip.style.left=Math.max(8+tw/2,Math.min(RD.w-8-tw/2,x))+"px";RD.tip.style.top=(below?y+14:y-12)+"px";RD.tip.classList.toggle("below",below)}

// ---- the swarm panel: counters, a day of online/working, fleet composition, what is running, our crew
const SP={canvas:null,ctx:null,tip:null,width:0,height:0,cell:40,mods:[],hits:[],hot:null,dirty:true,draw:()=>swarmDraw()};
function swarmInit(){SP.canvas=$("#swarm");if(!SP.canvas)return;SP.ctx=SP.canvas.getContext("2d");SP.tip=$("#stip");
  new ResizeObserver(()=>{if(D)renderSwarm()}).observe(SP.canvas.parentElement);
  SP.canvas.addEventListener("mousemove",e=>withPN(SP,()=>panelMove(e)));SP.canvas.addEventListener("mouseleave",()=>withPN(SP,()=>{PN.hot=null;PN.tip.classList.remove("on");PN.canvas.style.cursor="";swarmDraw()}));
  SP.canvas.addEventListener("click",e=>withPN(SP,()=>{const h=hitAt(e);if(h&&h.click)h.click()}));
}
function renderSwarm(){if(!SP.canvas||!D)return;radarLayout();if(RD.static||!RD.raf)radarDraw(performance.now());withPN(SP,()=>{const width=PN.canvas.parentElement.clientWidth;if(!width)return;PN.width=width;const cell=Math.max(30,Math.min(44,width/33));const narrow=width<760,tiny=width<430;PN.cell=cell;
  const rows=[];const row=(items,h)=>rows.push({items,h});const K=["k0","k1","k2","k3","k4","k5","k6","k7"];
  if(tiny){K.forEach(k=>row([[k,1]],2.6));row([["sday",1]],5);row([["sfleet",1]],5);row([["sjobs",1]],7);row([["soracle",1]],6)}
  else if(narrow){for(let i=0;i<8;i+=2)row([[K[i],.5],[K[i+1],.5]],3);row([["sday",1]],5.5);row([["sfleet",1]],5);row([["sjobs",1]],7);row([["soracle",1]],6)}
  else{row(K.map(k=>[k,1]),3);row([["sday",.5],["sfleet",.5]],5.5);row([["sjobs",.5],["soracle",.5]],6.5)}
  const mods=[];let y=0;const gap=2;for(const r of rows){let x=0;const tot=r.items.reduce((a,i)=>a+i[1],0);r.items.forEach((it,i)=>{const w=Math.round(width*it[1]/tot);const last=i===r.items.length-1;mods.push({kind:it[0],x:x+gap/2,y:y+gap/2,w:(last?width-x:w)-gap,h:Math.round(r.h*cell)-gap});x+=w});y+=Math.round(r.h*cell)}
  PN.mods=mods;PN.height=y;const dpr=Math.min(2,devicePixelRatio||1);PN.canvas.width=Math.round(width*dpr);PN.canvas.height=Math.round(PN.height*dpr);PN.canvas.style.height=PN.height+"px";PN.ctx.setTransform(dpr,0,0,dpr,0,0);PN.ctx.lineJoin="round";swarmDraw()})}
function swarmCounters(){const S=sw();if(!S)return[];const H=S.health||{},C=S.counts||{},F=S.fleet||{};const on=S.seats.filter(s=>s.online).length,wk=S.seats.filter(s=>s.working).length;const js=C.jobStates||{};
  return[["agents online",on,`${H.seatsEnrolled??"–"} enrolled`,"","Daemons connected to api.imd.fun right now (/workers), and seats enrolled on the identity collection."],["working now",wk,`server: ${H.workingNow??"–"} · ${C.tasksInProgress??0} tasks`,wk?"":"","Seats flagged working in the /swarm seat list — the same blips that sit in the radar's inner ring. The server's own workingNow and tasksInProgress counters are cached on a different clock, so they can differ by one or two for a few seconds."],
    ["accepted 24h",fmt(H.acceptedLastDay),`${H.jobsDoneLastDay??"–"} jobs · ${H.oraclesDoneLastDay??"–"} oracles`,"","Submissions accepted across the whole network in the last 24 h, and the jobs and oracle questions closed."],["executing",js.executing||0,`${js.completed||0} done of last ${C.jobs||0}`,js.executing?"amber":"","Jobs in execution among the last 100 the control plane lists; blocked ones are shown in the jobs module."],
    ["launches live",C.launchesLive??"–",`${C.sites??"–"} sites`,"","Contract launches live on chain, and sites published under ENS."],["net tokens",fmt(C.inferenceTokens),"inference, all time","","Inference tokens the whole network reports, all runtimes, since the beginning."],
    ["runtimes",`${(F.runtime||{}).claude||0}·${(F.runtime||{}).codex||0}`,"claude · codex","","How many connected daemons run Claude Code vs Codex."],["events kept",S.eventsStored??0,`${(S.events||[]).length} shown`,"","Fleet events accumulated locally in swarm.sqlite (the API keeps only the last 60)."]]}
function swarmDraw(){withPN(SP,()=>{const ctx=PN.ctx;if(!ctx||!PN.mods.length)return;PN.hits=[];ctx.fillStyle=PAL.wall;ctx.fillRect(0,0,PN.width,PN.height);const kp=swarmCounters();
  for(const m of PN.mods){plate(ctx,m.x,m.y,m.w,m.h);const pad=Math.max(8,PN.cell*.3);const b={x:m.x+pad,y:m.y+pad,w:m.w-2*pad,h:m.h-2*pad,ty:m.y+pad+PN.cell*.1};
    if(m.kind.startsWith("k")){if(kp.length)modCounter(ctx,m,b,kp[+m.kind.slice(1)]);else{label(ctx,b.x,b.ty+2,"–");screen(ctx,b.x,b.ty+PN.cell*.3,b.w,b.y+b.h-b.ty-PN.cell*.3)}}
    else if(m.kind==="sday")modSwDay(ctx,m,b);else if(m.kind==="sfleet")modSwFleet(ctx,m,b);else if(m.kind==="sjobs")modSwJobs(ctx,m,b);else if(m.kind==="soracle")modSwOracle(ctx,m,b);
    if(PN.hot&&PN.hot.mod===m&&PN.hot.whole){ctx.fillStyle="#fff";ctx.globalAlpha=.08;ctx.fillRect(m.x,m.y,m.w,m.h);ctx.globalAlpha=1}}ctx.textAlign="left"})}
function modSwDay(ctx,m,b){const S=sw();const P=S?S.samples||[]:[];label(ctx,b.x,b.ty+2,"09 · online & working, last 24 h");label(ctx,b.x+b.w,b.ty+2,P.length?`${P.length} samples`:"collecting",true);
  const sy=b.ty+PN.cell*.3,sh=b.y+b.h-sy;screen(ctx,b.x,sy,b.w,sh);const L=b.x+34,R=b.x+b.w-8,T=sy+22,B=sy+sh-20,pw=R-L,ph=B-T;
  if(P.length<2||pw<40){ptext(ctx,b.x+b.w/2,sy+sh/2,"the dashboard samples /swarm once a minute — a day of history builds up from here",9,PAL.phosDim,400,"center");modHit(m,tipHTML("Online & working","Agents online and working now, sampled every minute into swarm.sqlite and bucketed by 5 minutes."));return}
  const t0=Date.now()/1000-86400,t1=Date.now()/1000;const maxOn=Math.max(1,...P.map(p=>p.online||0));const X=t=>L+pw*(t-t0)/(t1-t0);
  ctx.strokeStyle=PAL.glass;ctx.globalAlpha=.22;for(let i=0;i<=4;i++){const y=T+ph-ph*i/4;ctx.beginPath();ctx.moveTo(L,y);ctx.lineTo(R,y);ctx.stroke();ctx.globalAlpha=.9;ptext(ctx,L-4,y+3,String(Math.round(maxOn*i/4)),8,PAL.phosDim,400,"right");ctx.globalAlpha=.22}ctx.globalAlpha=1;
  const line=(key,col,scale)=>{ctx.strokeStyle=col;ctx.lineWidth=1.5;glow(ctx,col);ctx.beginPath();P.forEach((p,i)=>{const x=X(p.ts),y=T+ph-ph*(p[key]||0)/scale;i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.stroke();noglow(ctx)};
  line("online",PAL.lamp,maxOn);line("working",PAL.amber,maxOn);
  for(let hh=0;hh<=24;hh+=6){const t=t0+hh*3600;ptext(ctx,X(t),B+12,new Date(t*1000).toISOString().slice(11,16),8,PAL.phosDim,400,hh===0?"left":hh===24?"right":"center")}
  let lx=L;[["online",PAL.lamp],["working",PAL.amber]].forEach(([n,c])=>{ctx.fillStyle=c;ctx.fillRect(lx,T-13,8,8);ptext(ctx,lx+11,T-6,n,8,PAL.phosDim);lx+=11+ctx.measureText(n).width+12});
  P.forEach((p,i)=>{const x0=i?X((P[i-1].ts+p.ts)/2):L,x1=i<P.length-1?X((P[i+1].ts+p.ts)/2):R;PN.hits.push({x:x0,y:T,w:x1-x0,h:ph,mod:m,tip:tipHTML(new Date(p.ts*1000).toISOString().slice(11,16)+" UTC",`${p.online} online · ${p.working} working · ${p.enrolled} enrolled`)})});
  PN.hits.unshift({x:m.x,y:m.y,w:m.w,h:m.h,mod:m,whole:true,tip:tipHTML("Online & working","Agents online and working now, sampled every minute into swarm.sqlite and bucketed by 5 minutes. Working is on the same scale as online, so it hugs the floor most of the day.")})}
function modSwFleet(ctx,m,b){const S=sw();const F=S?S.fleet||{}:{};label(ctx,b.x,b.ty+2,"10 · the fleet");label(ctx,b.x+b.w,b.ty+2,F.connected?`${F.connected} daemons${F.paused?" · "+F.paused+" paused":""}`:"n/a",true);
  const sy=b.ty+PN.cell*.3,sh=b.y+b.h-sy;screen(ctx,b.x,sy,b.w,sh);if(!F.connected){ptext(ctx,b.x+b.w/2,sy+sh/2,"no fleet data",10,PAL.phosDim,400,"center");return}
  const groups=[["runtime",F.runtime||{},k=>k==="claude"?RCOL.claude:k==="codex"?RCOL.codex:RCOL.none],["premium model",F.model||{},k=>k.startsWith("claude")?RCOL.claude:k.startsWith("gpt")?RCOL.codex:RCOL.none],["system",F.os||{},()=>PAL.phos],["daemon version",F.daemon||{},()=>PAL.phosDim],["concurrency",F.concurrency||{},()=>PAL.phos],["outcomes",((D.fleet||{}).seats||{}).totals||{},k=>k==="accepted"?PAL.lamp:k==="pending"?PAL.amber:k==="attempts"?PAL.phosDim:"#ff5a50"]].filter(([n,o])=>n!=="outcomes"||Object.keys(o).length);
  const rows=groups.map(([n,o,c])=>[n,Object.entries(o).sort((a,d)=>d[1]-a[1]).slice(0,4),c]);const rh=(sh-10)/rows.length;const fs=Math.max(8,Math.min(10,rh*.3));const lw=fs*9;
  rows.forEach(([n,ent,col],i)=>{const y=sy+8+i*rh;ptext(ctx,b.x+10,y+rh*.55,n,fs,PAL.phosDim);const tot=ent.reduce((a,[,v])=>a+v,0)||1;let x=b.x+10+lw;const bw=b.w-20-lw;
    if(n==="outcomes")ent=ent.filter(([k])=>k!=="attempts");const tot2=ent.reduce((a,[,v])=>a+v,0)||1;ent.forEach(([k,v])=>{const w=Math.max(2,bw*v/tot2-2);ctx.fillStyle=col(k);glow(ctx,col(k));ctx.fillRect(x,y+rh*.18,w,rh*.42);noglow(ctx);const t=`${k.replace("claude-fable-5-1","fable 5.1").replace("gpt-6-astra","gpt-6 astra")} ${v}`;ctx.font=`${fs*.9}px ${MONO}`;if(ctx.measureText(t).width<w-4)ptext(ctx,x+3,y+rh*.5,t,fs*.9,"#0a0a0a",600);PN.hits.push({x,y:y+rh*.1,w,h:rh*.6,mod:m,tip:tipHTML(n,`${esc(k)}: ${v} of ${tot} (${Math.round(v/tot*100)}%)`)});x+=w+2})});
  PN.hits.unshift({x:m.x,y:m.y,w:m.w,h:m.h,mod:m,whole:true,tip:tipHTML("The fleet",`Composition of the connected daemons from api.imd.fun/workers: runtime, the premium model each advertises, operating system, daemon build and concurrency. Green is Claude, amber is Codex/GPT. The last bar is every seat's record from api.imd.fun/seats/records: ${fmt((((D.fleet||{}).seats||{}).totals||{}).accepted)} accepted, ${fmt((((D.fleet||{}).seats||{}).totals||{}).rejected)} rejected, ${fmt((((D.fleet||{}).seats||{}).totals||{}).failed)} failed, ${fmt((((D.fleet||{}).seats||{}).totals||{}).pending)} pending across ${((D.fleet||{}).seats||{}).count||"?"} seats, ${((D.fleet||{}).seats||{}).activeDay||"?"} of them worked in the last 24 h.`)})}
function listRows(ctx,m,b,sy,sh,items,fmtRow,fs){const rh=Math.min(fs*1.75,(sh-10)/Math.max(1,items.length));items.forEach((it,i)=>{const y=sy+6+i*rh;const{tag,tagCol,text,tip,click}=fmtRow(it);ctx.fillStyle=tagCol;glow(ctx,tagCol);ctx.beginPath();ctx.arc(b.x+14,y+rh*.5,3,0,TAU);ctx.fill();noglow(ctx);
    ptext(ctx,b.x+24,y+rh*.66,tag,fs*.85,tagCol,600);let s=text;ctx.font=`${fs}px ${MONO}`;const tx=b.x+24+fs*7.5,maxw=b.x+b.w-8-tx;while(s.length>6&&ctx.measureText(s).width>maxw)s=s.slice(0,-3);ptext(ctx,tx,y+rh*.66,s,fs,PAL.phos);
    PN.hits.push({x:b.x,y,w:b.w,h:rh,mod:m,tip,click})})}
const jobState=s=>({executing:PAL.amber,completed:PAL.lamp,cancelled:"#ff5a50",blocked:"#ff5a50",failed:"#ff5a50"})[s]||PAL.phosDim;
function modSwJobs(ctx,m,b){const S=sw();const J=S?S.jobs||[]:[];const ex=J.filter(j=>j.state==="executing"||j.state==="blocked");const rest=J.filter(j=>!ex.includes(j));const items=ex.concat(rest).slice(0,9);
  label(ctx,b.x,b.ty+2,"11 · on the network now");label(ctx,b.x+b.w,b.ty+2,J.length?`${ex.length} executing · ${J.length} recent`:"n/a",true);
  const sy=b.ty+PN.cell*.3,sh=b.y+b.h-sy;screen(ctx,b.x,sy,b.w,sh);if(!items.length){ptext(ctx,b.x+b.w/2,sy+sh/2,"no jobs listed",10,PAL.phosDim,400,"center");return}
  const fs=Math.max(8,Math.min(10.5,sh/items.length*.5));
  listRows(ctx,m,b,sy,sh,items,j=>{const kind=(j.template||"").replace(/^skill:|^shape:/,"").replace(/[-_]/g," ")||"job";const obj=j.objective.replace(/^Answer this question about chain (\d+) over blocks \d+ to \d+, exactly as .imd\/reads\/oracle\.json pins it:\s*/,"chain $1 · ").replace(/^WORKFLOW \w+ STAGE CONTEXT:.*?\.\s*/,"").replace(/\s+/g," ");
    return{tag:j.state,tagCol:jobState(j.state),text:`${kind} · ${obj}`,tip:tipHTML(`${kind} · ${j.state}`,`${esc(j.objective)}<br><span class="tk">${(j.createdAt||"").replace("T"," ").slice(0,16)} UTC${j.blockedReason?" · blocked: "+esc(j.blockedReason):""} · click for the job on the explorer</span>`),click:()=>window.open("https://explorer.imd.fun/jobs/"+j.id,"_blank","noopener")}},fs);
  PN.hits.unshift({x:m.x,y:m.y,w:m.w,h:m.h,mod:m,whole:true,tip:tipHTML("On the network now","The most recent jobs the control plane lists (api.imd.fun/jobs), executing and blocked ones first. The blip pulsing on the radar is whoever holds their leases.")})}
const oracleCol=s=>({attested:PAL.lamp,assessing:PAL.amber,reproducing:PAL.amber,disagreed:"#ff5a50",blocked:"#ff5a50",mismatch:"#ff5a50",refused:"#ff5a50",failed:"#ff5a50"})[s]||PAL.phosDim;
function modSwOracle(ctx,m,b){const S=sw();const O=S?S.oracle||[]:[];const items=O.slice(0,9);label(ctx,b.x,b.ty+2,"12 · oracle questions");label(ctx,b.x+b.w,b.ty+2,O.length?`${O.filter(o=>o.status==="attested").length} attested of last ${O.length}`:"n/a",true);
  const sy=b.ty+PN.cell*.3,sh=b.y+b.h-sy;screen(ctx,b.x,sy,b.w,sh);if(!items.length){ptext(ctx,b.x+b.w/2,sy+sh/2,"no oracle requests listed",10,PAL.phosDim,400,"center");return}
  const fs=Math.max(8,Math.min(10.5,sh/items.length*.5));
  listRows(ctx,m,b,sy,sh,items,o=>({tag:o.status,tagCol:oracleCol(o.status),text:`${o.answerType} · ${o.question.replace(/\s+/g," ")}`,tip:tipHTML(`${o.status} · ${o.answerType} on chain ${o.chainId}`,`${esc(o.question)}<br><span class="tk">asked ${(o.createdAt||"").replace("T"," ").slice(0,16)} UTC${o.attestedAt?" · attested "+o.attestedAt.replace("T"," ").slice(0,16):""} · click for the panel job on the explorer</span>`),click:()=>{if(o.jobId)window.open("https://explorer.imd.fun/jobs/"+o.jobId,"_blank","noopener")}}),fs);
  PN.hits.unshift({x:m.x,y:m.y,w:m.w,h:m.h,mod:m,whole:true,tip:tipHTML("Oracle questions","Paid questions the network is answering (api.imd.fun/oracle/requests): a panel of seats answers each one, and the attester signs the answer only when the quorum agrees. Your oracle tasks are seats on these panels.")})}
// ---- published: sites, contract launches and research reports, with search and filters
const PUB={type:"",status:"",chain:"",q:"",all:false,LIMIT:12};
const pubAge=iso=>{const d=(Date.now()-Date.parse(iso||0))/1000;return isFinite(d)?(d<3600?Math.round(d/60)+" min":d<86400?Math.round(d/3600)+" h":Math.round(d/86400)+" d")+" ago":""};
const pubHay=p=>[p.title,p.titleFull,p.id,...p.sites.map(x=>`${x.label} ${x.ensName} ${x.status}`),...p.contracts.map(c=>`#${c.launchNumber} ${c.kind} ${c.status} ${c.chain.name} ${(c.artifacts||[]).map(a=>a.name+" "+a.address).join(" ")}`),...p.research.map(r=>r.jobId)].join(" ").toLowerCase();
const pubStatus=p=>{const st=[];p.sites.forEach(x=>st.push(x.status));p.contracts.forEach(c=>st.push(c.status));return st};
function pubFilter(list){const q=PUB.q.trim().toLowerCase();return list.filter(p=>(!PUB.type||p.types.includes(PUB.type))&&(!PUB.status||pubStatus(p).includes(PUB.status))&&(!PUB.chain||p.contracts.some(c=>c.chain.name===PUB.chain))&&(!q||pubHay(p).includes(q)))}
function pubSketch(x){const ok=x.status==="named";if(!ok)return `<div class="crt"><div class="tube dead">no signal${x.failure?"":""}</div></div>`;const h=hash32("site"+x.id),hue=h%360,hero=(h>>>8)%3;
  const heroStyle=hero===0?`left:4%;top:22%;width:92%;height:24%`:hero===1?`left:4%;top:22%;width:45%;height:50%`:`left:38%;top:30%;width:24%;aspect-ratio:1;border-radius:50%`;
  const lines=[0,1,2,3].map(k=>{const y=(hero===1?22:52)+k*9;const x0=hero===1?52:4,lw=(hero===1?44:92)*(.55+((h>>>(k*3))%40)/100);return y>92?"":`<i class="ln" style="left:${x0}%;top:${y}%;width:${lw}%"></i>`}).join("");
  return `<div class="crt"><div class="tube"><i class="band" style="background:hsl(${hue} 30% 32%)"></i><i class="logo" style="background:hsl(${hue} 40% 60%)"></i><i class="hero" style="${heroStyle};background:hsl(${(hue+40)%360} 25% 45%)"></i>${lines}<i class="gl"></i><span class="ens">${esc(x.ensName||x.label||"")}</span></div></div>`}
function pubCard(p){const site=p.sites.find(x=>!x.superseded)||p.sites[0];const c=p.contracts[0];const r=p.research[0];
  const led=site?(site.status==="named"?"":"bad"):c?(c.status==="live"?"":c.status==="parked"?"warn":"bad"):r?"":"off";
  const types=p.types.map(t=>`<span class="ty ${t==="sites"?"site":""}">${t==="sites"?"site":t==="contracts"?"contracts":"research"}</span>`).join("");
  let body="";
  if(site)body=pubSketch(site);
  if(c){const tok=c.token;const arts=(c.artifacts||[]).filter(a=>a.role!=="token").map(a=>`<b>${esc(a.name)}</b> <span>${a.role}</span>`).join(" · ");
    body+=`<div class="chip"><div class="sym">${tok?esc(tok.name):esc(c.kind==="univ4_hook"?"Uniswap v4 hook":"EVM project")}</div><div class="nm">launch #${c.launchNumber??"?"} · ${esc(c.kind.replace("_"," "))} · ${esc(c.chain.name)}${c.chain.id!==1?" (testnet)":""} · ${esc(c.status)}${p.contracts.length>1?` · +${p.contracts.length-1} more`:""}</div>${arts?`<div class="arts">${arts}</div>`:""}${c.parkedReason?`<div class="arts" style="color:var(--pl-bad)">${esc(c.parkedReason.slice(0,140))}</div>`:""}</div>`}
  if(r&&!site&&!c)body+=`<div class="doc"><b>research report</b> · published ${pubAge(r.publishedAt)}<br>${p.research.length} report${p.research.length>1?"s":""} in the research repository${r.pullRequestUrl?" · pull request open":""}</div>`;
  const links=[];if(site&&site.url&&site.status==="named")links.push(`<a href="${site.url}" target="_blank" rel="noopener">open site ↗</a>`);
  if(c&&c.token&&c.chain.scan)links.push(`<a href="${c.chain.scan}/token/${c.token.address}" target="_blank" rel="noopener">token ↗</a>`);else if(c&&c.artifacts[0]&&c.chain.scan)links.push(`<a href="${c.chain.scan}/address/${c.artifacts[0].address}" target="_blank" rel="noopener">contract ↗</a>`);
  const repo=(site&&site.repoUrl)||(c&&c.repoUrl)||(r&&r.repoUrl);if(repo)links.push(`<a href="${repo}" target="_blank" rel="noopener">${r&&!site&&!c?"report":"source"} ↗</a>`);
  if(p.jobUrl)links.push(`<a href="${p.jobUrl}" target="_blank" rel="noopener">job ↗</a>`);else if(r)links.push(`<a href="https://explorer.imd.fun/jobs/${r.jobId}" target="_blank" rel="noopener">job ↗</a>`);
  links.push(`<span class="muted">${pubAge(p.publishedAt)}</span>`);
  return `<div class="pub" title="${esc(p.titleFull)}"><div class="ph">${types}<span class="sp"></span><i class="led ${led}"></i></div>${body}<div class="ti">${esc(p.title||"(untitled)")}</div><div class="pf">${links.join("")}</div></div>`}
function renderPublished(){const S=sw();const g=$("#pubGrid");if(!g)return;const all=S?S.publications||[]:[];
  const cnt={sites:0,contracts:0,research:0};all.forEach(p=>p.types.forEach(t=>cnt[t]=(cnt[t]||0)+1));
  $("#pubInfo").textContent=all.length?`${all.length} publications · ${cnt.sites} sites · ${cnt.contracts} launches · ${cnt.research} reports · api.imd.fun/publications`:(S&&S.publicationsError?"unavailable: "+S.publicationsError:"loading…");
  const L=pubFilter(all);const show=PUB.all?L:L.slice(0,PUB.LIMIT);
  $("#pubCount").textContent=L.length===all.length?`${L.length} shown`:`${L.length} of ${all.length} match`;
  g.innerHTML=show.length?show.map(pubCard).join(""):`<div class="empty">nothing matches</div>`;
  const more=$("#pubMore");more.style.display=L.length>PUB.LIMIT?"":"none";more.textContent=PUB.all?"show fewer":`show all ${L.length}`;$("#pubMoreInfo").textContent=PUB.all||L.length<=PUB.LIMIT?"":`${L.length-PUB.LIMIT} more`}
(()=>{const g=$("#pubGrid");if(!g)return;document.querySelectorAll("#pubTypes button").forEach(b=>b.onclick=()=>{document.querySelectorAll("#pubTypes button").forEach(x=>x.classList.toggle("on",x===b));PUB.type=b.dataset.pt;renderPublished()});
  $("#pubStatus").onchange=e=>{PUB.status=e.target.value;renderPublished()};$("#pubChain").onchange=e=>{PUB.chain=e.target.value;renderPublished()};
  let tmr=null;$("#pubQ").oninput=e=>{PUB.q=e.target.value;clearTimeout(tmr);tmr=setTimeout(renderPublished,120)};$("#pubMore").onclick=()=>{PUB.all=!PUB.all;renderPublished()}})();
// ---------------------------------------------------------------- tabs
const TABS=["now","swarm","tasks","history","settings","logs"];
function showTab(name){if(name==="console")name="settings";if(!TABS.includes(name))name="now";document.querySelectorAll("#tabs [data-tab]").forEach(b=>b.classList.toggle("on",b.dataset.tab===name));document.querySelectorAll("section[data-tab]").forEach(s=>{const show=s.dataset.tab===name;if(show&&s.hidden){s.hidden=false;s.style.animation="none";void s.offsetWidth;s.style.animation=""}else s.hidden=!show});if(D){if(name==="history")renderHist();if(name==="now")renderPanel();if(name==="swarm"){renderSwarm();renderPublished()}}if(name==="swarm")radarStart();else radarStop();
  try{localStorage.setItem("tab",name)}catch(e){}if(location.hash!=="#/"+name)history.replaceState(null,"","#/"+name);syncScroll()}
document.querySelectorAll("#tabs [data-tab]").forEach(b=>b.onclick=()=>{showTab(b.dataset.tab);if(matchMedia("(max-width:720px)").matches){const t=$("#tabs"),y=t.getBoundingClientRect().top+scrollY;if(scrollY<y-1)scrollTo({top:y,behavior:"smooth"})}});
addEventListener("hashchange",()=>showTab(location.hash.replace(/^#\/?/,"")));
(()=>{let t=location.hash.replace(/^#\/?/,"");if(!t){try{t=localStorage.getItem("tab")||""}catch(e){}}showTab(t||"now")})();

// ---------------------------------------------------------------- the room: caption under the wall, then the wall itself
function renderRunning(){
  const R=D.running||[];const la=D.lastAlive||{};const age=la.ts?Date.now()/1000-la.ts:1e9;
  $("#runInfo").innerHTML=R.length?`<b>${R.length} task${R.length===1?"":"s"} in progress</b> · ${D.claudeProcs??"?"} claude process${D.claudeProcs===1?"":"es"}`:age>300?`<b>No heartbeat for ${dur(age)}</b> · the service may be down or paused`:`<b>Idle</b> · queue empty or guard holding`;
  wallLayout();
}






// ---------------------------------------------------------------- console: service panel + "now" hints on the tier rows
function renderService(){
  const h=D.host||{},w=h.worker||{},e=D.effective||{},v=e.versions||{},u=e.unit||{};const st=(D.guard||{}).state||{};
  const on=w.ActiveState==="active";
  renderUpdates();
  $("#svcState").innerHTML=`<i class="dot ${on?(st.paused?"warn":"on"):"off"}"></i>${w.ActiveState||"?"}${st.paused?" · paused by guard":""} · ${w.NRestarts||0} restarts · since ${(w.ActiveEnterTimestamp||"").replace(/^\w+ /,"").slice(0,16)||"?"}`;
  $("#svcVersions").textContent=`worker ${v.worker||"?"} · Claude Code ${v.claude||"?"} · node ${v.node||"?"} · runtime ${u.runtime||"?"}${u.autoUpdate?" · auto-update":""}`;
  const t=e.tiers||{};const cell=k=>{const x=t[k]||{};return x.model&&!x.optOut?`in force: ${mi(x.model).n} · ${x.effort||"default"}`:`in force: ${x.note||"–"}`};
  $("#ecoNow").textContent=cell("economy");$("#stdNow").textContent=cell("standard");$("#premNow").textContent=cell("premium");
  const L=D.tierLog||{};if(L.pending)say("cfgMsg","config.json was edited after the worker last started: restart to apply","err");
}

// tier counts in the tab strip
function renderTabCounts(){const n=filteredTasks().length;$("#taskCount").textContent=n}

wallInit();panelInit();histInit();radarInit();swarmInit();window.pepe=pepeStart($("#pepe"));doctorStart($("#doc"));  // console: pepe.do("roll"), pepe.list

// ---------------------------------------------------------------- the power pill: stop / restart from the nav, armed then confirmed
function renderPower(){
  const w=((D.host||{}).worker)||{};const st=(D.guard||{}).state||{};const on=w.ActiveState==="active";
  $("#pwDot").className="dot "+(on?(st.paused?"warn":"on"):"off");$("#pwState").textContent=on?(st.paused?"paused":"running"):(w.ActiveState||"stopped");
  const stop=$("#pwStop");if(!stop.classList.contains("armed")&&!stop.classList.contains("busy")){stop.querySelector(".k").textContent=on?"■":"▶";stop.querySelector(".t").textContent=on?"stop":"start";stop.dataset.action=on?"stop":"start";stop.classList.toggle("stop",on)}
}
(()=>{let timer=null;const keys=[$("#pwRestart"),$("#pwStop")];
  const disarm=()=>{keys.forEach(k=>{if(k.classList.contains("armed")){k.classList.remove("armed");k.querySelector(".t").textContent=k.dataset.label||k.querySelector(".t").textContent}});clearTimeout(timer)};
  const fire=async(k,action)=>{k.classList.remove("armed");k.classList.add("busy");k.querySelector(".t").textContent=action+"ing…";$("#pwState").textContent=action+"ing…";
    try{const r=await post("/api/worker",{action});k.classList.remove("busy");k.classList.add("done");k.querySelector(".t").textContent=r.state==="active"?"running":r.state;setTimeout(()=>{k.classList.remove("done");k.querySelector(".t").textContent=k.dataset.label;load(true)},1500)}
    catch(e){k.classList.remove("busy");k.querySelector(".t").textContent="failed";$("#pwState").textContent=e.message.slice(0,40);setTimeout(()=>{k.querySelector(".t").textContent=k.dataset.label;load(true)},2500)}};
  keys.forEach(k=>{k.onclick=e=>{e.stopPropagation();const action=k.dataset.action||"restart";if(k.classList.contains("busy"))return;
    if(k.classList.contains("armed")){disarm();return fire(k,action)}
    disarm();k.dataset.label=k.querySelector(".t").textContent;k.classList.add("armed");k.querySelector(".t").textContent=action+"? click again";timer=setTimeout(disarm,4000)}});
  $("#pwRestart").dataset.action="restart";document.addEventListener("click",disarm);
})();
load().then(()=>{const sp=new URLSearchParams(location.search),o=sp.get("open");if(sp.get("mtab"))mtab=sp.get("mtab");if(o&&D)openTranscript(o)});// every 30 s only the light feed (state, heartbeat, usage, guard, live events); the full 1.7 MB feed every 5 min or when the tab comes back
async function loadLite(){if(!D||document.hidden)return;try{const l=await (await fetch("/api/lite")).json();delete l.lite;if(l.taskSig&&D.taskSig&&l.taskSig!==D.taskSig)return load(false);Object.assign(D,l);render()}catch(e){console.warn("lite refresh failed",e)}}
setInterval(loadLite,30000);setInterval(()=>{if(!document.hidden)load(false)},300000);
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&D&&Date.now()/1000-(D.generatedAt||0)>120)load(false)});
