const $=s=>document.querySelector(s);
// one colour per model (--s1…--s5); url(#p-…) fills (SVG patterns at the top of <body>) stay available via bgc()
const MODELS={"claude-opus-5-5":{c:"var(--s5)",cls:"m5",n:"Opus 5.5"},"claude-opus-5":{c:"var(--s1)",cls:"m1",n:"Opus 5"},"claude-sonnet-5":{c:"var(--s2)",cls:"m2",n:"Sonnet 5"},"claude-fable-5-1":{c:"var(--s3)",cls:"m3",n:"Fable 5.1"}};
// the same fill as a CSS background (legend swatches, tooltips)
const bgc=c=>c==="url(#p-hatch)"?"var(--hatch)":c==="url(#p-dots)"?"var(--dots)":c;
const other={c:"var(--s4)",cls:"m4",n:"other"};
const mi=m=>MODELS[m]||(m==="unknown"||!m?{c:"var(--faint)",cls:"",n:"no model (limit hit)"}:other);
const fmt=n=>n==null?"–":n>=1e9?(n/1e9).toFixed(2)+"B":n>=1e6?(n/1e6).toFixed(2)+"M":n>=1e3?(n/1e3).toFixed(1)+"k":String(Math.round(n));
const usd=n=>"$"+(n||0).toFixed(2);
const n0=v=>v?fmt(v):'<span class="z">0</span>';  // dim zeros so real numbers stand out
const pad=n=>String(n).padStart(2,"0");
const dt=ts=>{const d=new Date(ts*1000);return `${d.getUTCMonth()+1}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`};
const hm=ts=>{const d=new Date(ts*1000);return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`};
const dur=s=>s>=3600?`${Math.floor(s/3600)}h${pad(Math.round(s%3600/60))}`:s>=60?`${Math.floor(s/60)}m${pad(Math.round(s%60))}`:`${Math.round(s)}s`;
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
let D=null,rangeH=24,sort={k:"acceptedAt",d:-1},open=new Set();
const gb=n=>n==null?"–":(n/1073741824).toFixed(1)+" GB";const mb=n=>n==null?"–":(n/1048576).toFixed(0)+" MB";
async function post(path,body){const r=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json","X-Dashboard":"1"},body:JSON.stringify(body)});const j=await r.json().catch(()=>({error:"bad response"}));if(!r.ok||j.ok===false)throw new Error(j.error||r.statusText);return j}
const say=(id,txt,cls)=>{const m=$("#"+id);m.textContent=txt;m.className="msg "+(cls||"")};

// theme
const root=document.documentElement;
try{const t=new URLSearchParams(location.search).get("theme")||localStorage.getItem("theme");if(t)root.dataset.theme=t}catch(e){}
$("#theme").onclick=()=>{const dark=matchMedia("(prefers-color-scheme:dark)").matches;const cur=root.dataset.theme||(dark?"dark":"light");root.dataset.theme=cur==="dark"?"light":"dark";try{localStorage.setItem("theme",root.dataset.theme)}catch(e){};render()};
$("#pwReload").onclick=async e=>{e.stopPropagation();const k=$("#pwReload");if(k.classList.contains("busy"))return;k.classList.add("busy");k.querySelector(".t").textContent="reloading…";await load(true);k.classList.remove("busy");k.classList.add("done");k.querySelector(".t").textContent="fresh";setTimeout(()=>{k.classList.remove("done");k.querySelector(".t").textContent="reload"},1200)};
$("#range").onclick=e=>{if(e.target.dataset.h==null)return;rangeH=+e.target.dataset.h;[...$("#range").children].forEach(b=>b.classList.toggle("on",b===e.target));render()};
["fModel","fStatus","fTier","fVerdict","fQ"].forEach(id=>$("#"+id).addEventListener("input",renderTasks));

let HIST=null;
async function load(force){
  $("#state").textContent="loading…";
  try{const r=await fetch("/api/data"+(force?"?refresh=1":""));D=await r.json();try{HIST=await (await fetch("/api/history")).json()}catch(e){HIST=null}render()}
  catch(e){console.error("load/render failed",e);$("#state").textContent="fetch failed";$("#dot").className="dot off"}
}
function since(){return rangeH?Date.now()/1000-rangeH*3600:0}

function render(){
  if(!D)return;
  $("#host").textContent=D.hostName||"";
  const la=D.lastAlive,age=la?Date.now()/1000-la.ts:1e9;
  const nRun=Math.max((D.running||[]).length,la.running||0);  // live task list beats the 30 s heartbeat line
  $("#dot").className="dot "+(age>300?"off":nRun?"live":"on");
  $("#state").textContent=age>300?`no heartbeat for ${dur(age)}`:nRun?`${nRun} task${nRun>1?"s":""} running`:"idle";
  $("#fleet").textContent=la&&la.fleetOnline?`fleet ${la.fleetOnline}/${la.fleetEnrolled}`:"";const U=D.usage||{};$("#usagePill").textContent=U.fiveHour&&U.fiveHour.pct!=null?`5h ${Math.round(U.fiveHour.pct)}% · wk ${U.sevenDay?Math.round(U.sevenDay.pct):"?"}%`:"";$("#usagePill").style.color=U.fiveHour&&U.fiveHour.pct>=90?"var(--alarm)":"";
  const tid=D.explorer&&D.explorer.tokenId;$("#eyebrow").textContent=`identitymd contributor node${tid?` · agent #${tid}`:""} · ${D.hostName||""}`;
  $("#headline").innerHTML=age>300?`<b>Silent</b> for ${dur(age)}.`:nRun?`<b>Working</b> on ${nRun} task${nRun>1?"s":""}.`:`<b>Online</b>, waiting for work.`;
  $("#updated").textContent=`${hm(D.generatedAt)} UTC`;
  // banner: recent limit
  const lm=D.limitMsgs[D.limitMsgs.length-1];const b=$("#banner");
  if(lm&&Date.now()/1000-lm.ts<3*3600){b.style.display="block";b.className="banner";b.textContent=`⚠ Claude session limit hit at ${dt(lm.ts)} UTC — “${lm.msg}”`}
  else if(D.journalError){b.style.display="block";b.className="banner lamp";b.textContent="journal unavailable: "+D.journalError}else b.style.display="none";
  const al=$("#agentLink");if(D.explorer&&D.explorer.agentUrl){al.href=D.explorer.agentUrl;const a=D.explorer.agent;al.textContent=a?`#${D.explorer.tokenId} · ${a.accepted}/${a.attempts} ↗`:`#${D.explorer.tokenId} ↗`;al.title=a?`agent #${D.explorer.tokenId} on the explorer · ${a.accepted} of ${a.attempts} attempts accepted`:"agent page on the explorer"}
  renderDaily();renderRunning();renderPanel();renderPower();renderGuard();renderNotify();renderEpisodes();renderByModel();fillFilters();renderTasks();renderFeed();renderConfig();renderService();renderEffective();renderTierLog();syncScroll();
}
function renderGuard(){
  const G=D.guard||{},c=G.config||{},st=G.state||{};
  const setIf=(id,v,chk)=>{const el=$("#"+id);if(document.activeElement===el)return;if(chk)el.checked=!!v;else el.value=v??""};
  setIf("gEnabled",c.enabled,true);setIf("gSession",c.sessionPct);setIf("gWeekly",c.weeklyPct);setIf("gTokens",c.windowTokens);const U=D.usage||{};$("#gNow").textContent=U.fiveHour&&U.fiveHour.pct!=null?`claude now: 5h ${Math.round(U.fiveHour.pct)}% · week ${U.sevenDay?Math.round(U.sevenDay.pct):"?"}%`:"";setIf("gCost",c.windowCost);setIf("gDaily",c.dailyCost);setIf("gIdle",c.waitForIdle,true);setIf("gResume",c.resumeAtReset,true);
  const over=(st.over||[]).length;const b=$("#banner");
  if(st.paused){b.style.display="block";b.className="banner lamp";b.textContent=`⏸ worker paused by budget guard since ${hm(st.pausedAt)} UTC — ${st.reason}${st.resumeAt?` — resumes at ${hm(st.resumeAt)} UTC`:" — manual resume"}`}
  $("#gState").innerHTML=`<span class="tag ${st.paused?"lamp":c.enabled?"ok":""}">${st.paused?"paused":c.enabled?"watching":"off"}</span> window so far: <b>${fmt(st.tokens||0)}</b> tokens · <b>${usd(st.cost)}</b> · today <b>${usd(st.daily)}</b>${over?` · <span style="color:var(--alarm)">over: ${esc(st.over.join("; "))}</span>`:""}${st.pending?` · <span style="color:var(--lamp)">${esc(st.pending)}</span>`:""}${st.overrideUntil&&st.overrideUntil>Date.now()/1000?` · override until ${hm(st.overrideUntil)}`:""}${st.lastCheck?` · checked ${hm(st.lastCheck)}`:""}`+
    ((st.log||[]).slice(-5).reverse().map(l=>`<div class="muted">${dt(l.ts)} ${esc(l.msg)}</div>`).join(""));
}
$("#gSave").onclick=async()=>{say("gMsg","saving…");try{await post("/api/guard",{enabled:$("#gEnabled").checked,sessionPct:+$("#gSession").value,weeklyPct:+$("#gWeekly").value,windowTokens:+$("#gTokens").value,windowCost:+$("#gCost").value,dailyCost:+$("#gDaily").value,waitForIdle:$("#gIdle").checked,resumeAtReset:$("#gResume").checked});say("gMsg","guard saved","ok");load(true)}catch(e){say("gMsg",e.message,"err")}};
$("#gResumeNow").onclick=async()=>{say("gMsg","resuming…");try{await post("/api/guard",{resumeNow:true});say("gMsg","worker resumed; guard overridden for 1h","ok");setTimeout(()=>load(true),3000)}catch(e){say("gMsg",e.message,"err")}};
const EVN={limit:"Claude session limit hit",released:"tasks released on rate limit",guard:"budget guard paused / resumed",heartbeat:"no worker heartbeat",worker:"worker service not active",rejected:"task rejected by the network",standing:"network standing: dispatch pause, breaker, failures",disk:"low disk space",daily:"daily digest",wasted:"work lost: task released after real work",api:"imd.fun API gained routes"};
function renderNotify(){
  const N=D.notify||{},c=N.config||{};const setIf=(id,v)=>{const el=$("#"+id);if(document.activeElement!==el&&!el.dataset.dirty)el.value=v??""};
  if(!$("#nToken").dataset.dirty&&document.activeElement!==$("#nToken"))$("#nToken").placeholder=c.telegramToken?`saved (${c.telegramToken}) — leave empty to keep`:"123456:ABC… (from @BotFather)";
  setIf("nChat",c.telegramChatId);setIf("nHook",c.webhookUrl);setIf("nHb",c.heartbeatMin);setIf("nDisk",c.diskGB);setIf("nHour",c.dailyHourUTC);
  const ev=c.events||{};if(!$("#nEvents").children.length||!$("#nEvents").dataset.dirty)$("#nEvents").innerHTML=Object.keys(EVN).map(k=>`<label><input type="checkbox" data-ev="${k}" ${ev[k]?"checked":""}> ${EVN[k]}</label>`).join("");
  $("#nEvents").querySelectorAll("input").forEach(i=>i.onchange=()=>$("#nEvents").dataset.dirty="1");
  ["nToken","nChat","nHook","nHb","nDisk","nHour"].forEach(id=>$("#"+id).oninput=()=>$("#"+id).dataset.dirty="1");
  const H=N.history||[];$("#nHist").innerHTML=H.length?H.slice().reverse().map(h=>`<div class="${h.errors&&h.errors.length?"feed rate-limit":""}"><span class="muted">${dt(h.ts)}</span> ${esc(h.text.replace(/<[^>]+>/g,"").split("\n")[0].slice(0,110))} <span class="muted">→ ${(h.sent||[]).join(",")||"nothing"}${h.errors&&h.errors.length?" · "+esc(h.errors.join("; ")):""}</span></div>`).join(""):'<span class="muted">nothing sent yet</span>';
}
async function saveNotify(test){const body={telegramChatId:$("#nChat").value,webhookUrl:$("#nHook").value,heartbeatMin:+$("#nHb").value||5,diskGB:+$("#nDisk").value||10,dailyHourUTC:+$("#nHour").value||8,events:Object.fromEntries([...$("#nEvents").querySelectorAll("input")].map(i=>[i.dataset.ev,i.checked])),test:!!test};
  if($("#nToken").value)body.telegramToken=$("#nToken").value;
  say("nMsg",test?"saving & sending test…":"saving…");try{const r=await post("/api/notify",body);["nToken","nChat","nHook","nHb","nDisk","nHour","nEvents"].forEach(id=>delete $("#"+id).dataset.dirty);$("#nToken").value="";say("nMsg",test?`test sent via ${(r.sent||[]).join(", ")||"nothing (no channel configured)"}`:"saved","ok");load(true)}catch(e){say("nMsg",e.message,"err")}}
