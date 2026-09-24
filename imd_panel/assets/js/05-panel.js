// ================================================================ the instrument panel: the Now data, drawn like the wall
// One canvas of modules on the same grey wall: a meter for the session window, a lamp matrix for the verdicts,
// LED bars for the top consumers and the host, phosphor readouts for the counters, two scope screens for the
// hourly charts, readouts for the registry and the explorer. Hover a module for its explanation; the bars and
// hours carry their own tooltips; a top consumer opens its transcript.
let PN={canvas:null,ctx:null,tip:null,width:0,height:0,cell:40,mods:[],hits:[],hot:null,dirty:true};
function panelInit(){PN.canvas=$("#panel");if(!PN.canvas)return;PN.ctx=PN.canvas.getContext("2d");PN.tip=$("#ptip");
  new ResizeObserver(()=>{if(D)renderPanel()}).observe(PN.canvas.parentElement);
  PN.canvas.addEventListener("mousemove",panelMove);PN.canvas.addEventListener("mouseleave",()=>{PN.hot=null;PN.tip.classList.remove("on");PN.canvas.style.cursor="";panelDraw()});
  PN.canvas.addEventListener("click",e=>{const h=hitAt(e);if(h&&h.click)h.click()});
}
function hitAt(e){const r=PN.canvas.getBoundingClientRect();const x=e.clientX-r.left,y=e.clientY-r.top;for(let i=PN.hits.length-1;i>=0;i--){const h=PN.hits[i];if(x>=h.x&&x<h.x+h.w&&y>=h.y&&y<h.y+h.h)return h}return null}
function panelMove(e){const h=hitAt(e);if(h!==PN.hot){PN.hot=h;(PN.draw||panelDraw)()}  // each panel redraws itself (the history one is not the Now one)PN.canvas.style.cursor=h&&h.click?"pointer":"";
  if(!h||!h.tip){PN.tip.classList.remove("on");return}
  // the tip is measured after its text is set, then kept inside the panel: clamped sideways, above the module
  // when there is room for it, below otherwise
  PN.tip.innerHTML=h.tip;PN.tip.classList.add("on");const tw=PN.tip.offsetWidth||260,th=PN.tip.offsetHeight||80;
  const below=h.y<th+16&&h.y+h.h+th+16<=PN.height;PN.tip.style.left=Math.max(8+tw/2,Math.min(PN.width-8-tw/2,h.x+h.w/2))+"px";PN.tip.style.top=(below?h.y+h.h+8:Math.max(th+8,h.y-8))+"px";PN.tip.classList.toggle("below",below)}

// ---- layout: rows of modules, each with a fraction of the width; narrow screens stack them
function panelLayout(width){
  const cell=Math.max(30,Math.min(44,width/33));const narrow=width<760,tiny=width<430;
  const rows=[];const row=(items,h)=>rows.push({items,h});
  const A=[["gauge",.25],["lamps",.22],["top",.28],["host",.25]],B=[["k0",1],["k1",1],["k2",1],["k3",1],["k4",1],["k5",1],["k6",1],["k7",1]],C=[["chart1",.5],["chart2",.5]],Dd=[["registry",.3],["seat",.35],["standing",.35]],E=[["network",.5],["earnings",.5]];
  if(tiny){A.forEach(a=>row([[a[0],1]],5));B.forEach(b=>row([[b[0],1]],2.6));C.forEach(c=>row([[c[0],1]],5));Dd.forEach(d=>row([[d[0],1]],4.5));E.forEach(d=>row([[d[0],1]],5))}
  else if(narrow){row(A.slice(0,2).map(a=>[a[0],.5]),5);row(A.slice(2).map(a=>[a[0],.5]),5);for(let i=0;i<8;i+=2)row([[B[i][0],.5],[B[i+1][0],.5]],3);C.forEach(c=>row([[c[0],1]],5.5));row([["registry",.5],["seat",.5]],4.5);row([["standing",1]],4.5);E.forEach(d=>row([[d[0],1]],5))}
  else{row(A,5);row(B,3);row(C,6);row(Dd,4.6);row(E,4.6)}
  const mods=[];let y=0;const gap=2;
  for(const r of rows){let x=0;const tot=r.items.reduce((a,i)=>a+i[1],0);r.items.forEach((it,i)=>{const w=Math.round(width*it[1]/tot);const last=i===r.items.length-1;mods.push({kind:it[0],x:x+gap/2,y:y+gap/2,w:(last?width-x:w)-gap,h:Math.round(r.h*cell)-gap});x+=w});y+=Math.round(r.h*cell)}
  PN.mods=mods;PN.height=y;PN.cell=cell;
}
function renderPanel(){
  renderPanelList();
  if(!PN.canvas||!D)return;const width=PN.canvas.parentElement.clientWidth;if(!width)return;PN.width=width;panelLayout(width);
  const dpr=Math.min(2,devicePixelRatio||1);PN.canvas.width=Math.round(width*dpr);PN.canvas.height=Math.round(PN.height*dpr);PN.canvas.style.height=PN.height+"px";PN.ctx.setTransform(dpr,0,0,dpr,0,0);PN.ctx.lineJoin="round";
  panelDraw();
}
// ---- primitives shared with the wall's look
function plate(ctx,x,y,w,h){ctx.fillStyle=PAL.face;ctx.fillRect(x,y,w,h);ctx.strokeStyle=PAL.stroke;ctx.lineWidth=1.5;ctx.strokeRect(x+.75,y+.75,w-1.5,h-1.5);ctx.lineWidth=1;
  const e=Math.max(1.4,PN.cell*.05),o=e*2.4;ctx.globalAlpha=.55;for(const[cx,cy]of[[x+o,y+o],[x+w-o,y+o],[x+o,y+h-o],[x+w-o,y+h-o]]){ctx.beginPath();ctx.arc(cx,cy,e,0,TAU);ctx.stroke();ctx.beginPath();ctx.moveTo(cx-.7*e,cy+.3*e);ctx.lineTo(cx+.7*e,cy-.3*e);ctx.stroke()}ctx.globalAlpha=1}
function label(ctx,x,y,text,right,col,maxW){ctx.font=`600 ${Math.max(8,PN.cell*.24)}px ${MONO}`;ctx.fillStyle=col||PAL.stroke;ctx.textBaseline="alphabetic";ctx.textAlign=right?"right":"left";ctx.letterSpacing="1.5px";let s=text.toUpperCase();if(maxW){while(s.length>3&&ctx.measureText(s).width>maxW)s=s.slice(0,-2);if(s!==text.toUpperCase())s=s.slice(0,-1)+"…"}ctx.fillText(s,x,y);ctx.letterSpacing="0px";ctx.textAlign="left"}
function screen(ctx,x,y,w,h){ctx.fillStyle=PAL.screen;ctx.fillRect(x,y,w,h);ctx.strokeStyle=PAL.glass;ctx.globalAlpha=.18;ctx.lineWidth=1;ctx.strokeRect(x+1.5,y+1.5,w-3,h-3);ctx.globalAlpha=1}
function glow(ctx,col){ctx.shadowColor=col;ctx.shadowBlur=6}function noglow(ctx){ctx.shadowBlur=0}
function ptext(ctx,x,y,s,size,col,weight,align){ctx.font=`${weight||400} ${size}px ${MONO}`;ctx.fillStyle=col;ctx.textAlign=align||"left";ctx.textBaseline="alphabetic";ctx.fillText(s,x,y);ctx.textAlign="left"}
function ledBar(ctx,x,y,w,h,frac,col,segs){segs=segs||Math.max(6,Math.floor(w/7));const sw=w/segs;ctx.fillStyle="#b9b9b4";ctx.fillRect(x,y,w,h);const on=Math.round(frac*segs);for(let i=0;i<segs;i++){ctx.fillStyle=i<on?col:"#c6c6c1";ctx.fillRect(x+i*sw+1,y+1,Math.max(1,sw-2),h-2)}ctx.strokeStyle=PAL.stroke;ctx.lineWidth=1;ctx.strokeRect(x+.5,y+.5,w-1,h-1)}
const mcol=m=>{const c=mi(m).c;return{"var(--s1)":"#2a78d6","var(--s2)":"#eb6834","var(--s3)":"#7c4dd6","var(--s4)":"#1baf7a","var(--s5)":"#0e8fa3"}[c]||"#9a9a9a"};

