// ---------------------------------------------------------------- earnings: launch rewards, the ADAM airdrop, IMD payouts
// The server reads the chain and builds the calldata (/api/earnings, /api/earnings/tx); the browser's wallet signs.
// Wallets are found through EIP-6963 (several extensions side by side) with window.ethereum as the fallback.
const ERN={d:null,timer:null,provs:[],prov:null,acct:null,sel:null,show:"open",busy:false};
const eUsd=v=>v==null?"–":v>=1000?"$"+fmt(v):v>=0.01?"$"+v.toFixed(2):v>0?"<$0.01":"$0";
const ePx=v=>v==null?"–":v<1e-20?"≈0":v>=1?v.toFixed(2):v.toPrecision(3);
const eShort=a=>a?a.slice(0,6)+"…"+a.slice(-4):"";
const eIn=ts=>{const s=ts-Date.now()/1000;return s<=0?"now":s<3600?Math.ceil(s/60)+" min":dur(s)};

addEventListener("eip6963:announceProvider",e=>{const d=e.detail;if(!d||!d.provider||!d.info||ERN.provs.some(p=>p.info.uuid===d.info.uuid))return;ERN.provs.push(d);if(ERN.d)ernWallet()});
dispatchEvent(new Event("eip6963:requestProvider"));

async function ernLoad(force){
  clearTimeout(ERN.timer);
  if(!ERN.d)$("#ernInfo").textContent="reading the chain…";
  try{const r=await fetch("/api/earnings"+(force?"?refresh=1":""));const j=await r.json();if(!r.ok||j.error&&!j.items)throw new Error(j.error||r.statusText);ERN.d=j}
  catch(e){$("#ernInfo").textContent="failed: "+e.message;return}
  ernRender();
  // reward records arrive a few per refresh (api.imd.fun refuses bursts): keep asking while some are missing
  if(ERN.d.pending&&!document.querySelector('section[data-tab="earnings"]').hidden)ERN.timer=setTimeout(()=>ernLoad(false),20000);
}
function ernPicked(x){const g=x.gasUsd;return x.status==="claimable"&&!x.drained&&(x.valueUsd==null||g==null||x.valueUsd>2*g)}
function ernRender(){
  const d=ERN.d;if(!d)return;
  if(!d.wallet){$("#ernInfo").textContent=d.error||"no wallet";return}
  if(!ERN.sel)ERN.sel=new Set(d.items.filter(ernPicked).map(x=>x.launchId));
  ERN.sel.forEach(id=>{const x=d.items.find(i=>i.launchId===id);if(!x||x.status!=="claimable")ERN.sel.delete(id)});
  const t=d.totals||{},P=d.prices||{},A=d.adam||null,G=d.gas||{};
  $("#ernCount").textContent=t.claimable||"";
  $("#ernInfo").textContent=`wallet ${eShort(d.wallet)} · seat #${d.seat||"?"} · read ${hm(d.generatedAt)} UTC${d.pending?` · ${d.pending} reward records still loading`:""}`;
  const k=(lbl,val,sub)=>`<div><span>${lbl}</span><b>${val}</b><small>${sub}</small></div>`;
  $("#ernSum").innerHTML=
    k("claimable now",eUsd(t.claimableUsd),`${t.claimable||0} launch${t.claimable===1?"":"es"} · gas ≈ ${eUsd((G.mainnet||{}).claimUsd)} each on mainnet`)+
    (()=>{const n=d.items.filter(x=>x.status==="claimed").length;return k("claimed, at today's price",eUsd(t.claimedUsd),`${n} launch${n===1?"":"es"} · ${eUsd(t.heldUsd)} still held`)})()+
    k("IMD payouts",`${(t.payoutsImd||0).toFixed(2)} IMD`,`${d.payouts.length} payouts · ≈ ${eUsd(P.imdUsd!=null?t.payoutsImd*P.imdUsd:null)} today`)+
    (A?k("ADAM unlocked",fmt(A.claimable),`${fmt(A.claimed)} of ${fmt(A.share)} claimed · ≈ ${eUsd(A.priceUsd!=null?A.claimable*A.priceUsd:null)}`):"")+
    k("prices",`IMD ${eUsd(P.imdUsd)}`,`ETH ${eUsd(P.ethUsd)} (Chainlink) · gas ${G.mainnet&&G.mainnet.gwei!=null?G.mainnet.gwei.toFixed(2):"?"} gwei`);
  const msg=(d.errors||[]).length?`<span class="muted">partial read: ${esc(d.errors.slice(0,3).join(" · "))}</span>`:"";
  if(!ERN.busy&&msg)$("#ernMsg").innerHTML=msg;
  ernWallet();ernLaunches();ernAdam();ernPayouts();
}
// ---- wallet
function ernProvider(){return ERN.prov||(ERN.provs[0]&&ERN.provs[0].provider)||window.ethereum||null}
function ernWallet(){
  const el=$("#ernWallet"),d=ERN.d;if(!el||!d)return;
  if(!ernProvider()){el.innerHTML=`<span class="muted">No wallet in this browser. Open the panel in a desktop browser with a wallet extension (Rabby, MetaMask, …) or in a wallet app's browser to claim.</span>`;return}
  if(!ERN.acct){
    el.innerHTML=(ERN.provs.length>1?`<select id="ernProv">${ERN.provs.map((p,i)=>`<option value="${i}">${esc(p.info.name)}</option>`).join("")}</select>`:"")+
      `<button id="ernConnect" class="primary">connect wallet</button><span class="muted">${ERN.provs.length===1?esc(ERN.provs[0].info.name)+" · ":""}the panel only asks for your address; every claim is a transaction you confirm in the wallet</span>`;
    $("#ernConnect").onclick=ernConnect;return}
  const mine=ERN.acct.toLowerCase()===d.wallet;
  el.innerHTML=`<i class="dot on"></i><span>connected <code>${esc(eShort(ERN.acct))}</code></span>`+
    (mine?`<span class="muted">the seat wallet</span>`:`<span class="tag lamp">not the seat wallet</span><span class="muted">launch claims still pay ${esc(eShort(d.wallet))} (you pay the gas); ADAM claims need ${esc(eShort(d.wallet))} itself</span>`);
}
async function ernConnect(){
  const s=$("#ernProv");if(s)ERN.prov=ERN.provs[+s.value].provider;const p=ernProvider();
  try{const a=await p.request({method:"eth_requestAccounts"});ERN.acct=a&&a[0]||null;
    if(p.on&&!p._ernHooked){p._ernHooked=true;p.on("accountsChanged",a=>{ERN.acct=a&&a[0]||null;ernWallet()})}
    ernWallet()}catch(e){ernSay(e.message||String(e),"err")}
}
function ernSay(html,cls){const m=$("#ernMsg");m.innerHTML=html;m.className="msg "+(cls||"")}
async function ernChain(p,tx){
  const cur=String(await p.request({method:"eth_chainId"})).toLowerCase();if(cur===tx.chainHex)return;
  try{await p.request({method:"wallet_switchEthereumChain",params:[{chainId:tx.chainHex}]})}
  catch(e){const code=e.code??(e.data&&e.data.originalError&&e.data.originalError.code);if(code===4902&&tx.addChain)await p.request({method:"wallet_addEthereumChain",params:[tx.addChain]});else throw e}
}
async function ernWait(p,hash){for(let i=0;i<180;i++){await new Promise(r=>setTimeout(r,4000));const rc=await p.request({method:"eth_getTransactionReceipt",params:[hash]}).catch(()=>null);if(rc)return rc}return null}
// fetch the transaction from the server, switch chain, send, wait for the receipt
async function ernSend(params,label){
  const p=ernProvider();if(!p||!ERN.acct)throw new Error("connect a wallet first");
  ernSay(`${esc(label)}: preparing and simulating…`);
  const r=await fetch("/api/earnings/tx?"+new URLSearchParams(params));const tx=await r.json();if(!r.ok||tx.error)throw new Error(tx.error||r.statusText);
  if(tx.mustSendFrom&&ERN.acct.toLowerCase()!==tx.mustSendFrom)throw new Error(`switch the wallet to ${eShort(tx.mustSendFrom)}: only the NFTs' owner can claim`);
  await ernChain(p,tx);
  const drop=(tx.dropped||[]).length?` (${tx.dropped.length} left out: they would revert)`:"";
  ernSay(`${esc(label)}: ${tx.count} claim${tx.count===1?"":"s"}${drop} — confirm in your wallet…`);
  const q={from:ERN.acct,to:tx.to,data:tx.data,value:"0x0"};if(tx.gas)q.gas=tx.gas;
  const hash=await p.request({method:"eth_sendTransaction",params:[q]});
  const scan=((ERN.d.chains||{})[tx.chainId]||{}).scan,link=scan?`<a href="${safeUrl(scan+"/tx/"+hash)}" target="_blank" rel="noopener">${esc(eShort(hash))} ↗</a>`:esc(eShort(hash));
  ernSay(`${esc(label)}: sent ${link} — waiting for the block…`);
  const rc=await ernWait(p,hash);
  if(!rc)throw new Error(`no receipt after 12 min for ${hash}: check it on the explorer`);
  if(rc.status!=="0x1")throw new Error(`transaction ${eShort(hash)} reverted`);
  return {tx,link};
}
async function ernRun(jobs){
  if(ERN.busy)return;ERN.busy=true;const done=[];
  try{for(const [params,label] of jobs){const r=await ernSend(params,label);done.push(`${esc(label)} ${r.link}`)}
    ernSay(`claimed: ${done.join(" · ")}`,"ok")}
  catch(e){ernSay((done.length?`claimed: ${done.join(" · ")} — then `:"")+esc(e.message||String(e)),"err")}
  finally{ERN.busy=false;ERN.sel=null;await ernLoad(true)}
}
// ---- 02 launch rewards
(()=>{const sh=$("#ernShow");if(!sh)return;sh.onclick=e=>{const b=e.target.closest("[data-s]");if(!b)return;ERN.show=b.dataset.s;[...sh.children].forEach(x=>x.classList.toggle("on",x===b));ernLaunches()};
  $("#ernClaim").onclick=()=>{if(!ERN.d)return;const by={};ERN.d.items.filter(x=>ERN.sel.has(x.launchId)).forEach(x=>(by[x.chain]=by[x.chain]||[]).push(x.launchId));
    const jobs=Object.keys(by).sort().map(c=>[{kind:"launch",chain:c,ids:by[c].join(",")},`${ERN.d.chains[c].name} rewards`]);
    if(!jobs.length)return ernSay("select at least one claimable reward","err");ernRun(jobs)}})();
