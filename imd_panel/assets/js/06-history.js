// ================================================================ the history panel: cost and verdicts per day, on the same wall
// The panel engine above is written against PN; a second canvas borrows it by swapping PN in and out.
const HP={canvas:null,ctx:null,tip:null,width:0,height:0,cell:40,mods:[],hits:[],hot:null,dirty:true,draw:()=>histDraw()};
function withPN(p,fn){const keep=PN;PN=p;try{return fn()}finally{PN=keep}}
function histInit(){HP.canvas=$("#hist");if(!HP.canvas)return;HP.ctx=HP.canvas.getContext("2d");HP.tip=$("#htip");
  new ResizeObserver(()=>{if(D)renderHist()}).observe(HP.canvas.parentElement);
  HP.canvas.addEventListener("mousemove",e=>withPN(HP,()=>panelMove(e)));HP.canvas.addEventListener("mouseleave",()=>withPN(HP,()=>{PN.hot=null;PN.tip.classList.remove("on");PN.canvas.style.cursor="";histDraw()}));
  HP.canvas.addEventListener("click",e=>withPN(HP,()=>{const h=hitAt(e);if(h&&h.click)h.click()}));
}
function renderHist(){if(!HP.canvas||!D)return;withPN(HP,()=>{const width=PN.canvas.parentElement.clientWidth;if(!width)return;PN.width=width;const cell=Math.max(30,Math.min(44,width/33));const narrow=width<760;
  PN.cell=cell;const gap=2;const hgt=Math.round(cell*6.5);PN.mods=narrow?[{kind:"days1",x:1,y:1,w:width-2,h:hgt-2},{kind:"days2",x:1,y:hgt+1,w:width-2,h:hgt-2}]:[{kind:"days1",x:1,y:1,w:Math.round(width/2)-2,h:hgt-2},{kind:"days2",x:Math.round(width/2)+1,y:1,w:width-Math.round(width/2)-2,h:hgt-2}];PN.height=narrow?hgt*2:hgt;
  const dpr=Math.min(2,devicePixelRatio||1);PN.canvas.width=Math.round(width*dpr);PN.canvas.height=Math.round(PN.height*dpr);PN.canvas.style.height=PN.height+"px";PN.ctx.setTransform(dpr,0,0,dpr,0,0);PN.ctx.lineJoin="round";histDraw()})}
function histDraw(){withPN(HP,()=>{const ctx=PN.ctx;if(!ctx||!PN.mods.length)return;PN.hits=[];ctx.fillStyle=PAL.wall;ctx.fillRect(0,0,PN.width,PN.height);
  for(const m of PN.mods){plate(ctx,m.x,m.y,m.w,m.h);const pad=Math.max(8,PN.cell*.3);const b={x:m.x+pad,y:m.y+pad,w:m.w-2*pad,h:m.h-2*pad,ty:m.y+pad+PN.cell*.1};modDays(ctx,m,b,m.kind==="days1"?1:2);
    if(PN.hot&&PN.hot.mod===m&&PN.hot.whole){ctx.fillStyle="#fff";ctx.globalAlpha=.08;ctx.fillRect(m.x,m.y,m.w,m.h);ctx.globalAlpha=1}}ctx.textAlign="left"})}
function modDays(ctx,m,b,which){
  const rows=HIST&&HIST.days?HIST.days.slice(-60):[];label(ctx,b.x,b.ty+2,which===1?"01 · cost per day, by model":"02 · verdicts per day");label(ctx,b.x+b.w,b.ty+2,rows.length?`${rows.length} days`:"no history",true);
  const sy=b.ty+PN.cell*.3,sh=b.y+b.h-sy;screen(ctx,b.x,sy,b.w,sh);
  const models=dayModels(rows);const series=which===1?models.map(mm=>({name:mi(mm).n,col:mcol(mm),val:r=>dayModelCost(r)[mm]||0})):[{name:"accepted",col:PAL.lamp,val:r=>r.accepted},{name:"pending",col:PAL.phosDim,val:r=>Math.max(0,r.submitted-r.accepted-r.rejected)},{name:"rejected",col:"#ff5a50",val:r=>r.rejected},{name:"released",col:PAL.amber,val:r=>r.released}];
  const L=b.x+40,R=b.x+b.w-8,T=sy+22,B=sy+sh-22,pw=R-L,ph=B-T;if(!rows.length||pw<40||ph<20){ptext(ctx,b.x+b.w/2,sy+sh/2,"no history yet",10,PAL.phosDim,400,"center");return}
  const tot=rows.map(r=>series.reduce((a,s)=>a+s.val(r),0)),max=Math.max(1e-9,...tot);
  ctx.strokeStyle=PAL.glass;ctx.globalAlpha=.22;ctx.lineWidth=1;for(let i=0;i<=4;i++){const y=T+ph-ph*i/4;ctx.beginPath();ctx.moveTo(L,y);ctx.lineTo(R,y);ctx.stroke();ctx.globalAlpha=.9;ptext(ctx,L-4,y+3,which===1?"$"+Math.round(max*i/4):String(Math.round(max*i/4)),8,PAL.phosDim,400,"right");ctx.globalAlpha=.22}ctx.globalAlpha=1;
  const bw=pw/rows.length,gap=Math.min(6,bw*.2);
  rows.forEach((r,i)=>{let y=T+ph;const x=L+i*bw+gap/2,w=Math.max(2,bw-gap);series.forEach(s=>{const v=s.val(r);if(!v)return;const hh=ph*v/max;y-=hh;ctx.fillStyle=s.col;glow(ctx,s.col);ctx.fillRect(x,y,w,Math.max(1,hh-1));noglow(ctx)});
    if(bw>26||i%Math.ceil(26/bw)===0)ptext(ctx,x+w/2,B+12,r.day.slice(5),8,PAL.phosDim,400,"center");
    const tip=which===1?`${usd(r.cost)}${models.map(mm=>dayModelCost(r)[mm]?` · ${mi(mm).n} ${usd(dayModelCost(r)[mm])}`:"").join("")}<br>${fmt(r.outTokens)} out · ${fmt(r.freshTokens)} fresh · ${r.turns} turns`:`${r.tasks} tasks · ${r.submitted} submitted · ${r.accepted} ✓ · ${r.rejected} ✗ · ${r.released} released · ${r.limitHits} limit errors · ${r.guardPauses} guard pauses`;
    PN.hits.push({x:L+i*bw,y:T,w:bw,h:ph,mod:m,tip:tipHTML(r.day,tip)})});
  let lx=L;series.forEach(s=>{ctx.fillStyle=s.col;ctx.fillRect(lx,T-13,8,8);ptext(ctx,lx+11,T-6,s.name,8,PAL.phosDim);lx+=11+ctx.measureText(s.name).width+12});
  PN.hits.unshift({x:m.x,y:m.y,w:m.w,h:m.h,mod:m,whole:true,tip:tipHTML(which===1?"Cost per day, by model":"Verdicts per day",which===1?"API-equivalent estimate from Claude Code, per UTC day. Persistent snapshots in SQLite, so it survives transcript pruning. Hover a day.":"Accepted, rejected, still pending, and released on rate limit, per UTC day. The last three days are recomputed as verdicts arrive.")});
}