function panelDraw(){
  const ctx=PN.ctx;if(!ctx||!PN.mods.length)return;PN.hits=[];
  ctx.fillStyle=PAL.wall;ctx.fillRect(0,0,PN.width,PN.height);
  const kp=counters();
  for(const m of PN.mods){plate(ctx,m.x,m.y,m.w,m.h);const pad=Math.max(8,PN.cell*.3);const b={x:m.x+pad,y:m.y+pad,w:m.w-2*pad,h:m.h-2*pad,ty:m.y+pad+PN.cell*.1};
    const hot=PN.hot&&PN.hot.mod===m;
    if(m.kind==="gauge")modGauge(ctx,m,b);else if(m.kind==="lamps")modLamps(ctx,m,b);else if(m.kind==="top")modTop(ctx,m,b);else if(m.kind==="host")modHost(ctx,m,b);
    else if(m.kind.startsWith("k"))modCounter(ctx,m,b,kp[+m.kind.slice(1)]);else if(m.kind==="chart1")modChart(ctx,m,b,1);else if(m.kind==="chart2")modChart(ctx,m,b,2);
    else if(m.kind==="registry")modRegistry(ctx,m,b);else if(m.kind==="seat")modSeat(ctx,m,b);else if(m.kind==="standing")modStanding(ctx,m,b);else if(m.kind==="network")modNetwork(ctx,m,b);else if(m.kind==="earnings")modEarnings(ctx,m,b);
    if(hot&&PN.hot.mod===m&&PN.hot.whole){ctx.fillStyle="#fff";ctx.globalAlpha=.08;ctx.fillRect(m.x,m.y,m.w,m.h);ctx.globalAlpha=1}}
  ctx.textAlign="left";
}
const modHit=(m,tip)=>PN.hits.push({x:m.x,y:m.y,w:m.w,h:m.h,tip,mod:m,whole:true});
const tipHTML=(title,body)=>`<div class="th"><b>${title}</b></div><div class="tt">${body}</div>`;