const ST_TAG={claimable:'<span class="tag ok">claimable</span>',claimed:'<span class="tag">claimed</span>',opens:"",waiting:'<span class="tag lamp">waiting</span>',loading:'<span class="tag lamp">loading</span>',unknown:'<span class="tag alarm">unknown</span>'};
function ernLaunches(){
  const d=ERN.d,el=$("#ernLaunches");if(!d||!el)return;
  const rows=d.items.filter(x=>ERN.show==="all"||(ERN.show==="claimed"?x.status==="claimed":x.status!=="claimed")).slice()
    .sort((a,b)=>(a.status==="claimable"?0:1)-(b.status==="claimable"?0:1)||(b.valueUsd||0)-(a.valueUsd||0)||(b.launchNumber||0)-(a.launchNumber||0));
  $("#ernLInfo").textContent=`${d.items.length} on real chains · ${d.items.filter(x=>x.status==="claimable").length} claimable · ${d.items.filter(x=>x.status==="claimed").length} claimed`;
  const T=Object.entries(d.testnet||{});$("#ernTestnet").textContent=T.length?`not listed: ${T.map(([k,n])=>`${n} launches on ${k}`).join(", ")} (test tokens, no value)`:"";
  el.innerHTML=`<tr><th></th><th>launch</th><th>token</th><th>chain</th><th class="num">amount</th><th class="num">price</th><th class="num">value</th><th class="num">held</th><th>status</th><th></th></tr>`+
    (rows.length?rows.map(x=>{const can=x.status==="claimable",on=ERN.sel.has(x.launchId);
      const st=x.status==="opens"?`<span class="tag lamp">opens in ${eIn(x.opensAt)}</span>`:(ST_TAG[x.status]||esc(x.status));
      const price=x.drained?'<span class="tag alarm" title="the pool sits at its lowest price: nothing to sell into">drained</span>':x.priceUsd!=null?`<span title="${esc(ePx(x.price))} ${esc(x.quote||"")}">${eUsd(x.priceUsd)==="<$0.01"?"$"+ePx(x.priceUsd):eUsd(x.priceUsd)}</span>`:'<span class="z">–</span>';
      return `<tr class="${x.drained||x.status==="claimed"&&ERN.show!=="claimed"?"dim":""}"><td class="ck">${can?`<input type="checkbox" data-l="${esc(x.launchId)}"${on?" checked":""}>`:""}</td>`+
        `<td><a href="${safeUrl(x.explorerUrl)}" target="_blank" rel="noopener">#${esc(x.launchNumber)}</a></td>`+
        `<td>${x.tokenUrl?`<a href="${safeUrl(x.tokenUrl)}" target="_blank" rel="noopener"><b>${esc(x.token.symbol||"?")}</b></a>`:`<b>${esc(x.token.symbol||"?")}</b>`} <span class="muted">${esc((x.token.name||"").slice(0,28))}</span></td>`+
        `<td>${esc(x.chainName)}</td><td class="num">${fmt(x.amount)}</td><td class="num">${price}</td>`+
        `<td class="num">${x.drained?'<span class="z">$0</span>':eUsd(x.valueUsd)}</td><td class="num">${x.held?fmt(x.held):'<span class="z">0</span>'}</td>`+
        `<td title="${esc(x.why||"")}">${st}</td><td>${x.repoUrl?`<a href="${safeUrl(x.repoUrl)}" target="_blank" rel="noopener" class="muted">source ↗</a>`:""}</td></tr>`}).join("")
      :`<tr><td colspan="10" class="empty"><div class="muted">${ERN.show==="claimed"?"nothing claimed yet":"nothing left to claim"}</div></td></tr>`);
  el.querySelectorAll("input[data-l]").forEach(c=>c.onchange=()=>{c.checked?ERN.sel.add(c.dataset.l):ERN.sel.delete(c.dataset.l);ernSelInfo()});
  ernSelInfo();
}
function ernSelInfo(){
  const d=ERN.d,pick=d.items.filter(x=>ERN.sel.has(x.launchId)),chains=[...new Set(pick.map(x=>x.chain))];
  const gas=chains.reduce((s,c)=>{const g=(d.gas||{})[d.chains[c].name]||{};return s+(g.batchedUsd||0)*pick.filter(x=>x.chain===c).length},0);
  $("#ernSelInfo").textContent=pick.length?`${pick.length} selected · ≈ ${eUsd(pick.reduce((s,x)=>s+(x.valueUsd||0),0))} · gas ≈ ${eUsd(gas)} · ${chains.length} transaction${chains.length===1?"":"s"} (${chains.map(c=>d.chains[c].name).join(" + ")})`:"nothing selected";
  $("#ernClaim").disabled=!pick.length||ERN.busy;
}
// ---- 03 ADAM
function ernAdam(){
  const el=$("#ernAdam"),A=ERN.d.adam;if(!el)return;
  if(!A){el.innerHTML='<span class="muted">not readable right now</span>';$("#ernAInfo").textContent="";return}
  const ddl=new Date(A.deadline*1000).toISOString().slice(0,16).replace("T"," ");
  $("#ernAInfo").textContent=A.open?`day ${A.tranches} of 10 · deadline ${ddl} UTC`:"closed";
  const by=[0,1].map(c=>A.nfts.filter(n=>n.collection===c&&n.eligible));
  el.innerHTML=`<div class="paper tscroll"><table><tr><th>nft</th><th class="num">share</th><th class="num">claimed</th><th class="num">unlocked now</th></tr>`+
    (A.nfts.length?A.nfts.map(n=>`<tr><td>${esc(n.name)} #${n.id}${n.eligible?"":' <span class="tag">minted after the snapshot</span>'}</td><td class="num">${fmt(n.share)}</td><td class="num">${fmt(n.claimed)}</td><td class="num">${n.claimable?`<b>${fmt(n.claimable)}</b>`:'<span class="z">0</span>'}</td></tr>`).join("")
      :'<tr><td colspan="4" class="muted">no identity.md or Swarm Pepe in this wallet</td></tr>')+`</table></div>`+
    `<div class="hint" style="margin-top:8px">${A.open?(A.nextUnlock?`next 10 % unlocks in ${eIn(A.nextUnlock)} (${hm(A.nextUnlock)} UTC)`:"everything is unlocked")+` · claim by ${ddl} UTC or it is burned`:"the claim window is closed"} · ADAM ${A.priceUsd!=null?"$"+ePx(A.priceUsd):"?"} · gas ≈ ${eUsd(A.gasUsd)} per claim · ${fmt(A.balance)} ADAM in the wallet</div>`+
    `<div class="ernbtns">`+by.map((ns,c)=>{const ids=ns.filter(n=>n.claimable>0).map(n=>n.id),amt=ns.reduce((s,n)=>s+n.claimable,0),name=c?"Swarm Pepe":"identity.md";
      return ids.length?`<button class="primary" data-ac="${c}" data-ids="${ids.join(",")}">claim ${fmt(amt)} (${name})</button><button data-ac="${c}" data-ids="${ids.join(",")}" data-stake="1">claim &amp; stake</button>`:""}).join("")+
    (A.claimable?"":`<span class="muted">nothing unlocked right now</span>`)+`</div>`;
  el.querySelectorAll("button[data-ac]").forEach(b=>b.onclick=()=>ernRun([[{kind:"adam",collection:b.dataset.ac,ids:b.dataset.ids,stake:b.dataset.stake||"0"},`ADAM ${b.dataset.ac==="1"?"Swarm Pepe":"identity.md"}${b.dataset.stake?" (staked)":""}`]]));
}
// ---- 04 payouts
function ernPayouts(){
  const el=$("#ernPay"),R=ERN.d.payouts||[],P=ERN.d.prices||{};if(!el)return;
  $("#ernPInfo").textContent=R.length?`${R.length} since ${String(R[R.length-1].at).slice(0,10)}`:"";
  el.innerHTML=R.length?`<div class="paper tscroll" style="max-height:40vh"><table><tr><th>when (utc)</th><th class="num">IMD</th><th class="num">today</th><th></th></tr>`+
    R.map(r=>`<tr><td>${esc(String(r.at).slice(0,16).replace("T"," "))}</td><td class="num">${r.amount.toFixed(4)}</td><td class="num">${eUsd(P.imdUsd!=null?r.amount*P.imdUsd:null)}</td><td><a href="${safeUrl("https://etherscan.io/tx/"+r.tx)}" target="_blank" rel="noopener" class="muted">tx ↗</a></td></tr>`).join("")+"</table></div>"
    :'<span class="muted">no payout received yet</span>';
}
if(!document.querySelector('section[data-tab="earnings"]').hidden)ernLoad(false);  // opened straight on #/earnings
