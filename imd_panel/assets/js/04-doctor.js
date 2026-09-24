// ================================================================ the doctor: a second pepe in a white coat, in the corridor corner
// Click him and he offers a check-up: POST /api/doctor runs `imd doctor` on the host and the report shows on his glass.
function doctorSheet(){return pepeSheet().then(sheet=>{if(!sheet)return null;const c=document.createElement("canvas");c.width=sheet.width;c.height=sheet.height;const x=c.getContext("2d",{willReadFrequently:true});x.drawImage(sheet,0,0);
  try{const d=x.getImageData(0,0,c.width,c.height),p=d.data;for(let i=0;i<p.length;i+=4){const r=p[i],g=p[i+1],b=p[i+2];
      // the (already charcoal) shirt → white coat, shading kept
      if(p[i+3]>0&&Math.abs(r-g)<8&&Math.abs(g-b)<8&&r>=40&&r<=150){const v=Math.round(215+(r-40)/110*40);p[i]=v;p[i+1]=v;p[i+2]=Math.min(255,v+4)}}x.putImageData(d,0,0)}catch(e){}
  return c})}
function doctorStart(el){
  const cv=el,dpr=Math.min(2,devicePixelRatio||1);let cw=0,sheet=null,cur="front_stand",busy=false;
  const fit=()=>{const w=cv.clientWidth||60,h=w*PEPE_FH/PEPE_FW;if(w===cw)return;cw=w;cv.width=Math.round(w*dpr);cv.height=Math.round(h*dpr);cv.style.height=h+"px";cv.getContext("2d").setTransform(dpr,0,0,dpr,0,0)};
  const face=n=>{cur=n;fit();const ctx=cv.getContext("2d");const H=cw*PEPE_FH/PEPE_FW;ctx.clearRect(0,0,cw,H);if(!sheet)return;const i=Math.max(0,PEPE_FRAMES.indexOf(n));
    ctx.beginPath();ctx.ellipse(cw/2,H*.985,cw*.28,H*.035,0,0,TAU);ctx.fillStyle="rgba(0,0,0,.22)";ctx.fill();ctx.drawImage(sheet,i*PEPE_FW,0,PEPE_FW,PEPE_FH,0,0,cw,H);
    // his badges: a red cross on the coat and a head mirror
    // the chest sits at 58-78 % of the frame height, the forehead at ~24 %
    if(n.startsWith("front")){const s=cw/100;const cx=cw*.40,cy=H*.66;ctx.fillStyle="#d8352b";ctx.fillRect(cx-s*3.5,cy-s*1.1,s*7,s*2.2);ctx.fillRect(cx-s*1.1,cy-s*3.5,s*2.2,s*7);
      ctx.beginPath();ctx.arc(cw*.5,H*.14,s*5.5,0,TAU);ctx.fillStyle="#e9e9e4";ctx.fill();ctx.strokeStyle="#141414";ctx.lineWidth=s*1.2;ctx.stroke();ctx.beginPath();ctx.arc(cw*.5,H*.14,s*2.2,0,TAU);ctx.fillStyle="#9fd3ff";ctx.fill()}};  // the mirror sits on the crown, as before
  new ResizeObserver(()=>{cw=0;face(cur)}).observe(cv);
  doctorSheet().then(s=>{sheet=s;cw=0;face(cur)});face(cur);
  const dlg=$("#docdlg"),body=$("#docBody"),foot=$("#docFoot"),title=$("#docTitle");
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const close=()=>{dlg.classList.remove("on")};$("#docClose").onclick=close;
  const colour=txt=>esc(txt).split("\n").map(l=>/^\s*✓/.test(l)?`<span class="ok">${l}</span>`:/^\s*✗/.test(l)?`<span class="bad">${l}</span>`:/^\s*(→|the network says|everything checks out)/.test(l)?`<span class="warn">${l}</span>`:/^\s{6,}\S/.test(l)?`<span class="dim">${l}</span>`:l).join("\n");
  const offer=()=>{title.textContent="The doctor";body.innerHTML=`Want a check-up? <span class="dim">imd doctor</span> checks the config, the tools, the plane, and pings Claude once (a few seconds, about $0.25 API-equivalent on the premium model).`;foot.innerHTML=`<button class="go" id="docGo">run imd doctor</button><button id="docNo">not now</button>`;dlg.classList.add("on");
    $("#docNo").onclick=close;$("#docGo").onclick=run};
  const run=async()=>{if(busy)return;busy=true;title.textContent="Examining…";body.innerHTML=`<span class="dim">running imd doctor on the host</span><span class="cursor"></span>`;foot.innerHTML="";
    const anim=(async()=>{while(busy){face("front_scratch");await sleep(260);face("front_stand");await sleep(220);face("front_lookup");await sleep(500);face("front_stand");await sleep(300)}})();
    try{const r=await post("/api/doctor",{});body.innerHTML=colour(r.output||"(no output)");title.textContent=`The doctor's report · ${r.took}s${r.rc?" · exit "+r.rc:""}`}
    catch(e){body.innerHTML=`<span class="bad">${esc(e.message)}</span>`;title.textContent="The doctor could not examine"}
    busy=false;await anim;face("front_stand");foot.innerHTML=`<button id="docAgain">again</button><button id="docOk">close</button>`;$("#docAgain").onclick=run;$("#docOk").onclick=close;load(true)};
  cv.addEventListener("click",()=>{if(busy)return;if(dlg.classList.contains("on"))close();else offer()});
  // idle: the odd glance and scratch
  if(!matchMedia("(prefers-reduced-motion: reduce)").matches)(async()=>{for(;;){await sleep(5000+7000*Math.random());if(busy||document.visibilityState!=="visible")continue;
    if(Math.random()<.5){face("front_lookup");await sleep(1200)}else{for(let i=0;i<3;i++){face("front_scratch");await sleep(240);face("front_stand");await sleep(200)}}face("front_stand")}})();
}