// 01 session window: a meter with green / amber / red zones, needle = fresh+output tokens vs the guard threshold
function modGauge(ctx,m,b){
  const U=D.usage||{},fh=U.fiveHour||null,sd=U.sevenDay||null,real=fh&&fh.pct!=null;
  const q=D.quota||{},used=q.used||{},tot=Object.entries(used).filter(([k])=>!["cost","sessions"].includes(k)).reduce((a,[,v])=>a+v,0);
  const g=((D.guard||{}).config)||{},now=Date.now()/1000;
  const pct=real?fh.pct/100:Math.min(1,tot/(g.windowTokens||4e6));const left=real&&fh.resetsAt?fh.resetsAt-now:(q.windowStart!=null?q.windowEnd-now:0);
  label(ctx,b.x,b.ty+2,"01 · claude 5h window");label(ctx,b.x+b.w,b.ty+2,real?(left>0?"resets in "+dur(left):"resetting"):"estimate",true);
  const fh_=b.h*.5,fy=b.ty+PN.cell*.35,fw=Math.min(b.w,fh_*2.3),fx=b.x+(b.w-fw)/2;
  ctx.fillStyle="#f3f0e4";ctx.fillRect(fx,fy,fw,fh_);ctx.strokeStyle=PAL.stroke;ctx.strokeRect(fx+.5,fy+.5,fw-1,fh_-1);
  const px=fx+fw/2,py=fy+fh_*.92,R=Math.min(fh_*.82,fw*.46);const a0=Math.PI*.85,a1=Math.PI*.15;const ang=f=>a0-(a0-a1)*f;
  const band=(f0,f1,col)=>{ctx.beginPath();ctx.arc(px,py,R*.97,-ang(f0),-ang(f1));ctx.strokeStyle=col;ctx.lineWidth=Math.max(4,R*.09);ctx.stroke()};
  band(0,.7,"#3ecf7a");band(.7,.9,"#e0a92a");band(.9,1,"#b3261e");ctx.lineWidth=1;ctx.strokeStyle=PAL.stroke;
  for(let i=0;i<=10;i++){const a=ang(i/10);const r0=R*(i%5?.84:.78);ctx.beginPath();ctx.moveTo(px+Math.cos(a)*r0,py-Math.sin(a)*r0);ctx.lineTo(px+Math.cos(a)*R*.9,py-Math.sin(a)*R*.9);ctx.stroke()}
  ptext(ctx,px,fy+fh_*.5,real?"% OF PLAN · 5H":"TOKENS · 5H",Math.max(7,R*.11),PAL.stroke,600,"center");
  const a=ang(pct);ctx.strokeStyle="#b3261e";ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(px,py);ctx.lineTo(px+Math.cos(a)*R*.92,py-Math.sin(a)*R*.92);ctx.stroke();ctx.lineWidth=1;ctx.fillStyle=PAL.stroke;ctx.beginPath();ctx.arc(px,py,3,0,TAU);ctx.fill();
  const sy=fy+fh_+PN.cell*.2,sh=b.y+b.h-sy;
  if(sh>14){screen(ctx,b.x,sy,b.w,sh);const fs=Math.min(sh*.42,b.w*.09);const col=pct>.9?PAL.bad:pct>.7?PAL.amber:PAL.lamp;
    glow(ctx,col);ptext(ctx,b.x+10,sy+fs*1.15,real?`${Math.round(fh.pct)}%`:fmt(tot),fs,col,700);noglow(ctx);
    ptext(ctx,b.x+b.w-10,sy+fs*1.1,real?`5h · resets ${hm(fh.resetsAt)} UTC`:`${Math.round(pct*100)}% of ${fmt(g.windowTokens||4e6)} (estimate)`,Math.max(8,fs*.42),PAL.phosDim,400,"right");
    if(sd&&sd.pct!=null){const bh=Math.max(6,Math.min(9,sh*.14)),by=sy+sh-bh-7;const wcol=sd.pct>=90?PAL.bad:sd.pct>=70?PAL.amber:PAL.lamp;const ws=Math.max(7,bh*.95);
      ptext(ctx,b.x+10,by+bh-1,"WEEK",ws,PAL.phosDim,600);const pr=weekPace(sd);const txt=pr?`${Math.round(sd.pct)}% · ${pr.text}`:`${Math.round(sd.pct)}% · resets ${sd.resetsAt?dt(sd.resetsAt):"?"}`;ctx.font=`${ws}px ${MONO}`;const tw=ctx.measureText(txt).width;
      const bx=b.x+10+ws*3.4,bw=Math.max(20,b.w-20-ws*3.4-tw-8);ctx.fillStyle="#1d2a21";ctx.fillRect(bx,by,bw,bh);ctx.fillStyle=wcol;glow(ctx,wcol);ctx.fillRect(bx,by,bw*Math.min(1,sd.pct/100),bh);noglow(ctx);
      ptext(ctx,b.x+b.w-10,by+bh-1,txt,ws,PAL.phosDim,400,"right")}}
  const lm=(D.limitMsgs||[])[D.limitMsgs.length-1];const st=(D.guard||{}).state||{};
  modHit(m,tipHTML("Claude 5-hour window",`${real?`What Claude itself reports for this account (the same numbers as <code>/usage</code>): 5-hour window at <b>${Math.round(fh.pct)}%</b>, resets ${hm(fh.resetsAt)} UTC; week at <b>${sd?Math.round(sd.pct):"?"}%</b>, resets ${sd&&sd.resetsAt?dt(sd.resetsAt):"?"} UTC. Fetched ${U.fetchedAt?dur(now-U.fetchedAt)+" ago":"–"}.`:`Claude's own numbers are unavailable${U.error?" ("+esc(U.error)+")":""}; this is the local estimate.`} Our own count for this window: ${fmt(tot)} fresh+output tokens · ${usd(used.cost)} · ${used.sessions||0} sessions. Guard ${g.enabled?`<b>on</b> (${g.sessionPct?"5h ≥ "+g.sessionPct+"%":""}${g.weeklyPct?" · week ≥ "+g.weeklyPct+"%":""}${g.windowTokens?" · "+fmt(g.windowTokens)+" tokens":""}${g.windowCost?" · "+usd(g.windowCost):""})`:"<b>off</b>"}${st.paused?` — paused since ${hm(st.pausedAt)}`:""}. Last limit hit: ${lm?dt(lm.ts):"never"}.`));
}
// 02 verdict lamps: one square lamp per submitted task in range, oldest first
function modLamps(ctx,m,b){
  const T=inRange().filter(t=>t.status!=="no-journal"&&t.submittedAt).sort((a,c)=>a.acceptedAt-c.acceptedAt);
  const acc=T.filter(t=>t.verdict==="accepted").length,rej=T.filter(t=>isBad(t.verdict)).length,closed=T.filter(t=>isClosed(t.verdict)).length,pend=T.length-acc-rej-closed,n=acc+rej,p=n?Math.round(acc/n*100):0;
  label(ctx,b.x,b.ty+2,"02 · verdicts");label(ctx,b.x+b.w,b.ty+2,n?p+"% accepted":"nothing judged",true);
  const gy=b.ty+PN.cell*.35,gh=b.h*.56;const J=T.slice(-120);const per=Math.max(6,Math.ceil(Math.sqrt(J.length*b.w/gh)||1));const s=Math.min(b.w/per,gh/Math.max(1,Math.ceil(J.length/per)));const sz=Math.max(6,Math.min(18,s));const cols=Math.max(1,Math.floor(b.w/sz));
  J.forEach((t,i)=>{const x=b.x+(i%cols)*sz,y=gy+Math.floor(i/cols)*sz;if(y+sz>gy+gh+2)return;const st=t.verdict==="accepted"?"ok":isBad(t.verdict)?"bad":isClosed(t.verdict)?"off":"pend";
    ctx.fillStyle=st==="ok"?PAL.lamp:st==="bad"?"#ff5a50":st==="off"?"#3a3a36":"#ffcf5a";if(st==="ok"||st==="bad")glow(ctx,ctx.fillStyle);ctx.fillRect(x+1.5,y+1.5,sz-3,sz-3);noglow(ctx);ctx.strokeStyle=st==="ok"?"#0f5a30":st==="bad"?"#5a1410":st==="off"?"#222":"#6b5010";ctx.strokeRect(x+1.5,y+1.5,sz-3,sz-3);
    PN.hits.push({x,y,w:sz,h:sz,mod:m,tip:tipHTML(t.id,`${vlabel(t.verdict||"pending")}${t.reason&&t.reason.reason?" · "+esc(t.reason.reason):""}<br>${t.model?mi(t.model).n:""} · ${t.tier||"?"} · ${usd(t.costUSD)}`),click:()=>openTranscript(t.id)})});
  const sy=gy+gh+PN.cell*.2,sh=b.y+b.h-sy;if(sh>14){screen(ctx,b.x,sy,b.w,sh);const fs=Math.min(sh*.5,b.w*.1);glow(ctx,PAL.lamp);ptext(ctx,b.x+10,sy+sh/2+fs*.36,`${acc}`,fs,PAL.lamp,700);noglow(ctx);const w1=ctx.measureText(`${acc}`).width;ptext(ctx,b.x+10+w1+4,sy+sh/2+fs*.36,"✓",fs*.6,PAL.phosDim);
    glow(ctx,PAL.bad);ptext(ctx,b.x+10+w1+fs*.9,sy+sh/2+fs*.36,`${rej}`,fs,rej?PAL.bad:PAL.phosDim,700);noglow(ctx);const w2=ctx.measureText(`${rej}`).width;ptext(ctx,b.x+10+w1+fs*.9+w2+4,sy+sh/2+fs*.36,"✗",fs*.6,PAL.phosDim);ptext(ctx,b.x+b.w-10,sy+sh/2+fs*.3,`${pend} pending${closed?" · "+closed+" closed":""}`,Math.max(8,fs*.45),PAL.amber,400,"right")}
  const A=D.acceptance||{};const keys=Object.keys(A).filter(k=>k.startsWith("tier:")).sort((a,c)=>tierRank(a)-tierRank(c));
  PN.hits.unshift({x:m.x,y:m.y,w:m.w,h:m.h,mod:m,whole:true,tip:tipHTML("What the lamps mean",`One square per submitted task in range, oldest first. Green: accepted. Red: rejected. Amber: not judged yet. Hover a lamp for the task, click to open it. Explorer totals: ${keys.map(k=>{const v=A[k];const mm=(v.accepted||0)+(v.rejected||0);return`${k.slice(5)} ${v.accepted||0}✓ ${v.rejected||0}✗${mm?` (${Math.round((v.accepted||0)/mm*100)}%)`:""}`}).join(" · ")||"–"}.`)});
}
// 03 top consumers: LED bars per task, click to open
function modTop(ctx,m,b){
  const T=inRange().filter(t=>t.status!=="no-journal").sort((a,c)=>c.costUSD-a.costUSD).slice(0,8);const max=Math.max(1e-9,...T.map(t=>t.costUSD));
  label(ctx,b.x,b.ty+2,"03 · top consumers");label(ctx,b.x+b.w,b.ty+2,T.length?"in range":"no tasks",true);
  const y0=b.ty+PN.cell*.35,rh=Math.min(PN.cell*.5,(b.y+b.h-y0)/Math.max(1,T.length));const fs=Math.max(8,Math.min(11,rh*.5));ctx.font=`${fs}px ${MONO}`;const idw=ctx.measureText("00000000").width+8,valw=Math.max(...T.map(t=>ctx.measureText(`${usd(t.costUSD)} · ${fmt(t.usage.output_tokens||0)} out`).width),0)+12;  // the real labels, not a template: "$15.93 · 936.5k out" is wider than "$0.00 · 00.0k out"
  T.forEach((t,i)=>{const y=y0+i*rh;const hot=PN.hot&&PN.hot.task===t;ptext(ctx,b.x,y+rh*.68,t.id,fs,hot?"#000":PAL.stroke,hot?700:400);ledBar(ctx,b.x+idw,y+rh*.2,Math.max(10,b.w-idw-valw),rh*.6,t.costUSD/max,mcol(t.model));ptext(ctx,b.x+b.w,y+rh*.68,`${usd(t.costUSD)} · ${fmt(t.usage.output_tokens||0)} out`,fs,PAL.stroke,400,"right");
    PN.hits.push({x:b.x,y,w:b.w,h:rh,mod:m,task:t,tip:tipHTML(t.id,`${esc((t.title||"").slice(0,120))}<br>${t.model?mi(t.model).n+(t.effort?" · "+t.effort:""):""} · ${t.tier||"?"} · ${t.turns} turns · ${fmt((t.usage||{}).output_tokens||0)} out · ${usd(t.costUSD)} · click to open`),click:()=>openTranscript(t.id)})});
  if(!T.length)ptext(ctx,b.x,y0+20,"no tasks in range",10,PAL.stroke);
  PN.hits.unshift({x:m.x,y:m.y,w:m.w,h:m.h,mod:m,whole:true,tip:tipHTML("Top consumers","The most expensive tasks in range, bar = API-equivalent cost, colour = model. Click one to read its prompt and transcript.")});
}
// 04 the room: host meters
function modHost(ctx,m,b){
  const h=D.host||{},w=h.worker||{},t=h.timer||{};const memUsed=h.mem?h.mem.total-h.mem.available:0;const wm=+w.MemoryCurrent||0,wmax=+w.MemoryMax||0;const load=(h.load||[0])[0],cpus=h.cpus||1;
  label(ctx,b.x,b.ty+2,"04 · the room");label(ctx,b.x+b.w,b.ty+2,`${w.ActiveState||"?"} · v${h.version||"?"}`,true);
  const rows=[["host memory",h.mem?memUsed/h.mem.total:0,`${gb(memUsed)} / ${gb(h.mem&&h.mem.total)}`],["worker memory",wmax?wm/wmax:0,`${mb(wm)} / ${wmax?mb(wmax):"∞"}`],["disk /",h.disk?1-h.disk.free/h.disk.total:0,`${gb(h.disk&&h.disk.free)} free`],["load",Math.min(1,load/cpus),`${(h.load||[]).map(x=>x.toFixed(2)).join(" ")} · ${cpus} cpu`]];
  const y0=b.ty+PN.cell*.4,rh=(b.y+b.h-y0)/rows.length;const fs=Math.max(8,Math.min(11,rh*.32));ctx.font=`${fs}px ${MONO}`;const lw=ctx.measureText("worker memory").width+8;
  rows.forEach(([l,f,v],i)=>{const y=y0+i*rh;ptext(ctx,b.x,y+rh*.35,l,fs,PAL.stroke);const col=f>.9?"#ff5a50":f>.7?"#ffcf5a":PAL.lamp;ledBar(ctx,b.x+lw,y+rh*.12,b.w-lw,rh*.36,f,col);ptext(ctx,b.x+b.w,y+rh*.82,v,fs*.95,PAL.stroke,400,"right")});
  modHit(m,tipHTML("The room",`Memory, disk and load of the machine, and the worker's own footprint. Worker up since ${(w.ActiveEnterTimestamp||"").replace(/^\w+ /,"").slice(0,16)||"?"} · ${w.NRestarts||0} restarts · ${dur((+w.CPUUsageNSec||0)/1e9)} CPU · host up ${dur(h.uptimeS||0)}. Work dirs ${h.workDirs??"–"} (${mb(h.workBytes)}, pruned after 3 d) · transcripts ${h.transcriptDirs??"–"} (${mb(h.transcriptBytes)}, 14 d) · cleanup timer ${t.ActiveState||"?"}, next ${(t.NextElapseUSecRealtime||"?").slice(4,20)}.`));
}
// counters: eight phosphor readouts
function counters(){
  const T=inRange(),s=since();const sum=f=>T.reduce((a,t)=>a+f(t),0);
  const out=sum(t=>t.usage.output_tokens||0),fresh=sum(t=>(t.usage.input_tokens||0)+(t.usage.cache_creation_input_tokens||0)),cost=sum(t=>t.costUSD),opusCost=sum(t=>(t.model||"").startsWith("claude-opus-")?t.costUSD:0);
  const acc=T.filter(t=>t.status!=="no-journal").length,sub=T.filter(t=>t.submittedAt).length,rl=T.filter(t=>t.status==="rate-limited").length,hits=D.limitMsgs.filter(l=>l.ts>=s).reduce((a,l)=>a+l.hits,0);
  $("#rangeInfo").textContent=`${T.length} tasks · journal since ${D.journalFrom?dt(D.journalFrom):"?"} UTC`;
  return[["accepted",acc,`${T.filter(t=>t.status==="no-journal").length} untracked`,"","Tasks the network handed to this node in the selected range."],["submitted",sub,acc?Math.round(sub/acc*100)+"% of accepted":"","","Tasks that reached a submission (the rest were released or failed)."],
    ["released",rl,(()=>{const w=T.filter(t=>t.status==="rate-limited"&&(t.turns||0)>0);const c=w.reduce((a,t)=>a+(t.costUSD||0),0),tu=w.reduce((a,t)=>a+(t.turns||0),0);return w.length?`${usd(c)} · ${tu} turns lost`:""})(),rl?"alarm":"","Tasks given back to the network because Claude's session limit was hit. The line below is the work that went with them: turns and API-equivalent cost of released tasks that had already started (nothing is delivered on a release)."],["limit errors",hits,`${D.episodes.filter(e=>e.start>=s).length} episodes`,hits?"alarm":"","Claude 'session limit' errors seen in the transcripts."],
    ["output tokens",fmt(out),`${fmt(sum(t=>t.thinking))} thinking`,"","Tokens the model generated, thinking included."],["fresh input",fmt(fresh),`${fmt(sum(t=>t.usage.cache_read_input_tokens||0))} cache reads`,"","Uncached input + cache writes: what burns the quota. Cache reads are cheap."],
    ["api cost",usd(cost),`${cost?Math.round(opusCost/cost*100):0}% on Opus`,"amber","Claude Code's API-equivalent estimate, not what the subscription charges."],["turns",fmt(sum(t=>t.turns)),acc?`avg ${Math.round(sum(t=>t.turns)/T.length)} / task`:"","","Agent turns used, all tasks in range."]];
}
function modCounter(ctx,m,b,k){
  const[l,v,s,cls,why]=k;const i=PN.mods.filter(x=>x.kind.startsWith("k")).indexOf(m)+1;
  label(ctx,b.x,b.ty+2,`${pad(i)} · ${l}`,false,null,b.w);
  const sy=b.ty+PN.cell*.3,sh=b.y+b.h-sy;screen(ctx,b.x,sy,b.w,sh);const fs=Math.min(sh*.55,b.w/Math.max(4,String(v).length)*1.5);const col=cls==="alarm"?PAL.bad:cls==="amber"?PAL.amber:PAL.lamp;
  glow(ctx,col);ptext(ctx,b.x+b.w/2,sy+sh*.5+fs*.3,String(v),fs,col,700,"center");noglow(ctx);
  if(s)ptext(ctx,b.x+b.w/2,sy+sh-6,s,Math.max(8,Math.min(10,fs*.35)),PAL.phosDim,400,"center");
  modHit(m,tipHTML(l,why));
}
// scope screens: the two hourly charts on phosphor
function modChart(ctx,m,b,which){
  const H=hours();label(ctx,b.x,b.ty+2,which===1?"tokens per hour, by model":"tasks per hour");
  const sy=b.ty+PN.cell*.3,sh=b.y+b.h-sy;screen(ctx,b.x,sy,b.w,sh);
  const models=["claude-opus-5-5","claude-opus-5","claude-sonnet-5","claude-fable-5-1"];const others=new Set();D.hourly.forEach(h=>Object.keys(h.models).forEach(mm=>{if(!models.includes(mm)&&mm!=="unknown")others.add(mm)}));
  const series=which===1?models.map(mm=>({name:mi(mm).n,col:mcol(mm),val:h=>mv(h,mm,"fresh")+mv(h,mm,"output")})).concat(others.size?[{name:"other",col:"#1baf7a",val:h=>[...others].reduce((a,mm)=>a+mv(h,mm,"fresh")+mv(h,mm,"output"),0)}]:[])
    :[{name:"submitted",col:PAL.lamp,val:h=>h.submitted},{name:"accepted, not submitted",col:PAL.phosDim,val:h=>Math.max(0,h.accepted-h.submitted-h.rateLimited)},{name:"released",col:"#ff5a50",val:h=>h.rateLimited}];
  const L=b.x+36,R=b.x+b.w-8,T=sy+22,B=sy+sh-22,pw=R-L,ph=B-T;if(!H.length||pw<40||ph<20){ptext(ctx,b.x+b.w/2,sy+sh/2,"no data in range",10,PAL.phosDim,400,"center");return}
  const tot=H.map(h=>series.reduce((a,s)=>a+s.val(h),0)),max=Math.max(1,...tot);
  ctx.strokeStyle=PAL.glass;ctx.globalAlpha=.22;ctx.lineWidth=1;for(let i=0;i<=4;i++){const y=T+ph-ph*i/4;ctx.beginPath();ctx.moveTo(L,y);ctx.lineTo(R,y);ctx.stroke();ctx.globalAlpha=.9;ptext(ctx,L-4,y+3,which===1?fmt(max*i/4):String(Math.round(max*i/4)),8,PAL.phosDim,400,"right");ctx.globalAlpha=.22}ctx.globalAlpha=1;
  const bw=pw/H.length,gap=Math.min(2,bw*.15);
  H.forEach((h,i)=>{let y=T+ph;const x=L+i*bw+gap/2,w=Math.max(1,bw-gap);series.forEach(s=>{const v=s.val(h);if(!v)return;const hh=ph*v/max;y-=hh;ctx.fillStyle=s.col;glow(ctx,s.col);ctx.fillRect(x,y,w,Math.max(1,hh-1));noglow(ctx)});
    if(which===1&&(h.rateLimited||h.limitHits)){ctx.fillStyle="#ff5a50";ctx.beginPath();ctx.moveTo(x+w/2-4,T-8);ctx.lineTo(x+w/2+4,T-8);ctx.lineTo(x+w/2,T-1);ctx.fill()}
    const rows=which===1?Object.entries(h.models).filter(([mm])=>mm!=="unknown").map(([mm,c])=>`${mi(mm).n}: <b>${fmt(c.fresh+c.output)}</b> (out ${fmt(c.output)}, fresh ${fmt(c.fresh)}, cache-read ${fmt(c.cacheRead)}) · ${c.sessions} sess · ${usd(c.cost)}`).join("<br>")||"no sessions":`accepted ${h.accepted} · submitted ${h.submitted} · released ${h.rateLimited}`;
    PN.hits.push({x:L+i*bw,y:T,w:bw,h:ph,mod:m,tip:tipHTML(`${dt(h.ts)} UTC`,rows+((h.rateLimited||h.limitHits)?`<br><span style="color:#ff6b62">▼ ${h.rateLimited} releases · ${h.limitHits} session-limit errors</span>`:""))})});
  const step=Math.ceil(H.length/Math.max(4,Math.floor(pw/60)));H.forEach((h,i)=>{if(i%step)return;const d=new Date(h.ts*1000);ptext(ctx,L+i*bw+bw/2,B+12,`${pad(d.getUTCHours())}:00`,8,PAL.phosDim,400,"center")});
  let lx=L;series.forEach(s=>{ctx.fillStyle=s.col;ctx.fillRect(lx,T-13,8,8);ptext(ctx,lx+11,T-6,s.name,8,PAL.phosDim);lx+=11+ctx.measureText(s.name).width+12});
  if(which===1){ctx.fillStyle="#ff5a50";ctx.beginPath();ctx.moveTo(lx,T-13);ctx.lineTo(lx+8,T-13);ctx.lineTo(lx+4,T-5);ctx.fill();ptext(ctx,lx+11,T-6,"rate-limit hit",8,PAL.phosDim)}
  PN.hits.unshift({x:m.x,y:m.y,w:m.w,h:m.h,mod:m,whole:true,tip:tipHTML(which===1?"Tokens per hour, by model":"Tasks per hour",which===1?"Fresh input (uncached + cache writes) plus output: the tokens that burn quota. Hover an hour for the split; a red tick marks a rate-limit hit.":"Accepted, submitted, and released back to the network because of a rate limit. Hover an hour for the numbers.")});
}
// registry + explorer readouts
function modRegistry(ctx,m,b){
  const R=D.registry||{},bt=R.batches||{},en=R.entries||{},tot=D.totals||{};const link=$("#scanLink");if(R.url){link.href=R.url;link.textContent=`registry #${R.agentId} ↗`}
  label(ctx,b.x,b.ty+2,"05 · the registry");label(ctx,b.x+b.w,b.ty+2,R.agentId?`${R.active?"active":"inactive"}${R.error?" · stale":""}`:"n/a",true);
  const sy=b.ty+PN.cell*.3,sh=b.y+b.h-sy;screen(ctx,b.x,sy,b.w,sh);
  if(R.agentId){const pos=en.count?Math.round(100*(en.positive||0)/en.count):null;
    const lines=[`${bt.sent||0} sent · ${(bt.queued||0)+(bt.submitted||0)} queued · ${bt.failed||0} failed`,`${en.count||0} feedbacks · ${pos==null?"–":pos+"%"} positive`,`${tot.onchain||0} tasks on chain · ${tot.recordsSent||0} records`];const fs2=Math.max(8,Math.min(10,sh*.11));
    // the counter takes what is left once the three lines on the right have their room, so it never runs under them
    ctx.font=`${fs2}px ${MONO}`;const lw=Math.max(...lines.map(l=>ctx.measureText(l).width));const score=String(bt.sent||0);ctx.font=`700 10px ${MONO}`;const per=ctx.measureText(score).width/10;
    const fs=Math.max(14,Math.min(sh*.42,(b.w-lw-34)/per));glow(ctx,PAL.lamp);ptext(ctx,b.x+12,sy+sh*.5+fs*.2,score,fs,PAL.lamp,700);noglow(ctx);ptext(ctx,b.x+12,sy+sh*.5+fs*.2+14,"BATCHES SENT"+(R.lastSentAt?" · "+ago(R.lastSentAt):""),8,PAL.phosDim);
    lines.forEach((l,i)=>ptext(ctx,b.x+b.w-10,sy+sh*.32+i*fs2*1.5,l,fs2,PAL.phos,400,"right"))}
  else ptext(ctx,b.x+b.w/2,sy+sh/2,R.error?"registry data not available":"loading registry…",10,PAL.phosDim,400,"center");
  const tags=Object.entries(en.byTag||{}).map(([k,v])=>`${esc(k)} ${v}`).join(" · ");
  modHit(m,tipHTML("The registry",`ERC-8004 agent ${R.agentId||"?"} (${esc(R.name||"")}) on chain ${R.chainId||1}. Feedback batches written to the reputation registry ${R.workRegistry?esc(R.workRegistry.slice(0,10))+"…":""} that mention this seat: ${bt.total||0} (${bt.sent||0} sent, ${(bt.queued||0)+(bt.submitted||0)} queued). ${tags?"Entries: "+tags+".":""} ${R.lastTxUrl?`Last tx: <a class="ext" href="${safeUrl(R.lastTxUrl)}" target="_blank" rel="noopener">${esc((R.lastTx||"").slice(0,12))}…</a>.`:""} Feed scanned: ${R.feedScanned||0} batches back to ${R.feedOldest?esc(R.feedOldest.slice(0,16)):"–"}. Source: api.imd.fun /feedback/batches + /jobs/:id/records.${R.error?` <span style="color:#ff6b62">stale: ${esc(R.error)}</span>`:""}`));
}
// key/value rows on a phosphor screen; returns the row height so callers can register hits
function srows(ctx,b,sy,sh,rows,kw){const fs=Math.max(8,Math.min(11.5,sh/(rows.length+1.2)*.62));const rh=Math.min(fs*1.65,(sh-8)/rows.length);kw=kw||fs*7.2;
  rows.forEach((r,i)=>{const y=sy+8+rh*(i+1)-rh*.3;ptext(ctx,b.x+10,y,r[0],fs*.85,PAL.phosDim);let v=String(r[1]);ctx.font=`${fs}px ${MONO}`;const maxw=b.w-20-kw;while(v.length>4&&ctx.measureText(v).width>maxw)v=v.slice(0,-2);ptext(ctx,b.x+10+kw,y,v,fs,r[2]||PAL.phos)});return{fs,rh}}
function lampDot(ctx,x,y,r,col,on){ctx.beginPath();ctx.arc(x,y,r,0,TAU);ctx.fillStyle=on?col:"#2a2a28";if(on)glow(ctx,col);ctx.fill();noglow(ctx);ctx.strokeStyle="#000";ctx.lineWidth=1;ctx.stroke()}
const ago=iso=>{if(!iso)return"–";const d=(Date.now()-Date.parse(String(iso).replace(" ","T").replace(/\+00$/,"Z")))/1000;return isFinite(d)?(d<0?"now":dur(d)+" ago"):"–"};
// 06 the seat: what api.imd.fun/seats/:tokenId records for this seat
function modSeat(ctx,m,b){
  const S=D.seat||{},r=S.record||{},rv=S.reviews||{},roles=S.roles||{};const ex=D.explorer||{};
  label(ctx,b.x,b.ty+2,"06 · the seat");label(ctx,b.x+b.w,b.ty+2,S.tokenId?`#${S.tokenId} · ${S.online?"online":"offline"}${S.error?" · stale":""}`:"n/a",true);
  const sy=b.ty+PN.cell*.3,sh=b.y+b.h-sy;screen(ctx,b.x,sy,b.w,sh);
  if(S.tokenId){const rows=[["record",`${r.accepted??"–"} ✓ · ${r.rejected??"–"} ✗ · ${r.failed??0} failed · ${r.pending??"–"} pending · ${r.attempts??"–"} attempts`],
    ["onchain",`${rv.sent||0} reviews sent · ${rv.queued||0} queued · ${rv.submitted||0} submitted`],
    ["roles",Object.entries(roles).sort((a,c)=>c[1]-a[1]).map(([k,v])=>`${k} ${v}`).join(" · ")||"–"],
    ["crew",`${S.collaborators??0} collaborators${(S.topCollaborators||[]).length?` · most with #${S.topCollaborators[0].tokenId} (${S.topCollaborators[0].sharedJobs} jobs)`:""}`],
    ["daemon",`${S.daemonVersion||"?"} · ${(S.runtime||"").replace(/ \(Claude Code\)/,"")}${S.premiumModel?` · premium ${mi(S.premiumModel.model).n} ${S.premiumModel.effort}`:""}`],
    ["last ✓",ago(S.lastAcceptedAt)]];srows(ctx,b,sy,sh,rows)}
  else ptext(ctx,b.x+b.w/2,sy+sh/2,esc(S.error||"seat data not available"),10,PAL.phosDim,400,"center");
  PN.hits.push({x:m.x,y:m.y,w:m.w,h:m.h,mod:m,whole:true,tip:tipHTML("The seat",`The control plane's own record of seat #${S.tokenId||"?"} (agent ${S.agentId||"?"}, ${S.ownership||""} by ${esc((S.owner||"").slice(0,10))}…): every submission with its verdict, the reviews written to the reputation registry (sent = on chain with a tx, queued = waiting for the next batch), and the seats you shared jobs with. Source: api.imd.fun/seats/${S.tokenId||""}. Click to open the agent page on the explorer.${S.error?` <span style="color:#ff6b62">stale: ${esc(S.error)}</span>`:""}`),click:()=>{if(ex.agentUrl)window.open(ex.agentUrl,"_blank","noopener")}});
}
// 07 standing: presence, breaker and dispatch eligibility as the network sees them
function modStanding(ctx,m,b){
  const G=D.standing||{},p=G.presence||{},st=G.standing||{},q=G.queue||{},br=st.breaker||{};const paused=st.pausedUntil&&Date.parse(st.pausedUntil)>Date.now();
  const okAll=p.connected&&p.acceptingWork&&!paused&&!p.stale;
  label(ctx,b.x,b.ty+2,"07 · standing");label(ctx,b.x+b.w,b.ty+2,G.at?(paused?"dispatch paused":okAll?"eligible":p.connected?"connected":"not connected")+(G.error?" · stale":""):"n/a",true,paused?"#a02020":null);
  const sy=b.ty+PN.cell*.3,sh=b.y+b.h-sy;screen(ctx,b.x,sy,b.w,sh);
  if(!G.at){ptext(ctx,b.x+b.w/2,sy+sh/2,esc(G.error||"standing not available"),10,PAL.phosDim,400,"center")}
  else{const lamps=[["connected",!!p.connected,PAL.lamp],["accepting",!!p.acceptingWork,PAL.lamp],["breaker",!paused,paused?"#ff5a50":PAL.lamp],["fresh",!p.stale,p.stale?"#ffcf5a":PAL.lamp]];
    const lw=b.w/lamps.length,ly=sy+14,fs=Math.max(8,Math.min(10,lw*.12));lamps.forEach(([l,on,col],i)=>{const x=b.x+lw*i+10;lampDot(ctx,x+5,ly,5,col,on||l==="breaker"&&paused||l==="fresh"&&p.stale);ptext(ctx,x+16,ly+3.5,l,fs,on?PAL.phos:PAL.phosDim)});
    const fails=st.consecutiveFailures||0,rf=(st.recentFailures||[])[0];
    const rows=[["heartbeat",`${ago(p.lastHeartbeatAt)} · connected ${ago(p.connectedAt)} · concurrency ${p.maxConcurrency??"?"}`],
      ["breaker",`${fails} / ${br.failures??"?"} consecutive failures · cooldown ${Math.round((br.cooldownMs||0)/60000)} min${paused?` · PAUSED until ${String(st.pausedUntil).replace("T"," ").slice(0,16)}`:""}`,paused?"#ff6b62":fails?"#ffcf5a":null],
      ["queue",`${q.ready??"–"} ready · ${q.eligible??"–"} eligible for you · fleet ${q.fleetOnline??"–"} online${(q.blocked||[]).length?` · blocked: ${q.blocked.map(x=>typeof x==="string"?x:JSON.stringify(x)).join(", ")}`:""}`],
      ["running",`${st.working??0} on the server's side${(st.running||[]).length?" · "+st.running.map(x=>String(x.jobId||x).slice(0,8)).join(", "):""}`],
      ["last fail",rf?`${rf.reason||"?"} · ${rf.nodeKey||""} · ${ago(rf.at)}`:"none recorded","#ffcf5a"]];
    const bb={x:b.x,w:b.w};srows(ctx,bb,sy+18,sh-18,rows.map(r=>[r[0],r[1],r[2]||(rf&&r[0]==="last fail"?"#ffcf5a":undefined)]))}
  PN.hits.push({x:m.x,y:m.y,w:m.w,h:m.h,mod:m,whole:true,tip:tipHTML("Standing",`How the network sees this seat right now (api.imd.fun/seats/${(D.seat||{}).tokenId||""}/standing): presence and heartbeat, whether it is accepting work, the failure breaker (${br.failures??"?"} consecutive failures pause dispatch for ${Math.round((br.cooldownMs||0)/60000)} min), the queue it could be assigned from, and the last failure the server recorded. An idle worker with 0 ready and 0 eligible is waiting for work, not broken.${G.error?` <span style="color:#ff6b62">stale: ${esc(G.error)}</span>`:""}`),click:()=>{if(G.url)window.open(G.url,"_blank","noopener")}});
}
// 08 the network: control-plane health plus our place among the contributors
function modNetwork(ctx,m,b){
  const N=D.network||{},pd=N.pending||{},sv=N.services||{},pay=N.payments||{},F=D.fleet||{},o=F.ours||{},md=F.median||{};const act=(D.explorer||{}).activity||{};
  label(ctx,b.x,b.ty+2,"08 · the network");label(ctx,b.x+b.w,b.ty+2,N.status?`${N.status} · ${N.connectedDaemons??"?"} daemons${N.error?" · stale":""}`:"n/a",true);
  const sy=b.ty+PN.cell*.3,sh=b.y+b.h-sy;screen(ctx,b.x,sy,b.w,sh);
  if(!N.status){ptext(ctx,b.x+b.w/2,sy+sh/2,esc(N.error||"network data not available"),10,PAL.phosDim,400,"center")}
  else{const down=Object.entries(sv).filter(([k,v])=>v===false).map(([k])=>k);const pend=Object.entries(pd).filter(([k,v])=>v).map(([k,v])=>`${k} ${v}`).join(" · ");
    const cmp=(a,c,inv)=>a==null||c==null?"":a===c?"=":(inv?a<c:a>c)?"▲":"▼";
    const rows=[["fleet",`${N.connectedDaemons??"–"} online · ${N.activeEnrollments??"–"} enrolled · ${N.workingNow??"–"} working now · ${N.acceptedLastDay??"–"} accepted last day`],
      ["services",`${down.length?"DOWN: "+down.join(", "):(N.servicesDetail||[]).length?N.servicesDetail.map(s=>`${s.kind}${s.up===false?" DOWN":""} ${(s.version||"").replace(/^0\.1\.0\+/,"")}`).join(" · "):"verifier · publisher · deployer up"}${N.deployBreaker?" · deploy breaker "+N.deployBreaker:""}${(N.servicesDetail||[]).some(s=>s.up===false)?"":""}`,down.length||(N.servicesDetail||[]).some(s=>s.up===false)?"#ff6b62":null],
      ["build",`control plane ${(N.build||{}).commit?N.build.commit.slice(0,8):(N.version||"?").replace(/^0\.1\.0\+/,"")}${(N.build||{}).branch?" · "+N.build.branch:""} · worker ${((D.updates||{}).installed||{}).build||"?"}${(D.updates||{}).available?" · UPDATE AVAILABLE":""}`,(D.updates||{}).available?"#e0a92a":null],
      ["pending",`${pend||"nothing pending"} · payments ${pay.enabled?`on, ${(pay.orders||{}).paid??"?"} paid`:"off"}${pay.gasLow?" · GAS LOW":""}`,pay.gasLow?"#ff6b62":null],
      ["you",(F.seats||{}).rank?`rank #${F.seats.rank} of ${F.seats.count} seats by accepted · ${(F.seats.ours||{}).accepted} ✓ ${(F.seats.ours||{}).rejected} ✗ ${(F.seats.ours||{}).failed} ✗✗ ${(F.seats.ours||{}).pending} ⧗ · ${(F.seats.ours||{}).acceptRate??"–"}% (fleet ${F.seats.acceptRate??"–"}%, median ${F.seats.medianAcceptRate??"–"}%)`:F.rank?`rank #${F.rank} of ${F.contributors} by accepted · ${o.accepted} ✓ · ${o.acceptRate??"–"}% accepted (fleet median ${md.acceptRate??"–"}%)`:"–"],
      ["per ✓",F.rank?`${fmt(o.outPerAccepted)} out ${cmp(o.outPerAccepted,md.outPerAccepted)} (median ${fmt(md.outPerAccepted)}) · ${o.turnsPerAccepted} turns (${md.turnsPerAccepted}) · ${o.minPerAccepted} min (${md.minPerAccepted})`:"–"]];
    srows(ctx,b,sy,sh,rows)}
  PN.hits.push({x:m.x,y:m.y,w:m.w,h:m.h,mod:m,whole:true,tip:tipHTML("The network",`api.imd.fun/health: connected daemons, what is queued for verification, feedback, oracle and deployment; api.imd.fun/services: the verifier, publisher and deployer with the build each runs; api.imd.fun/version: the control plane's commit, next to the worker build installed here. "you" ranks this seat among the ${(F.seats||{}).count||"?"} seats of api.imd.fun/seats/records (accepted / rejected / failed / pending, acceptance vs the fleet and the median of seats with 20+ accepted); the last line compares output tokens, turns and minutes per accepted task with the median of the ${F.peers||"?"} seats that have 20+ accepted (api.imd.fun/contributors). ▲ = you use more than the median. Runtimes count input differently, so only output, turns and time are compared.${N.error?` <span style="color:#ff6b62">stale: ${esc(N.error)}</span>`:""}`),click:()=>window.open("https://api.imd.fun/health","_blank","noopener")});
}
// 09 earnings: launch token allocations to the seat's wallet
function modEarnings(ctx,m,b){
  const E=D.earnings||{},items=E.items||[];const chains=Object.keys(E.byChain||{});
  label(ctx,b.x,b.ty+2,"09 · earnings");label(ctx,b.x+b.w,b.ty+2,E.wallet?`${E.count||0} launches${chains.length?" · "+chains.join(", "):""}${E.error?" · stale":""}`:"n/a",true);
  const sy=b.ty+PN.cell*.3,sh=b.y+b.h-sy;screen(ctx,b.x,sy,b.w,sh);
  if(!E.wallet){ptext(ctx,b.x+b.w/2,sy+sh/2,esc(E.error||"no wallet in config.json"),10,PAL.phosDim,400,"center")}
  else if(!items.length){ptext(ctx,b.x+b.w/2,sy+sh/2,"no launch allocations yet",10,PAL.phosDim,400,"center")}
  else{const rows=items.slice(0,6).map(e=>[`#${e.launchNumber}`,`${e.token.symbol||"?"} ${fmt(e.amount)} · ${e.token.name||""} · ${e.chain.name} · ${e.status}${e.chain.id!==1?" (testnet)":""}`]);
    const{rh}=srows(ctx,b,sy,sh,rows,Math.max(34,PN.cell*1.1));
    items.slice(0,6).forEach((e,i)=>PN.hits.push({x:b.x,y:sy+8+rh*i+rh*.2,w:b.w,h:rh,mod:m,tip:tipHTML(`launch #${e.launchNumber} · ${esc(e.token.name||"")}`,`${fmt(e.amount)} ${esc(e.token.symbol||"")} allocated to ${esc(E.wallet.slice(0,10))}… on ${esc(e.chain.name)} (${esc(e.kind||"")}, ${esc(e.status||"")}) at ${esc(String(e.at||"").replace("T"," ").slice(0,16))}.${e.repoUrl?" Source: "+esc(e.repoUrl.replace("https://github.com/",""))+".":""} Click for the token on the block explorer.`),click:()=>{if(e.tokenUrl)window.open(e.tokenUrl,"_blank","noopener")}}));
    if(items.length>6)ptext(ctx,b.x+b.w-10,sy+sh-6,`+${items.length-6} more`,9,PAL.phosDim,400,"right")}
  PN.hits.unshift({x:m.x,y:m.y,w:m.w,h:m.h,mod:m,whole:true,tip:tipHTML("Earnings",`Token allocations this seat's wallet earned from contract launches it contributed to (api.imd.fun/wallets/${esc((E.wallet||"").slice(0,10))}…/earnings). Launches on Sepolia are testnet tokens. Click a row for the token on the block explorer; the tooltip names the launch's source repository.${E.error?` <span style="color:#ff6b62">stale: ${esc(E.error)}</span>`:""}`)});
}


// the weekly pace: percent used per hour since the week's window opened, projected to the reset
function weekPace(sd){if(!sd||sd.pct==null||!sd.resetsAt)return null;const now=Date.now()/1000,start=sd.resetsAt-7*86400,el=now-start;if(el<3600)return null;const rate=sd.pct/el;const left=sd.resetsAt-now;const end=sd.pct+rate*left;
  if(rate>0&&(100-sd.pct)/rate<left)return{warn:true,text:`100% by ${dt(now+(100-sd.pct)/rate)} at this pace ⚠`,long:`at this pace 100% ${dt(now+(100-sd.pct)/rate)} (reset ${dt(sd.resetsAt)})`,end};return{warn:false,text:`≈${Math.min(100,Math.round(end))}% at reset ${dt(sd.resetsAt)}`,long:`at this pace ≈${Math.min(100,Math.round(end))}% by the reset ${dt(sd.resetsAt)}`,end}}
// ================================================================ the phone: the same readings as a list (the canvas is unreadable at 390 px)
function renderPanelList(){const el=$("#panelList");if(!el||!D)return;if(innerWidth>720){el.innerHTML="";return}
  const T=inRange(),U=D.usage||{},fh=U.fiveHour||{},sd=U.sevenDay||{};const pr=weekPace(sd);
  const acc=T.filter(t=>t.verdict==="accepted").length,rej=T.filter(t=>isBad(t.verdict)).length,closed=T.filter(t=>isClosed(t.verdict)).length,pend=T.filter(t=>t.submittedAt).length-acc-rej-closed;
  const top=[...T].sort((a,b)=>(b.costUSD||0)-(a.costUSD||0)).slice(0,5);const h=D.host||{},mem=h.mem||{},used=mem.used!=null?mem.used:(mem.total&&mem.available!=null?mem.total-mem.available:null);
  const S=D.seat||{},r=S.record||{},G=D.standing||{},p=G.presence||{},q=G.queue||{},N=D.network||{},R=D.registry||{},bt=R.batches||{},E=D.earnings||{},F=D.fleet||{};
  const sec=(t,rows)=>`<div class="pl"><div class="plh">${t}</div>${rows.map(([k,v,c])=>`<div class="plr"><span class="plk">${k}</span><span class="plv${c?" "+c:""}">${v}</span></div>`).join("")}</div>`;
  el.innerHTML=[
    sec("claude plan",[["5h window",fh.pct!=null?`${Math.round(fh.pct)}% · resets ${hm(fh.resetsAt)} UTC`:"–",fh.pct>=90?"sbad":""],["week",sd.pct!=null?`${Math.round(sd.pct)}%${pr?" · "+pr.long:""}`:"–",pr&&pr.warn?"sbad":""]]),
    sec("verdicts",[["accepted",acc,"sok"],["rejected / failed",rej,rej?"sbad":""],["pending",Math.max(0,pend)],["closed (no quorum, blocked)",closed]]),
    sec("counters",counters().map(c=>[c[0],`${c[1]}${c[2]?` <span class="muted">· ${c[2]}</span>`:""}`,c[3]==="alarm"?"sbad":""])),
    sec("top consumers",top.map(t=>[`<a data-open="${esc(t.id)}">${esc(t.id)}</a>`,`${usd(t.costUSD)} · ${fmt((t.usage||{}).output_tokens||0)} out · ${t.model?mi(t.model).n:"–"}`])),
    sec("the room",[["host memory",used!=null&&mem.total?`${(used/1e9).toFixed(1)} / ${(mem.total/1e9).toFixed(1)} GB`:"–"],["disk /",h.disk?`${(h.disk.free/1e9).toFixed(1)} GB free`:"–"],["load",(h.load||[]).map(x=>x.toFixed(2)).join(" ")||"–"],["worker",`${((h.worker||{}).ActiveState)||"?"} · ${D.claudeProcs??"?"} claude processes`]]),
    sec("the seat",[["record",S.tokenId?`${r.accepted??"–"} ✓ · ${r.rejected??"–"} ✗ · ${r.failed??0} failed · ${r.pending??"–"} pending`:"–"],["rank",(F.seats||{}).rank?`#${F.seats.rank} of ${F.seats.count} seats`:"–"],["registry",R.agentId?`${bt.sent||0} batches sent · ${(bt.queued||0)+(bt.submitted||0)} queued`:"–"]]),
    sec("standing",[["presence",G.at?`${p.connected?"connected":"not connected"} · ${p.acceptingWork?"accepting":"not accepting"}${p.stale?" · stale":""}`:"–",p.connected?"sok":"sbad"],["queue",`${q.ready??"–"} ready · ${q.eligible??"–"} eligible · fleet ${q.fleetOnline??"–"}`],["network",N.status?`${N.connectedDaemons} daemons · ${N.workingNow} working · ${N.acceptedLastDay} accepted last day`:"–"]]),
    sec("earnings",(E.items||[]).slice(0,4).map(e=>[`#${e.launchNumber}`,`${esc(e.token.symbol||"?")} ${fmt(e.amount)} · ${esc(e.status)}`]).concat((E.items||[]).length?[]:[["–","no allocations"]]))
  ].join("");el.querySelectorAll("[data-open]").forEach(a=>a.onclick=()=>openTranscript(a.dataset.open))}