$("#nSave").onclick=()=>saveNotify(false);$("#nTest").onclick=()=>saveNotify(true);
// cost per model for one day: extra.byModel when the row has it, else the two
// fixed columns rows written before it existed carry (rest lumped as unknown)
function dayModelCost(r){
  const bm=(r.extra||{}).byModel;
  if(bm&&Object.keys(bm).length)return Object.fromEntries(Object.entries(bm).map(([m,v])=>[m,v.cost||0]));
  const o={};if(r.costOpus)o["claude-opus-5"]=r.costOpus;if(r.costSonnet)o["claude-sonnet-5"]=r.costSonnet;
  const rest=(r.cost||0)-(r.costOpus||0)-(r.costSonnet||0);if(rest>0.005)o.unknown=rest;return o;
}
// models that actually ran in the window, biggest spender first — nothing hardcoded
function dayModels(rows){
  const tot={};rows.forEach(r=>Object.entries(dayModelCost(r)).forEach(([m,c])=>tot[m]=(tot[m]||0)+c));
  return Object.keys(tot).filter(m=>tot[m]>0).sort((a,b)=>tot[b]-tot[a]);
}
function renderDaily(){
  if(!HIST){$("#daysT").innerHTML='<tr><td class="empty">history unavailable</td></tr>';renderHist();return}
  const rows=HIST.days.slice(-60),models=dayModels(rows);
  renderHist();renderOracleQ();renderApiRoutes();if(!document.querySelector('section[data-tab="swarm"]').hidden){renderSwarm();renderPublished()}
  $("#daysT").innerHTML=`<tr><th>day</th><th class="num">tasks</th><th class="num">submitted</th><th class="num">✓</th><th class="num">✗</th><th class="num">acc %</th><th class="num">released</th><th class="num">limit errs</th><th class="num">guard</th><th class="num">cost</th>${models.map(m=>`<th class="num">${mi(m).n}</th>`).join("")}<th class="num">$/task</th><th class="num">out tokens</th><th class="num">turns/task</th><th class="num">onchain</th></tr>`+
    rows.slice().reverse().map(r=>{const j=r.accepted+r.rejected;return`<tr><td>${r.day}</td><td class="num">${r.tasks}</td><td class="num">${r.submitted}</td><td class="num">${r.accepted}</td><td class="num">${n0(r.rejected)}</td><td class="num ${j&&r.accepted/j<.8?"":""}">${j?Math.round(r.accepted/j*100)+"%":"–"}</td><td class="num">${n0(r.released)}</td><td class="num">${n0(r.limitHits)}</td><td class="num">${n0(r.guardPauses)}</td><td class="num">${usd(r.cost)}</td>${models.map(m=>`<td class="num">${dayModelCost(r)[m]?usd(dayModelCost(r)[m]):'<span class="z">–</span>'}</td>`).join("")}<td class="num">${r.tasks?usd(r.cost/r.tasks):"–"}</td><td class="num">${fmt(r.outTokens)}</td><td class="num">${r.tasks?Math.round(r.turns/r.tasks):"–"}</td><td class="num">${n0(r.onchain)}</td></tr>`}).join("");
  syncScroll();
}
let TR=null,mtab="timeline";
async function openTranscript(id){const M=$("#modal");M.classList.add("open");$("#mtitle").innerHTML=`<b>${id}</b> loading…`;$("#mbody").innerHTML="";
  try{TR=await (await fetch("/api/transcript?id="+encodeURIComponent(id))).json()}catch(e){TR={error:String(e)}}
  const t=D.tasks.find(x=>x.id===id)||{};$("#mtitle").innerHTML=`<b>${id}</b> ${t.model?`<span class="tag ${mi(t.model).cls}">${mi(t.model).n} · ${t.effort||""}</span>`:""} ${t.verdict?`<span class="tag ${t.verdict==="accepted"?"ok":isBad(t.verdict)?"alarm":isClosed(t.verdict)?"dimtag":""}" title="${esc(t.reason&&t.reason.reason||"")}">${vlabel(t.verdict)}</span>`:""} <span class="muted">${usd(t.costUSD)} · ${t.turns} turns · ${fmt((t.usage||{}).output_tokens||0)} out</span> ${netSummary()} ${t.jobUrl?`<a class="ext" href="${t.jobUrl}" target="_blank" rel="noopener">explorer ↗</a>`:""}${t.workflow?` <span class="tag ${stState(t.workflow.status)}" title="${esc(t.workflow.objective||"")}">workflow ${esc((t.workflow.id||"").slice(0,8))}${t.workflow.stage?" · "+esc(t.workflow.stage):""} · ${esc(t.workflow.status||"")}</span>`:""}${(t.jobInfo||{}).takenBy?` <span class="tag alarm" title="we released this step before delivering; the network's record credits another seat">step done by #${esc(t.jobInfo.takenBy)}</span>`:""}${t.panel?` <span class="tag ${stState(t.panel.state)}">panel ${esc(t.panel.state)}</span>`:""}${t.fuzz?` <span class="tag ${stState(t.fuzz.state)}">fuzz ${esc(t.fuzz.state)}</span>`:""}`;renderModal()}
const netBadge=n=>n?`<span class="net ${n.kind}" title="${esc(n.hosts.join(", "))}">${n.kind}</span>`:"";
function netSummary(){if(!TR||!TR.sessions)return"";const c={rpc:0,api:0,web:0};TR.sessions.forEach(s=>{const n=s.net||{};c.rpc+=n.rpc||0;c.api+=n.api||0;c.web+=n.web||0});const tot=c.rpc+c.api+c.web;return tot?`<span class="muted">⇄</span> ${["rpc","api","web"].filter(k=>c[k]).map(k=>`<span class="net ${k}">${c[k]} ${k}</span>`).join("")}`:'<span class="net" style="color:var(--dim)">no network</span>'}
function askBlock(s){const a=s.ask||{};if(!a.task&&!s.prompt)return"";const reads=TR.reads||[];
  const oracle=reads.map(r=>(r.files||[]).find(f=>f.json&&f.json.question)).find(Boolean);const o=oracle&&oracle.json;
  return`<div class="ask"><h4>what the swarm asked${a.role?` · ${esc(a.role)} step`:""}${a.profile?` · profile ${esc(a.profile)}`:""}</h4>${a.task?`<pre>${esc(a.task)}</pre>`:'<div class="muted">no "Task" section found in the prompt — the full prompt is below</div>'}
  ${a.criteria&&a.criteria.length?`<h4>judged on</h4><ul>${a.criteria.map(c=>`<li>${esc(c)}</li>`).join("")}</ul>`:""}
  ${a.paths?`<div class="kv"><b>may write</b><span>${esc(a.paths)}</span>${a.reads?`<b>given to read</b><span>${a.reads.map(esc).join("<br>")}</span>`:""}</div>`:""}</div>`+
  (o?`<div class="ask"><h4>pinned oracle request · ${esc(oracle.path)} · from api.imd.fun/reads</h4><div class="kv"><b>question</b><span>${esc(o.question)}</span><b>answer type</b><span>${esc(o.answerType||"")} · evidence ${esc(o.evidence||"chain")}${o.head?` · head ${o.head}`:""}${o.toleranceBps!=null?` · tolerance ${o.toleranceBps} bps`:""}</span><b>chain · window</b><span>chain ${o.chainId} · blocks ${(o.window||{}).fromBlock} → ${(o.window||{}).toBlock}${(o.window||{}).hours?` (${o.window.hours} h)`:""}</span>${o.definitions?`<b>definitions</b><span>${Object.entries(o.definitions).map(([k,v])=>`<b>${esc(k)}</b> ${esc(String(v))}`).join("<br>")}</span>`:""}${o.guards?`<b>guards</b><span>${esc(JSON.stringify(o.guards))}</span>`:""}<b>request</b><span>${esc(o.requestId||"")}</span></div><details><summary class="muted">raw oracle.json</summary><pre>${esc(oracle.content)}</pre></details></div>`:"")+
  reads.filter(r=>!(r.files||[]).some(f=>f.json&&f.json.question)).map(r=>r.error?`<div class="ask muted">read ${esc(r.name)}: ${esc(r.error)}</div>`:(r.files||[]).map(f=>`<div class="ask"><h4>${esc(r.name)} · ${esc(f.path)}</h4><details><summary class="muted">${f.content.length} chars</summary><pre>${esc(f.content)}</pre></details></div>`).join("")).join("")}
function renderModal(){const b=$("#mbody");if(!TR||TR.error){b.innerHTML=`<div class="empty">${esc(TR&&TR.error||"no data")}</div>`;return}  $("#modal").querySelectorAll(".mtabs [data-t]").forEach(x=>x.classList.toggle("active",x.dataset.t===mtab));
  if(mtab==="prompt"){const tk=D.tasks.find(x=>x.id===TR.id)||{};const pre=[wfBlock(tk),panelBlock(tk)].filter(Boolean).map(x=>`<div class="ask">${x}</div>`).join("");b.innerHTML=pre+TR.sessions.map((s,i)=>`${TR.sessions.length>1?`<div class="muted">session ${i+1}</div>`:""}${askBlock(s)}<details><summary class="muted">full worker prompt as the agent received it (${(s.prompt||"").length} chars)</summary><pre style="max-height:none">${esc(s.prompt)}</pre></details>`).join("");return}
  if(mtab==="network"){const rows=[];TR.sessions.forEach((s,si)=>s.turns.forEach((t,k)=>t.tools.forEach(x=>{if(x.net)rows.push({si,k,t,x})})));const n=TR.sessions[0]&&TR.sessions[0].net||{};
    b.innerHTML=`<div class="muted" style="margin-bottom:8px">${rows.length} network calls: ${netSummary()} · hosts: ${Object.entries(n.hosts||{}).map(([h,c])=>`${esc(h)}×${c}`).join(", ")||"–"}</div>`+(rows.length?rows.map(r=>`<details><summary>${netBadge(r.x.net)} <span class="th">#${r.k+1} ${(r.t.ts||"").slice(11,19)}</span> ${r.x.name} <span class="muted">${esc(r.x.input.slice(0,160))}</span></summary><pre>${esc(r.x.input)}</pre>${r.x.result?`<div class="muted">result</div><pre>${esc(r.x.result)}</pre>`:""}</details>`).join(""):'<div class="empty">no network calls in this transcript — the answer came from local data or prior knowledge</div>');return}
  if(mtab==="produced"){const P=TR.produced||[];const tk=D.tasks.find(x=>x.id===TR.id)||{};const rb=resultBlock(tk);b.innerHTML=(rb?`<div class="ask"><h4>what the network kept · api.imd.fun/jobs/:id/result</h4>${rb}</div>`:"")+`<div class="muted">work dir: ${esc(TR.workDir||"–")} ${TR.workDirExists?"(still on disk)":"(pruned)"}</div>`+(TR.gitStatus?`<div class="muted" style="margin-top:6px">git status</div><pre>${esc(TR.gitStatus)}</pre>`:"")+(TR.artifacts.length?TR.artifacts.map(a=>`<div><b>${esc(a.path)}</b> <span class="muted">${a.size} B (on disk)</span></div><pre>${esc(a.content)}</pre>`).join(""):"")+(P.length?`<div class="muted" style="margin-top:6px">files written by the model (${P.length} ${P.length===1?"call":"calls"}, from the transcript)</div>`+P.map(p=>`<details open><summary><b>${esc(p.path.replace(TR.workDir||"","."))}</b> <span class="muted">${p.tool} · ${(p.ts||"").slice(11,19)}</span></summary><pre>${esc(p.content)}</pre></details>`).join(""):'<div class="muted">nothing written</div>');return}
  b.innerHTML=TR.sessions.map((s,i)=>`${TR.sessions.length>1?`<div class="muted">session ${i+1} · ${s.model||""} · ${usd(s.cost)}</div>`:""}`+s.turns.map((t,k)=>t.kind==="error"?`<div class="turn error"><span class="th">#${k+1} ${(t.ts||"").slice(11,19)}</span> <span style="color:var(--alarm)">${esc(t.text)}</span></div>`:
    `<div class="turn"><span class="th">#${k+1} ${(t.ts||"").slice(11,19)} · out ${fmt(t.out)} · cache r ${fmt(t.cacheR)}${t.cacheW?" w "+fmt(t.cacheW):""}${t.tools.some(x=>x.net)?" · ⇄ "+[...new Set(t.tools.filter(x=>x.net).map(x=>x.net.kind))].join("+"):""}</span>${t.thinking?`<details><summary>thinking</summary><div class="txt muted">${esc(t.thinking)}</div></details>`:""}${t.text?`<div class="txt">${esc(t.text)}</div>`:""}${t.tools.map(x=>`<details><summary>${netBadge(x.net)}🔧 ${x.name} <span class="muted">${esc(x.input.slice(0,140))}</span></summary><pre>${esc(x.input)}</pre>${x.result?`<div class="muted">result</div><pre>${esc(x.result)}</pre>`:""}</details>`).join("")}</div>`).join("")).join("");
}
$("#modal").querySelectorAll(".mtabs [data-t]").forEach(x=>x.onclick=()=>{mtab=x.dataset.t;renderModal()});
$("#mclose").onclick=()=>$("#modal").classList.remove("open");$("#modal").onclick=e=>{if(e.target===$("#modal"))$("#modal").classList.remove("open")};
document.addEventListener("keydown",e=>{if(e.key==="Escape")$("#modal").classList.remove("open")});
// tiers are always shown cheapest first
const TIER_ORDER=["economy","standard","premium"];
const tierRank=k=>{const i=TIER_ORDER.indexOf(k.replace(/^tier:/,""));return i<0?99:i};
function renderConfig(){
  const c=D.config||{};if(!c.allowedModels)return;const inf=c.inference||{};
  const fill=(id,vals,cur,empty)=>{const el=$("#"+id);if(document.activeElement===el)return;el.innerHTML=`<option value="">${empty}</option>`+vals.map(v=>`<option ${v===cur?"selected":""}>${v}</option>`).join("")};
  const st=(inf.standard||{}).claude||{},ec=(inf.economy||{}).claude||{};
  fill("stdModel",c.allowedModels,st.model,"default");fill("stdEffort",c.allowedEffort,st.effort,"effort: default");
  fill("ecoModel",c.allowedModels,ec.model,"default");fill("ecoEffort",c.allowedEffort,ec.effort,"effort: default");
  const pr=(inf.premium||{}).claude;if(document.activeElement!==$("#premMode"))$("#premMode").value=pr&&pr.model!==c.premiumModel?"out":"";
  if(document.activeElement!==$("#conc"))$("#conc").value=String(c.unitConcurrency||c.maxConcurrency||2);
  if(c.unitConcurrency&&c.maxConcurrency&&c.unitConcurrency!==c.maxConcurrency)say("svcMsg",`note: unit says --concurrency ${c.unitConcurrency}, config.json says ${c.maxConcurrency}; the unit wins`);
  const S=D.skills||[];$("#skillCap").firstChild.textContent=S.length?`${S.filter(x=>x.on).length} of ${S.length} on. `:"";
  $("#skills").innerHTML=S.length?S.map(x=>`<label><input type="checkbox" data-id="${x.id}" ${x.on?"checked":""}> ${x.id}${x.note?` <small>— ${esc(x.note)}</small>`:""}</label>`).join(""):'<span class="muted">skills list unavailable</span>';
  $("#skills").querySelectorAll("input").forEach(i=>i.onchange=async()=>{i.disabled=true;say("skillMsg",`${i.checked?"enabling":"disabling"} ${i.dataset.id}…`);try{await post("/api/skills",{id:i.dataset.id,on:i.checked});say("skillMsg",`${i.dataset.id} ${i.checked?"on":"off"} — restart the worker to apply`,"ok");load(true)}catch(e){say("skillMsg",e.message,"err");i.checked=!i.checked}i.disabled=false});
}
$("#saveCfg").onclick=async()=>{const inf={};const st=$("#stdModel").value,se=$("#stdEffort").value,ec=$("#ecoModel").value,ee=$("#ecoEffort").value;
  if(st)inf.standard={claude:{model:st,...(se?{effort:se}:{})}};else if(se)return say("cfgMsg","pick a model for standard before an effort","err");
  if(ec)inf.economy={claude:{model:ec,...(ee?{effort:ee}:{})}};else if(ee)return say("cfgMsg","pick a model for economy before an effort","err");
  if($("#premMode").value==="out")inf.premium={claude:{model:"claude-opus-5",effort:"medium"}};
  say("cfgMsg","saving…");try{const r=await post("/api/config",{inference:inf,maxConcurrency:+$("#conc").value});say("cfgMsg",r.changed.length?`saved (${r.changed.join(", ")}) — restart the worker to apply`:"nothing changed","ok");load(true)}catch(e){say("cfgMsg",e.message,"err")}};
const wact=(a,confirmTxt)=>async()=>{if(confirmTxt&&!confirm(confirmTxt))return;say("svcMsg",a+"…");try{const r=await post("/api/worker",{action:a});say("svcMsg",`worker ${r.state}`,r.state==="active"?"ok":"err");setTimeout(()=>load(true),3000)}catch(e){say("svcMsg",e.message,"err")}};
$("#wRestart").onclick=wact("restart","Restart the worker? A task in progress is released and reassigned by the network.");
$("#wStop").onclick=wact("stop","Stop the worker? It stays stopped until you press start (or reboot).");
$("#wStart").onclick=wact("start");
function renderUpdates(){const U=D.updates||{},I=U.installed||{},L=U.latest||null,R=U.releases||[];const el=$("#updInstalled");if(!el)return;
  el.innerHTML=`<b>${esc(I.build||"?")}</b>${I.commit?` <span class="muted">· ${esc(I.commit.slice(0,12))}</span>`:""}${I.installedAt?` <span class="muted">· installed ${ago(new Date(I.installedAt*1000).toISOString())}</span>`:""}`;
  $("#updLatest").innerHTML=L?`<b>${esc(L.build)}</b> <span class="muted">· ${(L.publishedAt||"").replace("T"," ").slice(0,16)} UTC · </span>${U.available?'<span class="tag alarm">update available</span>':'<span class="tag ok">up to date</span>'} <a class="ext" href="${L.url}" target="_blank" rel="noopener">github ↗</a>`:`<span class="muted">${esc(U.releasesError||"not fetched yet")}</span>`;
  $("#updInfo").textContent=`${R.length} releases · checked ${U.releases&&U.releases.length?"within 15 min":"–"}`;
  const cb=$("#updAuto");if(!cb.dataset.dirty){cb.checked=!!U.autoUpdate;$("#updAutoTxt").textContent=U.autoUpdate?"on · checks every 5 min":"off · manual only"}
  $("#updNow").disabled=!U.available;$("#updNow").textContent=U.available?`update to ${L.build}`:"up to date";
  const cache=new Set((I.cache||[]).map(c=>c.tag));
  $("#updTable").innerHTML=`<tr><th></th><th>release · what changed</th><th>published (UTC)</th></tr>`+R.map(r=>{const cur=r.build===I.build;const notes=(r.notes||"").replace(/^## What changed since [^\n]*\n*/,"").split("\n").filter(l=>l.trim()&&!/^##|^Source commit|^Install |^SHA-256/.test(l.trim())).slice(0,4).map(l=>esc(l.replace(/^\s*-\s*/,"· ").trim())).join("<br>");
    return`<tr${cur?' class="open"':""}><td class="act">${cur?'<span class="tag ok">installed</span>':`<button data-rb="${esc(r.tag)}" data-build="${esc(r.build)}" class="${r.build===(L||{}).build?"":"alarm"}">${r.build===(L||{}).build?"install":"roll back"}</button>`}</td><td class="rel"><code>${esc(r.build)}</code>${cache.has(r.tag)?' <span class="muted" title="archive already downloaded and verified">cached</span>':""}<div class="rn">${notes||'<span class="muted">–</span>'}</div></td><td class="muted when">${(r.publishedAt||"").replace("T"," ").slice(0,16)}</td></tr>`}).join("");
  $("#updTable").querySelectorAll("button[data-rb]").forEach(b=>b.onclick=()=>updRollback(b.dataset.rb,b.dataset.build));
  $("#updHist").innerHTML=(U.history||[]).map(h=>`${iso(h.ts).replace("T"," ").slice(0,16)} · ${esc(h.by||"")}${h.action?` · <span${h.action==="failed"?' style="color:var(--alarm)"':""}>${esc(h.action)}</span>`:""}${h.from||h.to?` · ${esc(h.from||"?")} → ${esc(h.to||"?")}`:""}${h.note?` · <span class="muted">${esc(h.note)}</span>`:""}`).join("<br>")||"no updates recorded in the journal";
}
async function updRollback(tag,build){if(!confirm(`Install worker ${build}?\n\nThe release archive is downloaded from GitHub and verified against its SHA256SUMS, installed with npm, then the worker restarts (a task in progress is released). Auto-update is turned OFF so the daemon does not reinstall the latest release.`))return;
  say("updMsg",`installing ${build}… (download, verify, npm install, restart — up to a minute)`);try{const r=await post("/api/update",{action:"rollback",tag});say("updMsg",`${r.from} → ${r.to} · worker ${r.state}${r.autoUpdateTurnedOff?" · auto-update turned off":""}`,r.state==="active"?"ok":"err");delete $("#updAuto").dataset.dirty;load(true)}catch(e){say("updMsg",e.message,"err")}}
$("#updCheck").onclick=async()=>{say("updMsg","asking GitHub…");try{const r=await post("/api/update",{action:"check"});say("updMsg",r.available?`update available: ${r.installed} → ${r.latest}`:`up to date (${r.installed})`,r.available?"":"ok");load(true)}catch(e){say("updMsg",e.message,"err")}};
$("#updNow").onclick=async()=>{const U=D.updates||{};if(!confirm(`Update the worker to ${(U.latest||{}).build}?\n\nRuns imd update (GitHub release, SHA-256 verified) and restarts the worker; a task in progress is released.`))return;say("updMsg","updating… (up to a minute)");try{const r=await post("/api/update",{action:"update"});say("updMsg",r.changed?`${r.from} → ${r.to} · worker ${r.state}`:`already ${r.to}: ${r.output.slice(-160)}`,r.state==="active"?"ok":"err");load(true)}catch(e){say("updMsg",e.message,"err")}};
$("#updAuto").onchange=async e=>{const on=e.target.checked;e.target.dataset.dirty="1";if(!confirm(`Turn auto-update ${on?"ON":"OFF"}?\n\nThis edits the service unit's ExecStart and restarts the worker (a task in progress is released).`)){e.target.checked=!on;delete e.target.dataset.dirty;return}
  say("updMsg",`auto-update ${on?"on":"off"}… restarting`);try{const r=await post("/api/update",{action:"autoUpdate",on});say("updMsg",`auto-update ${r.autoUpdate?"on":"off"} · worker ${r.state}`,r.state==="active"?"ok":"err")}catch(e){say("updMsg",e.message,"err")}delete e.target.dataset.dirty;load(true)};
$("#cleanNow").onclick=async()=>{say("svcMsg","cleaning…");try{const r=await post("/api/cleanup",{});say("svcMsg",r.output||"done","ok");load(true)}catch(e){say("svcMsg",e.message,"err")}};
function inRange(){const s=since();return D.tasks.filter(t=>t.acceptedAt>=s)}
function hours(){const s=since();let H=D.hourly.filter(h=>h.ts>=s);if(!H.length)return[];
  // fill gaps
  const out=[];const end=Math.floor(Date.now()/1000/3600)*3600;let t=Math.max(H[0].ts,s?Math.floor(s/3600)*3600:H[0].ts);const m=new Map(H.map(h=>[h.ts,h]));
  for(;t<=end;t+=3600)out.push(m.get(t)||{ts:t,accepted:0,submitted:0,rateLimited:0,limitHits:0,models:{}});return out}

function svgChart(el,H,series,opts){
  // series: [{key,name,color,val:h=>n}] stacked bars; opts.markers: h=>count (alarm ticks)
  const W=1200,Hh=260,L=56,R=12,T=18,B=34,pw=W-L-R,ph=Hh-T-B;
  const tot=H.map(h=>series.reduce((a,s)=>a+s.val(h),0));const max=Math.max(1,...tot);
  const bw=pw/H.length,gap=Math.min(2,bw*.15),ticks=4;
  let g="";for(let i=0;i<=ticks;i++){const v=max*i/ticks,y=T+ph-ph*i/ticks;g+=`<line x1="${L}" x2="${W-R}" y1="${y}" y2="${y}" stroke="var(--soft)"/><text x="${L-6}" y="${y+4}" text-anchor="end" font-size="11" fill="var(--faint)">${opts.fmt(v)}</text>`}
  let bars="";H.forEach((h,i)=>{let y=T+ph;const x=L+i*bw+gap/2,w=Math.max(1,bw-gap);
    series.forEach((s,si)=>{const v=s.val(h);if(!v)return;const hh=ph*v/max;y-=hh;const last=si===series.length-1||!series.slice(si+1).some(z=>z.val(h));
      bars+=`<rect x="${x}" y="${y+(last?0:0)}" width="${w}" height="${Math.max(0,hh-(last?0:2))}" fill="${s.color}"/>`});
    const mk=opts.markers?opts.markers(h):0;if(mk)bars+=`<path d="M${x+w/2-5} ${T-2} l10 0 l-5 8 z" fill="var(--alarm)"><title>${mk} rate-limit hits</title></path>`;
    bars+=`<rect class="hit" data-i="${i}" x="${L+i*bw}" y="${T}" width="${bw}" height="${ph}" fill="transparent"/>`});
  let xl="";const step=Math.ceil(H.length/12);H.forEach((h,i)=>{if(i%step)return;const d=new Date(h.ts*1000);xl+=`<text x="${L+i*bw+bw/2}" y="${Hh-B+16}" text-anchor="middle" font-size="11" fill="var(--faint)">${pad(d.getUTCHours())}:00</text>`;if(d.getUTCHours()<step||i===0)xl+=`<text x="${L+i*bw+bw/2}" y="${Hh-B+30}" text-anchor="middle" font-size="10" fill="var(--faint)">${d.getUTCMonth()+1}/${pad(d.getUTCDate())}</text>`});
  const legend=series.map(s=>`<span><i class="sw" style="background:${bgc(s.color)}"></i>${s.name}</span>`).join("")+(opts.markers?`<span><i class="sw" style="background:var(--alarm);clip-path:polygon(0 0,100% 0,50% 100%)"></i>rate-limit hit</span>`:"");
  el.innerHTML=`<div class="legend">${legend}</div><svg viewBox="0 0 ${W} ${Hh}" font-family="var(--mono)">${g}<line x1="${L}" x2="${W-R}" y1="${T+ph}" y2="${T+ph}" stroke="var(--dim)"/>${bars}${xl}</svg><div class="tip"></div>`;
  const tip=el.querySelector(".tip"),svg=el.querySelector("svg");
  svg.addEventListener("mousemove",e=>{const r=e.target.closest(".hit");if(!r){tip.style.display="none";return}const h=H[+r.dataset.i];tip.innerHTML=opts.tip(h);tip.style.display="block";
    const b=el.getBoundingClientRect();let x=e.clientX-b.left+14,y=e.clientY-b.top+14;if(x+tip.offsetWidth>b.width-8)x=e.clientX-b.left-tip.offsetWidth-14;tip.style.left=x+"px";tip.style.top=y+"px"});
  svg.addEventListener("mouseleave",()=>tip.style.display="none");
  if(!H.length)el.innerHTML='<div class="empty">no data in range</div>';
}
const opusTok=o=>Object.entries(o||{}).reduce((a,[m,v])=>a+(m.startsWith("claude-opus-")?v:0),0);
const mv=(h,m,k)=>(h.models[m]||{})[k]||0;
function renderEpisodes(){
  const s=since();const E=D.episodes.filter(e=>e.end>=s).slice().reverse();
  const th=`<tr><th>start (UTC)</th><th>duration</th><th class="num">hits</th><th>Claude said</th><th class="num">Opus tokens, prev hour</th><th class="num">Sonnet tokens, prev hour</th><th class="num">sessions prev hour</th></tr>`;
  $("#episodes").innerHTML=E.length?th+E.map(e=>`<tr><td>${dt(e.start)}</td><td>${e.durationMin} min</td><td class="num">${e.hits}</td><td class="title">${esc(e.claudeMsg||"–")}</td><td class="num">${fmt(opusTok(e.prevHour))}</td><td class="num">${fmt(e.prevHour["claude-sonnet-5"]||0)}</td><td class="num">${e.prevHour.sessions||0}</td></tr>`).join(""):`<tr><td class="empty">no rate-limit episodes in range</td></tr>`;
}
function renderByModel(){
  const rows=Object.entries(D.byModel).sort((a,b)=>b[1].cost-a[1].cost);
  $("#bymodel").innerHTML=`<tr><th>model</th><th class="num">sessions</th><th class="num">turns</th><th class="num">turns/sess</th><th class="num">output</th><th class="num">thinking</th><th class="num">fresh input</th><th class="num">cache reads</th><th class="num">cache hit</th><th class="num">avg duration</th><th class="num">API-equiv cost</th><th class="num">$/session</th></tr>`+
    rows.map(([m,c])=>{const fresh=(c.input_tokens||0)+(c.cache_creation_input_tokens||0),cr=c.cache_read_input_tokens||0;return`<tr><td><span class="tag ${mi(m).cls}">${mi(m).n}</span></td><td class="num">${c.sessions}</td><td class="num">${fmt(c.turns)}</td><td class="num">${c.sessions?Math.round(c.turns/c.sessions):0}</td><td class="num">${fmt(c.output_tokens)}</td><td class="num">${n0(c.thinking)}</td><td class="num">${fmt(fresh)}</td><td class="num">${fmt(cr)}</td><td class="num">${fresh+cr?Math.round(cr/(fresh+cr)*100):0}%</td><td class="num">${c.sessions?dur(c.durationS/c.sessions):"–"}</td><td class="num">${usd(c.cost)}</td><td class="num">${c.sessions?usd(c.cost/c.sessions):"–"}</td></tr>`}).join("");
}
function fillFilters(){
  const opt=(sel,vals)=>{const cur=sel.value;sel.innerHTML=sel.options[0].outerHTML+vals.map(v=>`<option>${esc(v)}</option>`).join("");sel.value=cur};
  opt($("#fModel"),[...new Set(D.tasks.map(t=>t.model||"unknown"))].sort());opt($("#fStatus"),[...new Set(D.tasks.map(t=>t.status))].sort());
}
const srvTitle=t=>{const a=t.server&&t.server.attempt;if(!a){if(t.panel)return`research panel ${t.panel.state}: ${t.panel.answers} of ${t.panel.wanted} answers, quorum ${t.panel.quorum} (api.imd.fun/jobs/:id/panel)`;if(t.fuzz)return`fuzz campaign ${t.fuzz.state}: ${t.fuzz.runs} runs, ${t.fuzz.confirmed} confirmed${t.fuzz.ours?", ours "+t.fuzz.ours.outcome:""} (api.imd.fun/jobs/:id/fuzz)`;return"verdict from api.imd.fun/seats"}const u=a.usage||{};return`server record: ${a.outcome||""}${a.accepted?" · accepted":""} · attempt ${a.attempt||"?"} · ${u.model||"?"} on ${u.runtime||"?"} · ${u.turns??"?"} turns · ${fmt(u.output)} out · ${fmt(u.cached)} cached · ${dur((u.wallClockMs||0)/1000)} wall${a.verdict?` · verifier: ${a.verdict.status} (${a.verdict.evaluation||""}) ${a.verdict.detail||""}`:""}${a.oracle?` · oracle: ${a.oracle.status} — ${a.oracle.detail||""}`:""}`};
const stState=s=>({completed:"ok",live:"ok",named:"ok",accepted:"ok",executing:"",pending:"",parked:"alarm",blocked:"alarm",failed:"alarm",cancelled:"alarm",superseded:"alarm",rejected:"alarm"})[s]||"";
const wfBlock=t=>{const w=t.workflow;if(!w)return"";const st=(w.stages||[]).map(x=>`<span class="tag ${stState(x.state)}" title="${esc(x.name)} stage: ${esc(x.state)}">${esc(x.name)} · ${esc(x.state)}</span>`).join(" ");
  const tb=(t.jobInfo||{}).takenBy;return`<b>workflow</b> <a class="ext" href="${esc(w.explorerUrl||w.url||"https://api.imd.fun/workflows/"+w.id)}" target="_blank" rel="noopener" title="${w.explorerUrl?"explorer page of the workflow":"api.imd.fun/workflows/"+esc(w.id)}"><code>${esc((w.id||"").slice(0,8))}</code> ↗</a> <a class="ext" href="${esc(w.url||"https://api.imd.fun/workflows/"+w.id)}" target="_blank" rel="noopener" title="api.imd.fun/workflows/${esc(w.id)}">json</a>${tb?` · <span style="color:var(--alarm)">this step was delivered by seat #${esc(tb)}, not by us</span>`:""}${w.stage?` · this task = <b>${esc(w.stage)}</b> stage`:""} · <span class="tag ${stState(w.status)}">${esc(w.status||"?")}</span>${w.chain?` · ${esc(w.chain)}`:""}${w.waitingForHosting?" · waiting for hosting":""}${w.failure?` · <span style="color:var(--alarm)">${esc(String(w.failure).slice(0,160))}</span>`:""}${st?`<br><span class="muted">stages</span> ${st}`:""}${w.siteUrl?` · <a class="ext" href="${esc(w.siteUrl)}" target="_blank" rel="noopener">${esc((w.site||{}).ensName||"site")} ↗</a>`:""}${(w.contracts||{}).repoUrl&&w.stage!=="contracts"?` · <a class="ext" href="${esc(w.contracts.repoUrl)}" target="_blank" rel="noopener">contracts repo ↗</a>`:""}${(w.frontend||{}).repoUrl&&w.stage!=="frontend"?` · <a class="ext" href="${esc(w.frontend.repoUrl)}" target="_blank" rel="noopener">frontend repo ↗</a>`:""}${w.objective?`<div class="muted" style="margin:2px 0 0 0;font-size:11px">${esc(w.objective.slice(0,220))}${w.objective.length>220?"…":""}</div>`:""}`};
const resultBlock=t=>{const r=t.result||{},ji=t.jobInfo||{},dv=r.delivery||ji.delivery||null,site=ji.site||null,files=r.files||[];if(!dv&&!site&&!files.length&&!(r.source||[]).length)return"";
  const bits=[];if(dv&&(dv.repoUrl||dv.deliveredAt||dv.failure))bits.push(`<b>delivered</b> ${dv.mode?esc(dv.mode)+" · ":""}${dv.repoUrl?`<a class="ext" href="${esc(dv.repoUrl)}" target="_blank" rel="noopener">${esc(dv.repoUrl.replace(/^https:\/\/github\.com\//,""))} ↗</a>`:""}${dv.commit?` <code title="${esc(dv.commit)}">${esc(dv.commit.slice(0,8))}</code>`:""}${dv.pullRequestUrl?` · <a class="ext" href="${esc(dv.pullRequestUrl)}" target="_blank" rel="noopener">PR ↗</a>`:""}${dv.cid?` · ipfs <code>${esc(String(dv.cid).slice(0,12))}…</code>`:""}${dv.deliveredAt?` · ${ago(dv.deliveredAt)}`:""}${dv.failure?` · <span style="color:var(--alarm)">${esc(String(dv.failure).slice(0,160))}</span>`:""}`);
  if(site&&(site.url||site.ensName))bits.push(`<b>site</b> <a class="ext" href="${esc(site.url||("https://"+site.ensName+".limo"))}" target="_blank" rel="noopener">${esc(site.ensName||site.label||site.url)} ↗</a> · ${esc(site.status||"")}${site.cid?` · cid <code>${esc(String(site.cid).slice(0,12))}…</code>`:""}`);
  if(files.length)bits.push(`<b>files</b> ${files.map(f=>`<a class="ext" href="${esc(f.url||"#")}" target="_blank" rel="noopener" title="${esc(f.path||"")} · ${esc(f.mediaType||"")} · ${fmt(f.bytes)} B · sha256 ${esc(f.hash||"")}">${esc(f.name||f.path)} ↗</a> <span class="muted">${esc(f.mediaType||"")} ${fmt(f.bytes)} B</span>`).join(" · ")}`);
  if((r.source||[]).length)bits.push(`<span class="muted">accepted bundle: ${r.source.map(x=>`${esc(x.node||"")} (${esc(x.evaluation||"")}${x.profile&&x.profile!=="none"?" · "+esc(x.profile):""}) <a class="ext" href="${esc(x.url||"#")}" target="_blank" rel="noopener">${esc(x.hash||"")} ↗</a>`).join(", ")}</span>`);
  return bits.join("<br>")};
const panelBlock=t=>{const p=t.panel,f=t.fuzz;if(p){const o=p.ours||{};return`<b>research panel</b> <span class="tag ${stState(p.state)}">${esc(p.state||"?")}</span> · ${p.answers??0} of ${p.wanted??"?"} answers, quorum ${p.quorum??"?"}${p.vendors?` · ${esc(p.vendors.join(", "))}`:""}${p.ours?` · ours: ${o.turns??"?"} turns · ${fmt(o.output)} out · ${o.citations??0} citations · ${dur((o.wallClockMs||0)/1000)}`:` · <span class="muted">our answer is not on the panel</span>`} <a class="ext" href="${esc(p.url)}" target="_blank" rel="noopener">json ↗</a>${o.answer?`<details><summary class="muted">our answer</summary><pre>${esc(o.answer)}</pre></details>`:""}`}
  if(f){const o=f.ours||{};return`<b>fuzz campaign</b> <span class="tag ${stState(f.state)}">${esc(f.state||"?")}</span> · ${f.runs??0} runs · ${f.confirmed??0} confirmed · ${f.results??0} results (${esc(Object.entries(f.outcomes||{}).map(([k,v])=>k+"×"+v).join(", "))})${f.ours?` · ours: ${esc(o.outcome||"?")}${o.property?" · "+esc(o.property):""}${o.runs!=null?" · "+o.runs+" runs":""}${o.verdictStatus?" · verdict "+esc(o.verdictStatus):""}`:""} <a class="ext" href="${esc(f.url)}" target="_blank" rel="noopener">json ↗</a>${o.detail?`<details><summary class="muted">detail</summary><pre>${esc(o.detail)}</pre></details>`:""}`}
  return""};
const protoDetail=t=>[wfBlock(t),panelBlock(t),resultBlock(t)].filter(Boolean).map(x=>"<br>"+x).join("");
const srvDetail=t=>{const a=t.server&&t.server.attempt;if(!a)return"";const u=a.usage||{},v=a.verdict||{},o=a.oracle||null,f=t.server.field||{};const sw=t.seatWork||{};
  return`<br><b>network</b> ${esc(sw.nodeKey||"")}${sw.role?` (${esc(sw.role)})`:""} · job ${esc(sw.jobState||"")}${sw.launch?` · launch ${esc(sw.launch)}`:""} · attempt ${a.attempt||"?"} ${esc(a.outcome||"")} · ${esc(u.model||"?")} on ${esc(u.runtime||"?")} · ${u.turns??"?"} turns · ${fmt(u.output)} out · ${fmt(u.cached)} cached · ${dur((u.wallClockMs||0)/1000)} wall · field ${f.attempts||0} attempts / ${f.seats||0} seats / ${f.accepted||0} ✓${v.status?`<br><b>verifier</b> ${esc(v.status)} (${esc(v.evaluation||"")}) ${esc(v.detail||"")}${v.rejectionCode?` · code ${esc(v.rejectionCode)}`:""}${(v.failedChecks||[]).length?` · failed: ${esc(v.failedChecks.join(", "))}`:""}`:""}${o?`<br><b>oracle</b> ${esc(o.status||"")} — ${esc(o.detail||"")}`:""}${t.review?`<br><b>review</b> ${esc(t.review.verdict||"")} · ${esc(t.review.policy||"")} · ${esc(t.review.status||"")}${t.review.tx?` · <a class="ext" href="https://etherscan.io/tx/${t.review.tx}" target="_blank" rel="noopener">tx ↗</a>`:""}`:""}${a.summary?`<br><b>summary</b> <span class="muted">${esc(a.summary.slice(0,400))}</span>`:""}`};
const VLABEL={noquorum:"no quorum",blocked:"blocked"};const vlabel=v=>VLABEL[v]||v;const isBad=v=>v==="rejected"||v==="failed";const isClosed=v=>v==="noquorum"||v==="blocked";
const VRANK=t=>t.verdict==="accepted"?4:t.verdict==="pending"?3:isBad(t.verdict)?2:isClosed(t.verdict)?1.5:t.status==="submitted"?3:t.status==="accepted"?5:1;
const outcomeCell=t=>{const v=t.verdict;const rel=t.status==="rate-limited"||t.status==="cancelled";
  const tag=v?`<span class="tag ${v==="accepted"?"ok":isBad(v)?"alarm":isClosed(v)?"dimtag":""}" title="${esc(isClosed(v)&&t.reason?t.reason.reason:srvTitle(t))}">${vlabel(v)}</span>`:rel?`<span class="tag alarm" title="${t.status==="cancelled"?esc(t.cancelReason||"cancelled by the network"):"released: Claude rate limit hit while it ran"}">${t.status==="rate-limited"?"released":t.status}</span>`:t.status==="submitted"?'<span class="tag" title="submitted, no verdict yet">sent</span>':`<span class="tag lamp">${esc(t.status||"")}</span>`;
  const why=t.reason&&t.reason.reason?`<span class="reason${isClosed(v)?" dimr":""}" title="${esc(t.reason.reason)}">${esc(t.reason.reason)}</span>`:t.explorer&&(t.explorer.answer||t.explorer.word)?`<span class="reason dimr" title="${esc([t.explorer.answer,t.explorer.word].filter(Boolean).join(" · "))}">${esc([t.explorer.answer,t.explorer.word].filter(Boolean).join(" · "))}</span>`:"";
  const ji=t.jobInfo||{};const after=!v&&ji.takenBy?`<span class="reason dimr" title="we did not deliver this step; the network's record credits seat #${esc(ji.takenBy)} · job ${esc(ji.state||"")}">job ${esc(ji.state||"done")} by #${esc(ji.takenBy)}</span>`:!v&&rel&&ji.state?`<span class="reason dimr" title="the job on the network is ${esc(ji.state)}">job ${esc(ji.state)}</span>`:"";
  return tag+(t.attempts>1?` <span class=muted>×${t.attempts}</span>`:"")+why+after};
const netCell=t=>{const f=t.server&&t.server.field;const fld=f&&f.attempts?`<span title="${f.attempts} attempts by ${f.seats} seats on this job, ${f.accepted} accepted · runtimes ${esc(Object.entries(f.runtimes||{}).map(([k,v])=>k+"×"+v).join(", "))}">${f.seats}<span class=muted>·${f.accepted}✓</span></span>`:'<span class="muted">–</span>';
  const ch=t.onchain?` <a class="ext" href="${t.onchain.txUrl}" target="_blank" rel="noopener" title="${t.onchain.source==="feedback"?"feedback batch":"review"} sent to the reputation registry · ${t.onchain.at||""}${t.records?` · work record: ${t.records.sent||0}/${t.records.count||0} sent`:""}">⛓</a>`:t.review?` <span class="muted" title="review ${t.review.status} (${t.review.policy||""}, ${t.review.verdict}) — the batch to the registry has not been sent yet">⛓</span>`:"";
  const wf=t.workflow?` <span class="muted" title="stage ${esc(t.workflow.stage||"")} of workflow ${esc(t.workflow.id||"")} · ${esc(t.workflow.status||"")}">⧉</span>`:"";
  return fld+ch+wf};
const COLS=[["acceptedAt","time (UTC)",t=>dt(t.acceptedAt)],
  ["id","task",t=>`${t.jobUrl?(t.jobPublished===false?`<a class="ext" href="${t.jobUrl}" target="_blank" rel="noopener" title="job ${t.job}: the explorer publishes the job page once the job is done — this opens your agent's pending list"><code>${t.id}</code> ⧗</a>`:`<a class="ext" href="${t.jobUrl}" target="_blank" rel="noopener" title="open job ${t.job} on explorer.imd.fun"><code>${t.id}</code> ↗</a>`):`<code>${t.id}</code>`}`],
  ["open","detail",t=>`<a class="opn" data-open="${t.id}" title="prompt, timeline, network calls, produced files">open</a>`],
  ["kind","kind",t=>`<span class="ell k" title="${esc(t.seatWork?`step ${t.seatWork.nodeKey||"?"} · role ${t.seatWork.role||"?"} · job ${t.seatWork.jobState||"?"}${t.seatWork.launch?" · launch "+t.seatWork.launch:""} · worker kind ${t.kind||""}`:"worker: "+(t.kind||""))}">${esc(t.kindLabel||t.kind||"")}</span>`,"",t=>t.kindLabel||t.kind||""],
  ["tier","tier",t=>t.tier?`<span class="tag ${t.tier==="economy"?"":t.tier==="premium"?"m3":"lamp"}">${t.tier.slice(0,4)}</span>`:'<span class="muted">–</span>'],
  ["model","model",t=>t.model?`<span class="tag ${mi(t.model).cls}" title="${esc(t.model)}${t.effort?" · effort "+t.effort:""}">${mi(t.model).n}${t.effort?` · ${t.effort.slice(0,3)}`:""}</span>`:'<span class="muted">–</span>',"",t=>(t.model||"")+" "+(t.effort||"")],
  ["turns","turns",t=>`${t.turns}${t.maxTurns?"<span class=muted>/"+t.maxTurns+"</span>":""}`,"num"],
  ["out","out",t=>n0(t.usage.output_tokens||0),"num",t=>t.usage.output_tokens||0],
  ["fresh","fresh",t=>`<span title="uncached input + cache writes ${fmt((t.usage.input_tokens||0)+(t.usage.cache_creation_input_tokens||0))} · cache reads ${fmt(t.usage.cache_read_input_tokens||0)}">${n0((t.usage.input_tokens||0)+(t.usage.cache_creation_input_tokens||0))}</span>`,"num",t=>(t.usage.input_tokens||0)+(t.usage.cache_creation_input_tokens||0)],
  ["costUSD","cost",t=>usd(t.costUSD),"num"],["durationS","time",t=>dur(t.durationS),"num"],
  ["verdict","outcome",outcomeCell,"",VRANK],
  ["field","net",netCell,"num",t=>(t.server&&t.server.field&&t.server.field.seats)||0],
  ["title","the ask",t=>`<span class="ell" title="${esc(t.title||"")}">${esc(t.title||"")}</span>`,"ttl"]];
const TH_TIP={out:"output tokens generated by the model",fresh:"uncached input + cache writes — what burns quota (hover a value for cache reads)",costUSD:"API-equivalent estimate",turns:"turns used / max turns",durationS:"wall-clock duration",verdict:"the network's verdict; before it arrives, the worker's status (sent / released / cancelled)",field:"seats on the job · accepted; ⛓ = on the reputation registry; ⧉ = stage of a workflow",title:"what the swarm asked (hover for the full text, open for the prompt)",tier:"eco = economy, stan = standard, prem = premium (server-assigned)",model:"model · effort (low / med / hig / xhi / max)"};
function renderTasks(){
  let T=filteredTasks();
  const col=COLS.find(c=>c[0]===sort.k);const key=col&&col[4]?col[4]:t=>t[sort.k];
  T.sort((a,b)=>{const x=key(a),y=key(b);return(x>y?1:x<y?-1:0)*sort.d});
  $("#taskCount").textContent=T.length;const sm={ok:0,bad:0,pend:0,rel:0,noq:0,blk:0,cost:0,out:0,secs:0};T.forEach(t=>{if(t.verdict==="accepted")sm.ok++;else if(isBad(t.verdict))sm.bad++;else if(t.verdict==="noquorum")sm.noq++;else if(t.verdict==="blocked")sm.blk++;else if(t.status==="rate-limited"||t.status==="cancelled")sm.rel++;else sm.pend++;sm.cost+=t.costUSD||0;sm.out+=t.usage.output_tokens||0;sm.secs+=t.durationS||0});
  $("#taskInfo").innerHTML=`${T.length} shown · <span class="sok">${sm.ok} ✓</span> · <span class="sbad">${sm.bad} ✗</span> · ${sm.pend} pending${sm.noq?` · ${sm.noq} no quorum`:""}${sm.blk?` · ${sm.blk} blocked`:""} · ${sm.rel} released · ${usd(sm.cost)} · ${fmt(sm.out)} out · ${dur(sm.secs)}`;
  const th=`<tr>${COLS.map(c=>`<th class="${c[3]||""} ${sort.k===c[0]?"sorted":""}" data-k="${c[0]}" title="${TH_TIP[c[0]]||""}">${c[1]}${sort.k===c[0]?`<span class="arrow"> ${sort.d>0?"▲":"▼"}</span>`:""}</th>`).join("")}</tr>`;
  const vcls=t=>t.verdict==="accepted"?"v-ok":isBad(t.verdict)?"v-bad":isClosed(t.verdict)?"v-rel":(t.status==="rate-limited"||t.status==="cancelled")?(t.turns?"v-rel":"v-rel v-dim"):"v-pend";
  $("#tasks").innerHTML=th+(T.length?T.map(t=>`<tr class="task ${vcls(t)} ${open.has(t.id)?"open":""}" data-id="${t.id}">${COLS.map(c=>`<td class="${c[3]||""}">${c[2](t)}</td>`).join("")}</tr>`+(open.has(t.id)?`<tr class="detail"><td colspan="${COLS.length}"><div><div class="full">${esc(t.title||"")}</div><b>outputs</b> ${esc(t.outputs||"–")} · <b>sessions</b> ${t.sessions} · <b>thinking</b> ${fmt(t.thinking)} · <b>job</b> ${t.jobUrl?`<a class="ext" href="${t.jobUrl}" target="_blank" rel="noopener">${t.job}</a>`:"–"}${t.submissionId?` · <b>submission</b> ${t.submissionId}`:""}${t.cancelReason?` · <b>cancel</b> ${esc(t.cancelReason)}`:""}<br><b>tools</b> ${Object.entries(t.tools).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}×${v}`).join(", ")||"–"}${t.limitHits?`<br><b style="color:var(--alarm)">limit</b> ${t.limitHits}× “${esc(t.limitMsg)}”`:""}${t.lastText?`<br><b>last message</b> ${esc(t.lastText)}`:""}${srvDetail(t)}${protoDetail(t)}</div></td></tr>`:"")).join(""):`<tr><td colspan="${COLS.length}" class="empty"><div>no tasks match</div></td></tr>`);
  syncScroll();
  $("#tasks").querySelectorAll("th").forEach(h=>h.onclick=()=>{const k=h.dataset.k;sort=sort.k===k?{k,d:-sort.d}:{k,d:k==="acceptedAt"||COLS.find(c=>c[0]===k)[3]==="num"?-1:1};renderTasks()});
  $("#tasks").querySelectorAll("tr.task").forEach(r=>r.onclick=e=>{if(e.target.closest("a"))return;const id=r.dataset.id;open.has(id)?open.delete(id):open.add(id);renderTasks()});
  $("#tasks").querySelectorAll("[data-open]").forEach(a=>a.onclick=e=>{e.stopPropagation();openTranscript(a.dataset.open)});
}
function renderFeed(){
  const s=since();const E=D.events.filter(e=>e.ts>=s).slice().reverse();
  $("#feed").innerHTML=E.length?E.map(e=>`<div class="${e.type}"><span class="t">${dt(e.ts)}</span><span>${esc(e.msg)}</span></div>`).join(""):'<div class="empty">no events in range</div>';
}

function renderTierLog(){
  const L=D.tierLog||{},snaps=L.snapshots||[];
  const cell=v=>!v?'<span class="muted">–</span>':`<span class="tag ${mi(v.model).cls}">${mi(v.model).n} · ${v.effort||"default"}</span>${v.optOut?' <span class="muted">opted out</span>':""}`;
  const when=ts=>ts?dt(ts):'<span class="muted">before the log</span>';
  const warn=L.pending?`<div class="msg err">config.json was edited after the worker last started — the new mapping is not in force yet, restart the worker to apply it</div>`:"";
  $("#effTierLog").innerHTML=`<div class="caption" style="padding:0 0 12px"><b>Tier history</b><p>Every task is labelled with the mapping in force when it ran, so a switch never relabels the past.</p></div>`+warn+
    `<div class="tscroll"><table class="wide"><tr><th>in force from (UTC)</th><th>economy</th><th>standard</th><th>premium</th><th>changed</th></tr>`+
    snaps.map(sn=>`<tr><td>${when(sn.ts)}</td><td>${cell(sn.tiers.economy)}</td><td>${cell(sn.tiers.standard)}</td><td>${cell(sn.tiers.premium)}</td>`+
      `<td class="muted">${sn.baseline&&!sn.changed.length?"first recorded mapping":sn.changed.length?esc(sn.changed.join(", ")):"–"}</td></tr>`).join("")+
    `</table></div><div class="muted" style="font-size:11px;margin-top:6px">a snapshot is recorded once the worker has restarted onto it${L.workerStartedAt?` · worker started ${dt(L.workerStartedAt)}`:""}</div>`;
}

function renderEffective(){
  const e=D.effective||{},t=e.tiers||{},u=e.unit||{},v=e.versions||{},g=(D.guard||{}).config||{},n=(D.notify||{}).config||{},h=(D.host||{}).timer||{};
  const row=(k,val,src)=>`<span>${k}</span><span>${val}${src?`<span class="src">${src}</span>`:""}</span>`;
  const tier=k=>{const x=t[k]||{};return x.model&&!x.optOut?`<span class="tag ${mi(x.model).cls}">${mi(x.model).n} · ${x.effort||"default"}</span>`:`<span class="tag alarm">${esc(x.note||"–")}</span>`};
  $("#effTiers").innerHTML=`<div class="caption" style="padding:0 0 12px"><b>Inference &amp; limits</b></div><div class="eff">`+
    TIER_ORDER.map(k=>row(k+" tier",tier(k),(t[k]||{}).source+((t[k]||{}).note?" · "+t[k].note:""))).join("")+
    row("concurrency",`${u.concurrency||"?"} <span class="muted">(unit)</span> · ${e.maxConcurrency||"?"} <span class="muted">(config.json)</span>`)+
    row("skills opt-out",e.skillsOptOut&&e.skillsOptOut.length?esc(e.skillsOptOut.join(", ")):"none")+
    row("budget guard",g.enabled?`on · ${fmt(g.windowTokens)} tokens / ${usd(g.windowCost)} per 5h${g.dailyCost?` · ${usd(g.dailyCost)}/day`:""} · ${g.waitForIdle?"waits for idle":"stops at once"} · ${g.resumeAtReset?"auto-resume":"manual resume"}`:"off")+
    row("notifications",[(n.telegramToken?"Telegram":""),(n.webhookUrl?"webhook":"")].filter(Boolean).join(" + ")||"none",n.telegramToken||n.webhookUrl?`heartbeat ${n.heartbeatMin} min · disk ${n.diskGB} GB · digest ${n.dailyHourUTC}:00 UTC`:"")+
    row("other config keys",e.otherKeys&&e.otherKeys.length?esc(e.otherKeys.join(", ")):"none")+`</div>`;
  $("#effUnit").innerHTML=`<div class="caption" style="padding:0 0 12px"><b>Service &amp; versions</b></div><div class="eff">`+
    row("worker",`${esc(v.worker||"?")} · runtime ${esc(u.runtime||"?")} · auto-update ${u.autoUpdate?"on":"off"}`)+
    row("Claude Code",esc(v.claude||"?"))+row("node",esc(v.node||"?"))+
    row("server",esc(e.server||"?"))+row("token id",`${esc(e.tokenId||"?")} <span class="muted">wallet ${esc((e.wallet||"").slice(0,10))}…</span>`)+
    row("cleanup timer",`${h.ActiveState||"?"} · next ${(h.NextElapseUSecRealtime||"?").slice(4,20)}`)+
    row("config.json",`<code>${esc(e.configPath||"")}</code>`)+row("unit",`<code>${esc(e.unitPath||"")}</code>`)+
    row("ExecStart",`<code style="font-size:11px">${esc(u.execStart||"")}</code>`)+`</div>`;
}
const effJSON=()=>JSON.stringify({exportedAt:new Date().toISOString(),effective:D.effective,guard:(D.guard||{}).config,notify:(D.notify||{}).config,skills:(D.skills||[]).filter(x=>x.on).map(x=>x.id)},null,2);
$("#effCopy").onclick=async()=>{try{await navigator.clipboard.writeText(effJSON());say("effMsg","copied","ok")}catch(e){say("effMsg","clipboard blocked — use download","err")}};
$("#effDl").onclick=()=>{download("imd-config-"+stamp()+".json",effJSON(),"application/json");say("effMsg","downloaded","ok")};

// exports
const stamp=()=>new Date().toISOString().slice(0,16).replace(/[-:T]/g,"");
function download(name,content,type){const b=new Blob([content],{type:type||"text/plain"});const a=document.createElement("a");a.href=URL.createObjectURL(b);a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},500)}
const iso=ts=>ts?new Date(ts*1000).toISOString().slice(0,19).replace("T"," "):"";
function toCSV(cols,rows){const q=v=>{v=v==null?"":String(v);return /[",\n;]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v};return "\ufeff"+[cols.map(c=>q(c[0])).join(",")].concat(rows.map(r=>cols.map(c=>q(c[1](r))).join(","))).join("\r\n")}
const taskCols=[["accepted_utc",t=>iso(t.acceptedAt)],["id",t=>t.id],["job",t=>t.job||""],["kind",t=>t.kindLabel||t.kind],["worker_kind",t=>t.kind],["answer",t=>(t.explorer&&t.explorer.answer)||""],["tier",t=>t.tier||""],["model",t=>t.model||""],["effort",t=>t.effort||""],["status",t=>t.status],["verdict",t=>t.verdict||""],["reason",t=>(t.reason&&t.reason.reason)||""],["onchain_tx",t=>(t.onchain&&t.onchain.txUrl)||""],["review_status",t=>(t.review&&t.review.status)||""],["node_key",t=>(t.seatWork&&t.seatWork.nodeKey)||""],["job_state",t=>(t.seatWork&&t.seatWork.jobState)||""],["server_model",t=>(t.server&&t.server.attempt&&t.server.attempt.usage.model)||""],["server_turns",t=>(t.server&&t.server.attempt&&t.server.attempt.usage.turns)||""],["server_out_tokens",t=>(t.server&&t.server.attempt&&t.server.attempt.usage.output)||""],["server_wall_s",t=>t.server&&t.server.attempt?Math.round((t.server.attempt.usage.wallClockMs||0)/1000):""],["workflow",t=>(t.workflow&&t.workflow.id)||""],["workflow_stage",t=>(t.workflow&&t.workflow.stage)||""],["workflow_status",t=>(t.workflow&&t.workflow.status)||""],["delivery_repo",t=>((t.result&&t.result.delivery)||(t.jobInfo&&t.jobInfo.delivery)||{}).repoUrl||""],["site_url",t=>((t.jobInfo&&t.jobInfo.site)||{}).url||""],["result_files",t=>((t.result&&t.result.files)||[]).map(f=>f.url).join(" ")],["panel_state",t=>(t.panel&&t.panel.state)||(t.fuzz&&t.fuzz.state)||""],["field_seats",t=>(t.server&&t.server.field&&t.server.field.seats)||""],["field_accepted",t=>(t.server&&t.server.field&&t.server.field.accepted)||""],
  ["turns",t=>t.turns],["max_turns",t=>t.maxTurns||""],["attempts",t=>t.attempts||""],["sessions",t=>t.sessions],["output_tokens",t=>t.usage.output_tokens||0],["input_tokens",t=>t.usage.input_tokens||0],["cache_write_tokens",t=>t.usage.cache_creation_input_tokens||0],["cache_read_tokens",t=>t.usage.cache_read_input_tokens||0],["thinking_tokens",t=>t.thinking||0],
  ["cost_usd",t=>(t.costUSD||0).toFixed(4)],["duration_s",t=>t.durationS],["limit_hits",t=>t.limitHits||0],["tools",t=>Object.entries(t.tools||{}).map(([k,v])=>k+"x"+v).join(" ")],["outputs",t=>t.outputs||""],["work_dir",t=>t.workDir||""],["title",t=>t.title||""]];
function filteredTasks(){const s=since(),fm=$("#fModel").value,fs=$("#fStatus").value,ft=$("#fTier").value,fv=$("#fVerdict").value,q=$("#fQ").value.toLowerCase();
  return D.tasks.filter(t=>t.acceptedAt>=s&&(!fm||(t.model||"unknown")===fm)&&(!fs||t.status===fs)&&(!ft||t.tier===ft)&&(!fv||t.verdict===fv)&&(!q||(t.id+" "+t.title+" "+(t.kindLabel||t.kind||"")+" "+Object.keys(t.tools).join(" ")+" "+(t.workDir||"")).toLowerCase().includes(q)))}
const CSV={
  "tasks-shown":()=>["tasks-filtered",taskCols,filteredTasks()],
  "tasks-all":()=>["tasks-all",taskCols,D.tasks],
  "events":()=>["events",[["time_utc",e=>iso(e.ts)],["type",e=>e.type],["message",e=>e.msg]],D.events],
  "episodes":()=>["rate-limit-episodes",[["start_utc",e=>iso(e.start)],["end_utc",e=>iso(e.end)],["duration_min",e=>e.durationMin],["hits",e=>e.hits],["claude_message",e=>e.claudeMsg||""],["opus_tokens_prev_hour",e=>opusTok(e.prevHour)],["sonnet_tokens_prev_hour",e=>e.prevHour["claude-sonnet-5"]||0],["fable_tokens_prev_hour",e=>e.prevHour["claude-fable-5-1"]||0],["sessions_prev_hour",e=>e.prevHour.sessions||0]],D.episodes],
  "days":()=>["daily-history",[["day",r=>r.day],["tasks",r=>r.tasks],["submitted",r=>r.submitted],["accepted",r=>r.accepted],["rejected",r=>r.rejected],["released",r=>r.released],["limit_errors",r=>r.limitHits],["guard_pauses",r=>r.guardPauses],["cost_usd",r=>(r.cost||0).toFixed(4)]].concat(dayModels((HIST&&HIST.days)||[]).map(m=>["cost_"+m,r=>(dayModelCost(r)[m]||0).toFixed(4)])).concat([["out_tokens",r=>r.outTokens],["fresh_tokens",r=>r.freshTokens],["turns",r=>r.turns],["onchain",r=>r.onchain]]),(HIST&&HIST.days)||[]],
  "bymodel":()=>["by-model",[["model",([m])=>m],["sessions",([,c])=>c.sessions],["turns",([,c])=>c.turns],["output_tokens",([,c])=>c.output_tokens||0],["thinking_tokens",([,c])=>c.thinking||0],["input_tokens",([,c])=>c.input_tokens||0],["cache_write_tokens",([,c])=>c.cache_creation_input_tokens||0],["cache_read_tokens",([,c])=>c.cache_read_input_tokens||0],["duration_s",([,c])=>Math.round(c.durationS||0)],["cost_usd",([,c])=>(c.cost||0).toFixed(4)]],Object.entries(D.byModel)],
  "hourly":()=>{const ms=[...new Set(D.hourly.flatMap(h=>Object.keys(h.models)))].sort();return["tokens-per-hour",[["hour_utc",h=>iso(h.ts)],["accepted",h=>h.accepted],["submitted",h=>h.submitted],["rate_limited",h=>h.rateLimited],["limit_hits",h=>h.limitHits||0]].concat(ms.flatMap(m=>[[m+"_fresh",h=>mv(h,m,"fresh")],[m+"_output",h=>mv(h,m,"output")],[m+"_cache_read",h=>mv(h,m,"cacheRead")],[m+"_cost",h=>(mv(h,m,"cost")||0).toFixed(4)]])),D.hourly]}};
document.querySelectorAll("[data-csv]").forEach(b=>b.onclick=()=>{try{const [name,cols,rows]=CSV[b.dataset.csv]();download(`imd-${name}-${stamp()}.csv`,toCSV(cols,rows),"text/csv");say("expMsg",`${name}: ${rows.length} rows`,"ok")}catch(e){say("expMsg",e.message,"err")}});
document.querySelectorAll("[data-log]").forEach(b=>b.onclick=async()=>{const w=b.dataset.log,h=$("#expHours").value;say("expMsg","fetching…");
  try{const r=await fetch(`/api/export?what=${w}&hours=${h}`,{headers:{"X-Dashboard":"1"}});if(!r.ok)throw new Error(r.statusText);const txt=await r.text();const js=w==="guard-log";
    download(`imd-${w}-${h==="0"?"all":"last"+h+"h"}-${stamp()}.${js?"json":"log"}`,txt,js?"application/json":"text/plain");say("expMsg",`${w}: ${js?JSON.parse(txt).length+" entries":txt.split("\n").length+" lines"}`,"ok")}catch(e){say("expMsg",e.message,"err")}});

// wrap every scrolling table once; toggle edge shadows as it scrolls / resizes
document.querySelectorAll(".tscroll").forEach(el=>{const w=document.createElement("div");w.className="tswrap";el.parentNode.insertBefore(w,el);w.appendChild(el);
  const info=document.createElement("div");info.className="tsinfo";info.innerHTML="scroll sideways for more columns <span class=\"kbd\">(shift + wheel)</span>";w.parentNode.insertBefore(info,w.nextSibling);
  el.addEventListener("scroll",()=>syncScroll(el),{passive:true})});
function syncScroll(one){(one?[one]:[...document.querySelectorAll(".tscroll")]).forEach(el=>{const w=el.parentNode;if(!w.classList.contains("tswrap"))return;
  w.classList.toggle("l",el.scrollLeft>2);w.classList.toggle("r",el.scrollWidth-el.clientWidth-el.scrollLeft>2)})}
addEventListener("resize",()=>syncScroll());


// ================================================================ oracle questions: which shapes of question pay and which never reach a quorum
function renderOracleQ(){const el=$("#oracleQ");if(!el||!D)return;const T=D.tasks.filter(t=>t.oracleQ);
  if(!T.length){el.innerHTML='<tr><td class="empty"><div>no oracle questions matched yet (the request list is fetched a few minutes after start)</div></td></tr>';return}
  const G=new Map();T.forEach(t=>{const q=t.oracleQ,k=q.family||"?";const g=G.get(k)||{k,n:0,ok:0,bad:0,noq:0,pend:0,cost:0,turns:0,secs:0,chains:new Set(),types:new Set(),ex:q.question};g.n++;g.cost+=t.costUSD||0;g.turns+=t.turns||0;g.secs+=t.durationS||0;if(q.chainId)g.chains.add(q.chainId);if(q.answerType)g.types.add(q.answerType);
    if(t.verdict==="accepted")g.ok++;else if(t.verdict==="rejected"||t.verdict==="failed")g.bad++;else if(t.verdict==="noquorum"||t.verdict==="blocked")g.noq++;else g.pend++;G.set(k,g)});
  const rows=[...G.values()].sort((a,b)=>b.n-a.n);const tot=rows.reduce((a,g)=>a+g.n,0);
  $("#oracleQInfo").textContent=`${tot} answers · ${rows.length} question shapes · ${rows.filter(g=>g.n>=3&&g.noq/g.n>=.5).length} shapes mostly without quorum`;
  el.innerHTML=`<tr><th>question shape</th><th>chains</th><th class="num">answers</th><th class="num">✓</th><th class="num">✗</th><th class="num">no quorum</th><th class="num">open</th><th class="num">paid</th><th class="num">cost</th><th class="num">$ / ✓</th><th class="num">avg turns</th><th class="num">avg time</th></tr>`+rows.map(g=>{const dec=g.ok+g.bad+g.noq;const paid=dec?Math.round(g.ok/dec*100):null;const cls=paid==null?"":paid>=70?"sok":paid<40?"sbad":"";
    return`<tr><td><span class="ell" style="max-width:420px" title="${esc(g.ex||"")}">${esc(g.k)}</span></td><td class="muted">${[...g.chains].map(c=>({1:"eth",8453:"base",42161:"arb",10:"op",4663:"4663"})[c]||c).join(" ")}${g.types.size?` <span class="muted">· ${[...g.types].join("/")}</span>`:""}</td><td class="num">${g.n}</td><td class="num sok">${g.ok}</td><td class="num sbad">${g.bad||'<span class="z">0</span>'}</td><td class="num">${g.noq||'<span class="z">0</span>'}</td><td class="num">${g.pend||'<span class="z">0</span>'}</td><td class="num ${cls}">${paid==null?"–":paid+"%"}</td><td class="num">${usd(g.cost)}</td><td class="num">${g.ok?usd(g.cost/g.ok):"–"}</td><td class="num">${Math.round(g.turns/g.n)}</td><td class="num">${dur(g.secs/g.n)}</td></tr>`}).join("")}
// ================================================================ the API sentinel: routes imd.fun/docs added since the last visit
function renderApiRoutes(){const el=$("#apiRoutes");if(!el||!D)return;const A=((D.network||{}).apiRoutes)||{};
  if(A.error){el.innerHTML=`<div class="muted">api sentinel: ${esc(A.error)}</div>`;return}
  const list=(A.new&&A.new.length?A.new:A.recent||[]);
  el.innerHTML=`<div class="caption" style="padding:12px 0 6px"><b>API sentinel</b> <span class="muted">· imd.fun/docs is read every 6 h and its route list diffed against the last visit${A.baseline?` · baseline taken ${A.baseline}`:""}</span></div><div class="eff"><div><span class="muted">documented routes</span> <b>${A.count??"–"}</b></div>`+
    (list.length?`<div><span class="muted">${A.new&&A.new.length?"NEW since last visit":"added in the last 14 days"}</span> ${list.map(x=>`<code title="since ${esc(x.since)}">${esc(x.route)}</code>`).join(" ")}</div>`:`<div><span class="muted">no new routes</span> <span class="muted">— the dashboard reads everything the docs list today</span></div>`)+
    ((A.removed||[]).length?`<div><span class="muted">removed</span> ${A.removed.map(x=>`<code>${esc(x.route)}</code>`).join(" ")}</div>`:"")+`</div>`}
