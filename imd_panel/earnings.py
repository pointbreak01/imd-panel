"""Earnings: what the seat's wallet earned on chain, what is still to claim, and what it is worth.

Three sources, all public:
- launch rewards: every launch on a real chain hands part of its token to the seats (api.imd.fun
  /wallets/:a/earnings). Each launch has a MerkleDistributor; the leaf and its proof come from
  /launches/:id?claims=1. claim(round, account, amount, proof) pays `account` whoever sends it, so any number of
  claims fit in one Multicall3 transaction.
- IMD payouts: the founder pays seats in IMD from the LP fees through Disperse. Nothing to claim; listed as history.
- ADAM airdrop: NFTClaim gives every identity.md and Swarm Pepe a share that unlocks 10 % a day until a deadline,
  then burns what is left. Only the NFT's owner can claim it.

Prices are spot prices read from each token's Uniswap v4 pool (PoolManager.extsload), quoted in ETH or IMD; ETH/USD
comes from Chainlink. The panel holds no key: it builds the calldata and the browser's wallet signs it.
"""
import json, os, threading, time, urllib.parse, urllib.request

from . import collect
from .paths import state

# ---------------------------------------------------------------- keccak-256 (the stdlib's sha3_256 is the NIST padding, not Ethereum's)
_RC = [0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000, 0x000000000000808B, 0x0000000080000001,
       0x8000000080008081, 0x8000000000008009, 0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
       0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003, 0x8000000000008002, 0x8000000000000080,
       0x000000000000800A, 0x800000008000000A, 0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008]
_ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]]
_M64 = (1 << 64) - 1


def _rol(x, n):
    return ((x << n) | (x >> (64 - n))) & _M64 if n else x


def _f(A):
    for rc in _RC:
        C = [A[x][0] ^ A[x][1] ^ A[x][2] ^ A[x][3] ^ A[x][4] for x in range(5)]
        D = [C[(x - 1) % 5] ^ _rol(C[(x + 1) % 5], 1) for x in range(5)]
        A = [[A[x][y] ^ D[x] for y in range(5)] for x in range(5)]
        B = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                B[y][(2 * x + 3 * y) % 5] = _rol(A[x][y], _ROT[x][y])
        A = [[B[x][y] ^ ((~B[(x + 1) % 5][y]) & B[(x + 2) % 5][y]) for y in range(5)] for x in range(5)]
        A[0][0] ^= rc
    return A


def keccak256(data):
    rate = 136
    b = bytearray(data) + b"\x01"
    b += b"\x00" * ((-len(b)) % rate)
    b[-1] |= 0x80
    A = [[0] * 5 for _ in range(5)]
    for i in range(0, len(b), rate):
        for j in range(rate // 8):
            A[j % 5][j // 5] ^= int.from_bytes(b[i + 8 * j:i + 8 * j + 8], "little")
        A = _f(A)
    return b"".join(A[j % 5][j // 5].to_bytes(8, "little") for j in range(4))


def sel(sig):
    return keccak256(sig.encode())[:4].hex()


# ---------------------------------------------------------------- chains, contracts, selectors
CHAINS = {
    1: {"name": "mainnet", "hex": "0x1", "scan": "https://etherscan.io", "rpc": ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"],
        "imd": "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7"},
    4663: {"name": "robinhood", "hex": "0x1237", "scan": "https://robinhoodchain.blockscout.com", "rpc": ["https://rpc.mainnet.chain.robinhood.com"],
           "imd": "0x5f7bb59365ce557c26dbcaa4ee9d39a4b95b7127",
           "add": {"chainId": "0x1237", "chainName": "Robinhood Chain", "nativeCurrency": {"name": "Ether", "symbol": "ETH", "decimals": 18},
                   "rpcUrls": ["https://rpc.mainnet.chain.robinhood.com"], "blockExplorerUrls": ["https://robinhoodchain.blockscout.com"]}},
}
ETH = "0x0000000000000000000000000000000000000000"
MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11"           # same address on both chains
MAINNET_PM = "0x000000000004444c5dc75cb358380d2e3de08a90"           # Uniswap v4 PoolManager
IMD_POOL = "0xb07d640fd9e2eb9dc81b953c8e4fd006bdfeaf276010fb5418eb763ca15abfb3"   # ETH/IMD, hookless, the deepest
ADAM_POOL = "0x3bae96a49d241bb4035056e713afdaba06294b72e8124ad7bdc693b16f7d35dc"  # ETH/ADAM
CHAINLINK_ETH_USD = "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419"
DISPERSE = "0xd15fe25ed0dba12fe05e7029c88b10c25e8880e3"
NFT_CLAIM = "0xb8a3376f2b6a95418074ac5669a2a5a6f028bd4c"
BLOCKSCOUT = "https://eth.blockscout.com/api/v2"
POOLS_SLOT = 6  # StateLibrary.POOLS_SLOT: pools[id] lives at keccak(id . 6); its first word packs sqrtPriceX96 in the low 160 bits

S = {k: sel(v) for k, v in {
    "claim": "claim(uint256,address,uint256,bytes32[])", "claimed": "claimed(uint256,address)", "roundCount": "roundCount()",
    "roundOf": "roundOf(uint256)", "balanceOf": "balanceOf(address)", "extsload": "extsload(bytes32)", "aggregate3": "aggregate3((address,bool,bytes)[])",
    "latestRoundData": "latestRoundData()", "nftClaim": "claim(uint8,uint256[])", "nftClaimAndStake": "claimAndStake(uint8,uint256[])",
    "nftClaimable": "claimable(uint8,uint256)", "nftClaimed": "claimed(uint8,uint256)", "nftShare": "share(uint8,uint256)",
    "launch": "launch()", "deadline": "deadline()", "adam": "adam()", "imdNFT": "imdNFT()", "swarmPepe": "swarmPepe()"}.items()}
INIT_TOPIC = "0x" + keccak256(b"Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)").hex()

# gas of one claim: ~111k sent directly, ~100k inside a batch plus the batch's own overhead (measured on mainnet)
GAS_DIRECT, GAS_BATCHED, GAS_BATCH_BASE, GAS_NFT_CLAIM = 112_000, 100_000, 35_000, 140_000
STATIC_FILE = state("earnings-launches.json")
STATIC_BUDGET = 4   # new launch records fetched per refresh: api.imd.fun answers "busy" / 503 when hammered
DRAINED = 1e-20     # a pool pushed to its lowest tick holds none of the quote currency: the token cannot be sold
TTL = 180


# ---------------------------------------------------------------- ABI encoding
def w(n):
    return "%064x" % n


def wa(a):
    return a.lower().replace("0x", "").rjust(64, "0")


def enc_claim(rnd, account, amount, proof):
    return "0x" + S["claim"] + w(rnd) + wa(account) + w(int(amount)) + w(128) + w(len(proof)) + "".join(p[2:].rjust(64, "0") for p in proof)


def enc_aggregate3(calls):
    """aggregate3(Call3[]) with Call3 = (address target, bool allowFailure, bytes callData)."""
    heads, tails, off = [], [], 32 * len(calls)
    for target, allow, data in calls:
        b = bytes.fromhex(data[2:])
        t = wa(target) + w(1 if allow else 0) + w(96) + w(len(b)) + b.hex() + "00" * ((-len(b)) % 32)
        heads.append(w(off)); tails.append(t); off += len(t) // 2
    return "0x" + S["aggregate3"] + w(32) + w(len(calls)) + "".join(heads) + "".join(tails)


def enc_nft_claim(col, ids, stake):
    return "0x" + S["nftClaimAndStake" if stake else "nftClaim"] + w(col) + w(64) + w(len(ids)) + "".join(w(int(i)) for i in ids)


def words(hexdata):
    h = (hexdata or "0x")[2:]
    return [int(h[i:i + 64], 16) for i in range(0, len(h) - 63, 64)]


# ---------------------------------------------------------------- JSON-RPC
def rpc_urls(chain):
    own = (collect.PANEL.get("rpcUrls") or {}).get(str(chain))
    return ([own] if own else []) + CHAINS[chain]["rpc"]


def rpc_batch(chain, calls, timeout=25):
    """[(method, params)] -> [{"result": …} or {"error": …}] in order, 40 per HTTP request; the next URL when one fails."""
    out = []
    for i in range(0, len(calls), 40):
        part = calls[i:i + 40]
        body = json.dumps([{"jsonrpc": "2.0", "id": j, "method": m, "params": p} for j, (m, p) in enumerate(part)]).encode()
        err = None
        for url in rpc_urls(chain):
            try:
                req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json", "User-Agent": "imd-panel/1 (+localhost)"})
                t0 = time.time()
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    raw = r.read()
                collect._count(url, t0, len(raw) + len(body), len(raw) + len(body))  # shows in Settings → api traffic
                res = json.loads(raw)
                if not isinstance(res, list):
                    raise RuntimeError(str((res or {}).get("error") or res)[:120])
                by = {x.get("id"): x for x in res}
                out += [by.get(j) or {"error": {"message": "no answer"}} for j in range(len(part))]
                break
            except Exception as e:
                err = e
        else:
            raise RuntimeError("%s rpc: %s" % (CHAINS[chain]["name"], str(err)[:120]))
    return out


def call(to, data, frm=None):
    tx = {"to": to, "data": data}
    if frm:
        tx["from"] = frm
    return ("eth_call", [tx, "latest"])


def res_words(r):
    return words(r.get("result")) if r and "result" in r else None


def pool_slot(pool_id):
    return "0x" + keccak256(bytes.fromhex(pool_id[2:]) + POOLS_SLOT.to_bytes(32, "big")).hex()


def price_in_quote(slot0, token_is_c0, token_dec=18, quote_dec=18):
    """Human price of the token in its pool's other currency, from the pool's packed slot0 word."""
    sq = slot0 & ((1 << 160) - 1)
    if not sq:
        return None
    p = (sq / 2 ** 96) ** 2  # raw currency1 per raw currency0
    if not token_is_c0:
        p = 1 / p
    return p * 10 ** (token_dec - quote_dec)


# ---------------------------------------------------------------- per-launch static record (frozen once the reward tree is), kept on disk
_lock = threading.Lock()
_cache = {"ts": 0, "data": None}
_slow = {}


def static_load():
    try:
        with open(STATIC_FILE) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def static_save(st):
    tmp = STATIC_FILE + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(st, fh)
    os.replace(tmp, STATIC_FILE)


def launch_static(lid, wallet, chain):
    """Leaf, proof, distributor round and pool of one launch. final=False: retry later (parked, no tree yet)."""
    d = collect.api_json(f"/launches/{lid}?claims=1", timeout=40)
    if d.get("error"):
        raise RuntimeError(str(d.get("detail") or d["error"])[:120])
    arts = {a.get("role"): a for a in d.get("artifacts") or []}
    dist = (arts.get("distributor") or {}).get("address"); tok = arts.get("token") or {}
    tree = d.get("claims") or {}
    leaf = next((l for l in tree.get("leaves") or [] if (l.get("wallet") or "").lower() == wallet.lower()), None)
    out = {"chain": chain, "distributor": dist, "root": tree.get("root") or d.get("merkleRoot"), "repoUrl": d.get("sourceRepoUrl"),
           "tokenTx": tok.get("txHash"), "status": d.get("status"), "fetchedAt": time.time(), "final": False}
    if not (dist and leaf and out["root"] and tok.get("txHash")):
        out["why"] = "no distributor yet" if not dist else "not in the reward tree" if not leaf else "no deployment record"
        return out
    out.update(amount=str(leaf.get("amount")), proof=leaf.get("proof") or [])
    n = res_words(rpc_batch(chain, [call(dist, "0x" + S["roundCount"])])[0])
    n = n[0] if n else 0
    rounds = rpc_batch(chain, [call(dist, "0x" + S["roundOf"] + w(i)) for i in range(n)]) if n else []
    root = int(out["root"], 16)
    out["round"] = next((i for i, r in enumerate(rounds) if (res_words(r) or [None])[0] == root), None)
    if out["round"] is None:
        out["why"] = "round not opened on chain yet"
        return out
    rc = rpc_batch(chain, [("eth_getTransactionReceipt", [tok["txHash"]])])[0].get("result") or {}
    init = next((l for l in rc.get("logs") or [] if (l.get("topics") or [""])[0] == INIT_TOPIC), None)
    if init:
        out["pool"] = {"id": init["topics"][1], "manager": init["address"].lower(), "c0": "0x" + init["topics"][2][-40:], "c1": "0x" + init["topics"][3][-40:]}
    out["final"] = True
    return out


# ---------------------------------------------------------------- slow sources: earnings list, payouts, NFTs held
def memo(name, ttl, fn, force=False):
    hit = _slow.get(name)
    if hit and not force and time.time() - hit[0] < ttl:
        return hit[1]
    try:
        v = fn()
    except Exception as e:
        if hit:
            return dict(hit[1], error=str(e)[:160]) if isinstance(hit[1], dict) else hit[1]
        raise
    _slow[name] = (time.time(), v)
    return v


def blockscout(path):
    return json.loads(collect.http_get(BLOCKSCOUT + path, timeout=25))


def payouts_fetch(wallet, imd, pages=5):
    """IMD that reached the wallet through Disperse: the founder's per-seat payouts."""
    rows, q = [], {"type": "ERC-20", "filter": "to", "token": imd}
    for _ in range(pages):
        d = blockscout(f"/addresses/{wallet}/token-transfers?" + urllib.parse.urlencode(q))
        for t in d.get("items") or []:
            if ((t.get("from") or {}).get("hash") or "").lower() != DISPERSE:
                continue
            tot = t.get("total") or {}
            rows.append({"at": t.get("timestamp"), "amount": int(tot.get("value") or 0) / 10 ** int(tot.get("decimals") or 18), "tx": t.get("transaction_hash")})
        nxt = d.get("next_page_params")
        if not nxt:
            break
        q = dict(q, **{k: v for k, v in nxt.items() if v is not None})
    return rows


def nfts_held(wallet, contract):
    d = blockscout(f"/tokens/{contract}/instances?holder_address_hash={wallet}")
    return sorted(int(i.get("id")) for i in d.get("items") or [] if str(i.get("id") or "").isdigit())


# ---------------------------------------------------------------- the whole tab
def build(force=False):
    cfg = collect.read_config(); wallet = (cfg.get("wallet") or "").lower(); seat = cfg.get("tokenId")
    if not wallet:
        return {"wallet": None, "error": "no wallet in ~/.identitymd/config.json"}
    now = time.time(); errors = []
    E = memo("earnings", 300, lambda: collect.api_json(f"/wallets/{wallet}/earnings?limit=200", timeout=30), force)
    earned = E.get("earnings") or []
    if E.get("error"):
        errors.append("earnings: " + E["error"])
    real = [e for e in earned if int(e.get("chainId") or 0) in CHAINS]
    testnet = {}
    for e in earned:
        if int(e.get("chainId") or 0) not in CHAINS:
            name = collect.chain_of(e.get("chainId"))["name"]; testnet[name] = testnet.get(name, 0) + 1

    st = static_load(); budget = STATIC_BUDGET; changed = False
    for e in sorted(real, key=lambda e: -(e.get("launchNumber") or 0)):
        lid = e.get("launchId"); s = st.get(lid)
        if s and (s.get("final") or now - s.get("fetchedAt", 0) < 3600):
            continue
        if budget <= 0:
            break
        budget -= 1
        try:
            st[lid] = launch_static(lid, wallet, int(e["chainId"])); changed = True
        except Exception as ex:
            # stop at the first refusal: the circuit breaker in collect.http_get is shared with the rest of the panel
            errors.append(f"launch #{e.get('launchNumber')}: {str(ex)[:100]}"); break
        time.sleep(0.5)
    if changed:
        static_save(st)

    # live reads, one batch per chain: claimed?, round opening, pool price, what the wallet holds
    items = []
    for e in real:
        tok = e.get("token") or {}; dec = int(tok.get("decimals") or 18); chain = int(e["chainId"]); s = st.get(e.get("launchId")) or {}
        items.append({"launchId": e.get("launchId"), "launchNumber": e.get("launchNumber"), "kind": e.get("kind"), "launchStatus": e.get("status"), "at": e.get("at"),
                      "chain": chain, "chainName": CHAINS[chain]["name"], "token": {"address": (tok.get("address") or "").lower(), "symbol": tok.get("symbol"), "name": tok.get("name"), "decimals": dec},
                      "amount": int(e.get("amount") or 0) / 10 ** dec, "s": s, "repoUrl": s.get("repoUrl"),
                      "tokenUrl": f"{CHAINS[chain]['scan']}/token/{tok.get('address')}?a={wallet}" if tok.get("address") else None,
                      "explorerUrl": f"https://explorer.imd.fun/launches/{e.get('launchId')}"})
    plan = {c: [] for c in CHAINS}  # chain -> [(item, field, request)]
    for it in items:
        s = it["s"]; c = it["chain"]
        if s.get("final"):
            plan[c].append((it, "claimed", call(s["distributor"], "0x" + S["claimed"] + w(s["round"]) + wa(wallet))))
            plan[c].append((it, "roundOf", call(s["distributor"], "0x" + S["roundOf"] + w(s["round"]))))
            if s.get("pool"):
                plan[c].append((it, "slot0", call(s["pool"]["manager"], "0x" + S["extsload"] + pool_slot(s["pool"]["id"])[2:])))
        if it["token"]["address"]:
            plan[c].append((it, "balance", call(it["token"]["address"], "0x" + S["balanceOf"] + wa(wallet))))
    extra = {1: [("ethUsd", call(CHAINLINK_ETH_USD, "0x" + S["latestRoundData"])), ("imdSlot", call(MAINNET_PM, "0x" + S["extsload"] + pool_slot(IMD_POOL)[2:])),
                 ("adamSlot", call(MAINNET_PM, "0x" + S["extsload"] + pool_slot(ADAM_POOL)[2:])), ("gas", ("eth_gasPrice", []))],
             4663: [("gas", ("eth_gasPrice", []))]}
    live = {c: {} for c in CHAINS}; gas = {}
    for c in CHAINS:
        reqs = [r for _, _, r in plan[c]] + [r for _, r in extra[c]]
        try:
            res = rpc_batch(c, reqs)
        except Exception as ex:
            errors.append(str(ex)); continue
        for (it, field, _), r in zip(plan[c], res):
            it[field] = r
        for (k, _), r in zip(extra[c], res[len(plan[c]):]):
            live[c][k] = r
        g = live[c].get("gas") or {}
        gas[c] = int(g["result"], 16) if g.get("result") else None

    eth_usd = (res_words(live[1].get("ethUsd")) or [0, 0])[1] / 1e8 or None
    imd_eth = price_in_quote((res_words(live[1].get("imdSlot")) or [0])[0], token_is_c0=False)  # ETH sorts first: IMD is currency1
    imd_usd = imd_eth * eth_usd if imd_eth and eth_usd else None
    adam_eth = price_in_quote((res_words(live[1].get("adamSlot")) or [0])[0], token_is_c0=False)
    quote_usd = lambda c, q: eth_usd if q == ETH else imd_usd if q == CHAINS[c]["imd"] else None
    gas_usd = lambda c, units: gas[c] * units / 1e18 * eth_usd if gas.get(c) and eth_usd else None

    out_items = []
    for it in items:
        s = it.pop("s"); c = it["chain"]; tok = it["token"]["address"]
        bal = res_words(it.pop("balance", None)); it["held"] = bal[0] / 10 ** it["token"]["decimals"] if bal else None
        cl = res_words(it.pop("claimed", None)); ro = res_words(it.pop("roundOf", None)); sl = res_words(it.pop("slot0", None))
        it["price"] = it["priceUsd"] = it["quote"] = None
        if s.get("pool") and sl:
            p = s["pool"]; is_c0 = p["c0"] == tok; q = p["c1"] if is_c0 else p["c0"]
            it["quote"] = "ETH" if q == ETH else "IMD" if q == CHAINS[c]["imd"] else q
            it["price"] = price_in_quote(sl[0], is_c0, it["token"]["decimals"])
            it["drained"] = it["price"] is not None and it["price"] < DRAINED
            qu = quote_usd(c, q)
            it["priceUsd"] = it["price"] * qu if it["price"] is not None and qu else None
        it["valueUsd"] = it["amount"] * it["priceUsd"] if it["priceUsd"] is not None else None
        it["heldUsd"] = it["held"] * it["priceUsd"] if it["priceUsd"] is not None and it["held"] is not None else None
        it["gasUsd"] = gas_usd(c, GAS_DIRECT)
        if not s:
            it["status"], it["why"] = "loading", "reward record not read yet"
        elif not s.get("final"):
            it["status"], it["why"] = "waiting", s.get("why")
        elif cl is None or ro is None:
            it["status"], it["why"] = "unknown", "rpc did not answer"
        elif cl[0]:
            it["status"] = "claimed"
        elif len(ro) > 3 and ro[3] > now:
            it["status"], it["opensAt"] = "opens", ro[3]
        else:
            it["status"] = "claimable"
        it["distributor"] = s.get("distributor")
        out_items.append(it)
    out_items.sort(key=lambda x: (-(x["launchNumber"] or 0)))

    # ADAM airdrop: every identity.md and Swarm Pepe the wallet holds
    adam = None
    try:
        adam = adam_state(wallet, seat, force)
        if adam_eth and eth_usd:
            adam["priceUsd"] = adam_eth * eth_usd
        adam["gasUsd"] = gas_usd(1, GAS_NFT_CLAIM)
    except Exception as ex:
        errors.append("ADAM: " + str(ex)[:120])
    try:
        pays = memo("payouts", 1800, lambda: {"rows": payouts_fetch(wallet, CHAINS[1]["imd"])}, force)
    except Exception as ex:
        pays = {"rows": [], "error": str(ex)[:120]}
    if pays.get("error"):
        errors.append("payouts: " + pays["error"])

    open_ = [x for x in out_items if x["status"] == "claimable"]
    return {"wallet": wallet, "seat": seat, "generatedAt": now, "items": out_items, "testnet": testnet,
            "prices": {"ethUsd": eth_usd, "imdUsd": imd_usd, "imdEth": imd_eth, "adamUsd": adam and adam.get("priceUsd")},
            "gas": {CHAINS[c]["name"]: {"gwei": gas[c] / 1e9 if gas.get(c) else None, "claimUsd": gas_usd(c, GAS_DIRECT), "batchedUsd": gas_usd(c, GAS_BATCHED)} for c in CHAINS},
            "chains": {str(c): {k: v for k, v in CHAINS[c].items() if k in ("name", "hex", "scan", "add")} for c in CHAINS},
            "pending": sum(1 for x in out_items if x["status"] == "loading"),
            "totals": {"claimableUsd": sum(x["valueUsd"] or 0 for x in open_), "claimable": len(open_),
                       "claimedUsd": sum(x["valueUsd"] or 0 for x in out_items if x["status"] == "claimed"),
                       "heldUsd": sum(x["heldUsd"] or 0 for x in out_items),
                       "payoutsImd": sum(r["amount"] for r in pays.get("rows") or [])},
            "adam": adam, "payouts": pays.get("rows") or [], "errors": errors}


def adam_state(wallet, seat, force=False):
    head = memo("adam-head", 86400, lambda: dict(zip(("launch", "deadline", "adam", "imdNFT", "swarmPepe"), [
        res_words(r)[0] for r in rpc_batch(1, [call(NFT_CLAIM, "0x" + S[k]) for k in ("launch", "deadline", "adam", "imdNFT", "swarmPepe")])])), force)
    nft = lambda k: "0x%040x" % head[k]
    held = memo("adam-nfts", 1800, lambda: {"0": nfts_held(wallet, nft("imdNFT")), "1": nfts_held(wallet, nft("swarmPepe"))}, force)
    if seat is not None and str(seat).isdigit() and int(seat) not in held["0"]:
        held = dict(held, **{"0": sorted(held["0"] + [int(seat)])})  # the seat is ours even if the indexer lags
    pairs = [(int(c), i) for c in ("0", "1") for i in held.get(c) or []]
    reqs = []
    for c, i in pairs:
        reqs += [call(NFT_CLAIM, "0x" + S["nftClaimable"] + w(c) + w(i)), call(NFT_CLAIM, "0x" + S["nftClaimed"] + w(c) + w(i)),
                 call(NFT_CLAIM, "0x" + S["nftShare"] + w(c) + w(i))]
    res = rpc_batch(1, reqs + [call(nft("adam"), "0x" + S["balanceOf"] + wa(wallet))]) if pairs else rpc_batch(1, [call(nft("adam"), "0x" + S["balanceOf"] + wa(wallet))])
    rows = []
    for k, (c, i) in enumerate(pairs):
        a, b, sh = (res_words(res[3 * k + j]) for j in range(3))
        rows.append({"collection": c, "name": "identity.md" if c == 0 else "Swarm Pepe", "id": i, "eligible": sh is not None,
                     "claimable": a[0] / 1e18 if a else 0, "claimed": b[0] / 1e18 if b else 0, "share": sh[0] / 1e18 if sh else 0})
    now = time.time(); start = head["launch"]; days = int((now - start) // 86400) + 1 if now >= start else 0
    return {"contract": NFT_CLAIM, "token": nft("adam"), "launch": start, "deadline": head["deadline"], "tranches": min(10, days),
            "nextUnlock": start + days * 86400 if days < 10 and now < head["deadline"] else None, "open": now < head["deadline"],
            "balance": (res_words(res[-1]) or [0])[0] / 1e18, "nfts": rows,
            "claimable": sum(r["claimable"] for r in rows), "claimed": sum(r["claimed"] for r in rows), "share": sum(r["share"] for r in rows)}


def data(force=False):
    with _lock:
        if force or not _cache["data"] or time.time() - _cache["ts"] > TTL or (_cache["data"] or {}).get("pending"):
            _cache["data"] = build(force); _cache["ts"] = time.time()
        return _cache["data"]


# ---------------------------------------------------------------- transactions for the browser wallet to sign
def claim_tx(q):
    """kind=launch&chain=1&ids=<launchId,…>  → one claim, or a Multicall3 batch of claims, each re-simulated first.
    kind=adam&collection=0&ids=42[&stake=1] → NFTClaim.claim / claimAndStake for NFTs the wallet owns."""
    d = data(); wallet = d.get("wallet")
    if not wallet:
        raise RuntimeError(d.get("error") or "no wallet")
    kind = q.get("kind")
    if kind == "adam":
        col = int(q.get("collection") or 0); ids = [int(x) for x in (q.get("ids") or "").split(",") if x.strip().isdigit()]
        rows = {(r["collection"], r["id"]): r for r in ((d.get("adam") or {}).get("nfts") or [])}
        ids = [i for i in ids if (rows.get((col, i)) or {}).get("claimable")]
        if not ids:
            raise RuntimeError("nothing unlocked on those NFTs right now")
        data_ = enc_nft_claim(col, ids, q.get("stake") == "1")
        sim = rpc_batch(1, [call(NFT_CLAIM, data_, wallet)])[0]
        if "error" in sim:
            raise RuntimeError("the claim would revert: " + str((sim["error"] or {}).get("message"))[:120])
        return {"chainId": 1, "chainHex": "0x1", "to": NFT_CLAIM, "data": data_, "value": "0x0", "from": wallet, "count": len(ids),
                "note": "only the NFTs' owner can send this", "mustSendFrom": wallet}
    if kind != "launch":
        raise RuntimeError("kind: launch or adam")
    chain = int(q.get("chain") or 1)
    if chain not in CHAINS:
        raise RuntimeError("unsupported chain")
    want = set((q.get("ids") or "").split(","))
    st = static_load()
    picks = [x for x in d["items"] if x["chain"] == chain and x["launchId"] in want and x["status"] == "claimable" and (st.get(x["launchId"]) or {}).get("final")]
    if not picks:
        raise RuntimeError("nothing claimable among those launches")
    calls = []
    for x in picks:
        s = st[x["launchId"]]
        calls.append((s["distributor"], True, enc_claim(s["round"], wallet, s["amount"], s["proof"])))
    sims = rpc_batch(chain, [call(t, dd) for t, _, dd in calls])  # claims pay `account` whoever sends them: any sender simulates
    ok = [(c, x) for c, x, r in zip(calls, picks, sims) if "error" not in r]
    dropped = [{"launchNumber": x["launchNumber"], "symbol": x["token"]["symbol"], "error": str((r.get("error") or {}).get("message"))[:80]}
               for c, x, r in zip(calls, picks, sims) if "error" in r]
    if not ok:
        raise RuntimeError("every claim would revert: " + "; ".join(f"#{z['launchNumber']} {z['error']}" for z in dropped)[:300])
    if len(ok) == 1:
        to, data_ = ok[0][0][0], ok[0][0][2]; gas = GAS_DIRECT
    else:
        to, data_ = MULTICALL3, enc_aggregate3([c for c, _ in ok]); gas = GAS_BATCH_BASE + GAS_BATCHED * len(ok)
    est = rpc_batch(chain, [("eth_estimateGas", [{"from": wallet, "to": to, "data": data_}])])[0]  # the whole transaction, as sent
    if "error" in est:
        raise RuntimeError("the transaction would revert: " + str((est["error"] or {}).get("message"))[:160])
    gas = int(est["result"], 16)
    return {"chainId": chain, "chainHex": CHAINS[chain]["hex"], "addChain": CHAINS[chain].get("add"), "to": to, "data": data_, "value": "0x0",
            "gas": hex(int(gas * 1.25)), "count": len(ok), "account": wallet, "dropped": dropped,
            "launches": [x["launchNumber"] for _, x in ok], "valueUsd": sum(x["valueUsd"] or 0 for _, x in ok)}
