#!/usr/bin/env python3
"""Collect IMD worker activity: journal events + Claude Code transcripts -> one JSON."""
import urllib.request
import datetime as _dt
import glob, json, os, re, subprocess, time
from collections import Counter, defaultdict
from datetime import datetime, timezone

from . import tiers
from .paths import HERE, STATE_DIR, state

HOME = os.path.expanduser("~")
PROJECTS = os.path.join(HOME, ".claude", "projects")
PANEL_DEFAULTS = {"workerUnit": "identitymd-worker.service", "cleanUnit": None, "proxyPorts": [], "pruneWorkDays": 3, "pruneTranscriptDays": 14, "identitymdHome": None}


def load_panel():
    """panel.json next to the code (optional): unit names, local proxy ports, prune ages. Missing keys keep the defaults."""
    cfg = dict(PANEL_DEFAULTS)
    try:
        with open(state("panel.json")) as fh:
            cfg.update({k: v for k, v in json.load(fh).items() if k in PANEL_DEFAULTS})
    except (OSError, ValueError):
        pass
    return cfg


PANEL = load_panel()
UNIT = PANEL["workerUnit"] if PANEL["workerUnit"].endswith(".service") else PANEL["workerUnit"] + ".service"
IDENTITYMD_HOME = PANEL["identitymdHome"] or os.environ.get("IDENTITYMD_HOME") or os.path.join(HOME, ".identitymd")
PROXY_PORTS = tuple(str(p) for p in PANEL["proxyPorts"] or [])
HOST = os.uname().nodename
TOKEN_KEYS = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")

_file_cache = {}  # path -> (mtime, size, parsed)


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_ts(s):
    return datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).timestamp()


# ---------------------------------------------------------------- journal
RE_ACCEPT = re.compile(r"^accepted (\S+) ([0-9a-f]{8}) — (.*?) \(max (\d+) turns\)")
RE_SUBMIT = re.compile(r"^submitted (\S+) for ([0-9a-f]{8})")
RE_STORED = re.compile(r"^submission stored \(([0-9a-f]+)\)")
RE_ALIVE = re.compile(r"^(alive|disconnected) (\S+) · (idle|(\d+) tasks? running) · (\d+) submitted(?: · fleet (\d+) online, (\d+) enrolled)?")
RE_CANCEL = re.compile(r"^cancelled ([0-9a-f]{8}): (.*)")
RE_UPDATED = re.compile(r"^updated (\S+) → (\S+)")
RE_UPDATE_FAILED = re.compile(r"^update failed: (.*)")
_journal_rows_cache = [None]


def read_journal():
    try:
        out = subprocess.run(
            ["journalctl", "--user", "-u", UNIT, "-o", "json", "--no-pager", "--output-fields=MESSAGE,__REALTIME_TIMESTAMP"],
            capture_output=True, text=True, timeout=60).stdout
    except Exception as e:  # journal unavailable
        return [], str(e)
    rows = []
    for line in out.splitlines():
        try:
            o = json.loads(line)
        except ValueError:
            continue
        msg = o.get("MESSAGE")
        if not isinstance(msg, str):
            continue
        ts = int(o.get("__REALTIME_TIMESTAMP", 0)) / 1e6
        m = re.match(r"^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+(.*)$", msg)
        if m:
            ts, msg = parse_ts(m.group(1)), m.group(2)
        rows.append((ts, msg))
    return rows, None


def journal_events(rows):
    tasks = {}          # short id -> task record
    events = []         # notable non-task events
    alive = []          # heartbeat series
    ratelimits = []
    last_submit = None
    for ts, msg in rows:
        m = RE_ACCEPT.match(msg)
        if m:
            kind, sid, outputs, max_turns = m.groups()
            tasks.setdefault(sid, {"id": sid, "kind": kind, "outputs": outputs, "maxTurns": int(max_turns),
                                   "acceptedAt": ts, "attempts": 0, "status": "accepted"})
            t = tasks[sid]; t["attempts"] += 1; t["acceptedAt"] = ts; t["status"] = "accepted"
            continue
        m = RE_SUBMIT.match(msg)
        if m:
            sid = m.group(2)
            t = tasks.setdefault(sid, {"id": sid, "kind": m.group(1), "outputs": "", "maxTurns": 0, "acceptedAt": ts, "attempts": 1})
            t["submittedAt"] = ts; t["status"] = "submitted"; last_submit = sid
            continue
        m = RE_STORED.match(msg)
        if m and last_submit:
            tasks[last_submit]["submissionId"] = m.group(1); last_submit = None
            continue
        m = RE_CANCEL.match(msg)
        if m:
            sid = m.group(1)
            if sid in tasks:
                tasks[sid]["status"] = "cancelled"; tasks[sid]["cancelReason"] = m.group(2); tasks[sid]["endedAt"] = ts
            events.append({"ts": ts, "type": "cancelled", "msg": msg})
            continue
        m = RE_ALIVE.match(msg)
        if m:
            running = 0 if m.group(3) == "idle" else int(m.group(4))
            alive.append({"ts": ts, "state": m.group(1), "running": running, "submitted": int(m.group(5)),
                          "fleetOnline": int(m.group(6)) if m.group(6) else None, "fleetEnrolled": int(m.group(7)) if m.group(7) else None})
            continue
        if "rate limited" in msg:
            ratelimits.append({"ts": ts, "msg": msg})
            # the most recently accepted, not yet submitted task was released
            open_tasks = [t for t in tasks.values() if t.get("status") == "accepted"]
            if open_tasks:
                t = max(open_tasks, key=lambda t: t["acceptedAt"])
                t["status"] = "rate-limited"; t["endedAt"] = ts
            events.append({"ts": ts, "type": "rate-limit", "msg": msg})
            continue
        low = msg.lower()
        typ = None
        if msg.startswith("connected to") or msg.startswith("admitted"):
            typ = "connect"
        elif msg.startswith("updated ") or msg.startswith("update ") or msg.startswith("an update "):
            typ = "update"
        elif msg.startswith("server closed") or msg.startswith("reconnecting") or "lease" in low or msg.startswith("server error"):
            typ = "server"
        elif msg.startswith("build mismatch"):
            typ = "mismatch"
        elif "systemd" in msg or msg.startswith("shutting down") or msg.startswith("runtimes:"):
            typ = "service"
        if typ:
            events.append({"ts": ts, "type": typ, "msg": msg[:200]})
    return tasks, events, alive, ratelimits


# ---------------------------------------------------------------- transcripts
def text_of(content):
    if isinstance(content, str):
        return content
    return " ".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")


def task_title(prompt):
    m = re.search(r"Task \((\w+)\):\s*(.+?)(?:\n\n|\Z)", prompt, re.S)
    if m:
        return m.group(2).strip().replace("\n", " ")[:400]
    return prompt.strip().replace("\n", " ")[:200]


def parse_session(path):
    st = os.stat(path)
    key = (st.st_mtime, st.st_size)
    cached = _file_cache.get(path)
    if cached and cached[0] == key:
        return cached[1]
    s = {"session": os.path.basename(path)[:-6], "model": None, "effort": None, "turns": 0, "toolCalls": Counter(),
         "usage": Counter(), "thinking": 0, "start": None, "end": None, "cost": None, "prompt": "", "errors": 0,
         "apiMs": 0, "toolMs": 0, "linesAdded": 0, "linesRemoved": 0, "version": None, "lastText": "", "limitHits": 0, "limitMsg": "", "limitAt": None}
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                o = json.loads(line)
            except ValueError:
                continue
            typ = o.get("type")
            ts = o.get("timestamp")
            if ts and typ in ("user", "assistant"):
                s["start"] = s["start"] or ts; s["end"] = ts
            if typ == "user" and not s["prompt"]:
                s["prompt"] = text_of((o.get("message") or {}).get("content", ""))
                s["version"] = o.get("version")
            elif typ == "assistant":
                m = o.get("message") or {}
                if m.get("model") == "<synthetic>" or o.get("isApiErrorMessage"):
                    s["limitHits"] += 1; s["limitMsg"] = text_of(m.get("content") or "")[:160]; s["limitAt"] = ts or s["limitAt"]
                    continue
                s["model"] = m.get("model") or s["model"]; s["effort"] = o.get("effort") or s["effort"]
                s["turns"] += 1
                for k in TOKEN_KEYS:
                    s["usage"][k] += (m.get("usage") or {}).get(k, 0) or 0
                for b in m.get("content") or []:
                    if isinstance(b, dict):
                        if b.get("type") == "tool_use":
                            s["toolCalls"][b.get("name", "?")] += 1
                        elif b.get("type") == "text" and b.get("text"):
                            s["lastText"] = b["text"][:300]
                if o.get("isApiErrorMessage") or (m.get("stop_reason") == "error"):
                    s["errors"] += 1
            elif typ == "cost-state":
                s["cost"] = o.get("totalCostUSD"); s["apiMs"] = o.get("totalAPIDuration", 0); s["toolMs"] = o.get("totalToolDuration", 0)
                s["linesAdded"] = o.get("totalLinesAdded", 0); s["linesRemoved"] = o.get("totalLinesRemoved", 0)
                for mu in (o.get("modelUsage") or {}).values():
                    s["thinking"] += mu.get("thinkingTokens", 0) or 0
    s["toolCalls"] = dict(s["toolCalls"]); s["usage"] = dict(s["usage"])
    s["title"] = task_title(s["prompt"]) if s["prompt"] else ""
    s["startTs"] = parse_ts(s["start"]) if s["start"] else st.st_mtime
    s["endTs"] = parse_ts(s["end"]) if s["end"] else st.st_mtime
    s["durationS"] = max(0, s["endTs"] - s["startTs"])
    del s["prompt"]
    _file_cache[path] = (key, s)
    return s


def transcripts():
    out = {}  # dir key -> {"group","task","sessions":[...]}
    for d in glob.glob(os.path.join(PROJECTS, "*identitymd-work*")):
        name = os.path.basename(d)
        rest = name.split("identitymd-work-", 1)[1]
        uuids = re.findall(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", rest)
        sessions = [parse_session(p) for p in glob.glob(os.path.join(d, "*.jsonl"))]
        sessions = [s for s in sessions if s["turns"] or s["start"] or s["limitHits"]]
        if not sessions:
            continue
        out[name] = {"group": uuids[0] if uuids else None, "task": uuids[1] if len(uuids) > 1 else None,
                     "special": None if uuids else rest, "sessions": sorted(sessions, key=lambda s: s["startTs"])}
    return out


# ---------------------------------------------------------------- assemble
PREMIUM_MODEL = tiers.PREMIUM_MODEL  # hard-wired in the worker (PREMIUM_MODELS); server-assigned tier


def tier_of(model, effort, ts=None):
    """Tier as of `ts` — the mapping moves with every inference switch, so a task
    is read against the config that was in force when it ran (see tiers.py)."""
    return tiers.tier_of(model, effort, ts)


def collect_base():
    t0 = time.time()
    rows, jerr = read_journal()
    _journal_rows_cache[0] = rows
    tasks, events, alive, ratelimits = journal_events(rows)
    trs = transcripts()
    _trs_cache["v"] = trs; _trs_cache["ts"] = time.time()
    by_short = {}
    for name, tr in trs.items():
        for u in (tr["group"], tr["task"]):
            if u:
                by_short.setdefault(u[:8], []).append(name)

    rows_out = []
    for sid, t in tasks.items():
        names = by_short.get(sid, [])
        sessions = [s for n in names for s in trs[n]["sessions"]]
        sessions.sort(key=lambda s: s["startTs"])
        usage = Counter(); thinking = 0; cost = 0.0; turns = 0; tools = Counter(); models = Counter(); dur = 0; effort = None; title = ""; last = ""
        limit_hits = 0; limit_msg = ""
        for s in sessions:
            limit_hits += s["limitHits"]; limit_msg = s["limitMsg"] or limit_msg
            usage.update(s["usage"]); thinking += s["thinking"]; cost += s["cost"] or 0; turns += s["turns"]
            tools.update(s["toolCalls"]); dur += s["durationS"]; effort = s["effort"] or effort; title = title or s["title"]; last = s["lastText"] or last
            if s["model"]:
                models[s["model"]] += s["turns"]
        model = models.most_common(1)[0][0] if models else None
        r = dict(t)
        r.update({"model": model, "effort": effort, "tier": tier_of(model, effort, t.get("acceptedAt")) if model else None, "turns": turns,
                  "sessions": len(sessions), "usage": dict(usage), "thinking": thinking, "costUSD": round(cost, 4),
                  "durationS": round(dur), "tools": dict(tools), "title": title, "lastText": last, "limitHits": limit_hits, "limitMsg": limit_msg,
                  "workDir": (trs[names[0]]["group"] + "/" + trs[names[0]]["task"]) if names and trs[names[0]]["task"] else None})
        if r["status"] == "accepted" and limit_hits and not r.get("submittedAt"):
            r["status"] = "rate-limited"
        elif r["status"] == "accepted" and sessions and time.time() - sessions[-1]["endTs"] > 3 * 3600:
            r["status"] = "unknown"  # accepted long ago, never submitted, no rate-limit line matched
        rows_out.append(r)
    # transcripts without a journal task (doctor runs, pre-journal history)
    seen = {n for names in by_short.values() for n in names if any(names and t["id"] in by_short for t in tasks.values())}
    matched = {n for sid in tasks for n in by_short.get(sid, [])}
    for name, tr in trs.items():
        if name in matched:
            continue
        for s in tr["sessions"]:
            rows_out.append({"id": (tr["task"] or tr["special"] or name)[:8], "kind": "doctor" if tr["special"] and "doctor" in tr["special"] else "untracked",
                             "acceptedAt": s["startTs"], "status": "no-journal", "model": s["model"], "effort": s["effort"],
                             "tier": tier_of(s["model"], s["effort"], s["startTs"]) if s["model"] else None, "turns": s["turns"], "sessions": 1,
                             "usage": s["usage"], "thinking": s["thinking"], "costUSD": round(s["cost"] or 0, 4), "durationS": round(s["durationS"]),
                             "tools": s["toolCalls"], "title": s["title"], "lastText": s["lastText"], "attempts": 1, "maxTurns": 0, "outputs": "",
                             "limitHits": s["limitHits"], "limitMsg": s["limitMsg"]})
    rows_out.sort(key=lambda r: r["acceptedAt"], reverse=True)

    # hourly series: tokens by model (input+cache_creation+output = what the provider has to compute fresh), plus counts
    hourly = defaultdict(lambda: {"models": defaultdict(lambda: Counter()), "accepted": 0, "submitted": 0, "rateLimited": 0})
    for tr in trs.values():
        for s in tr["sessions"]:
            h = int(s["startTs"] // 3600) * 3600
            u = s["usage"]; mu = hourly[h]["models"][s["model"] or "unknown"]
            mu["fresh"] += u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
            mu["output"] += u.get("output_tokens", 0); mu["cacheRead"] += u.get("cache_read_input_tokens", 0)
            mu["thinking"] += s["thinking"]; mu["cost"] += s["cost"] or 0; mu["sessions"] += 1
    for r in rows_out:
        if r["status"] != "no-journal":
            hourly[int(r["acceptedAt"] // 3600) * 3600]["accepted"] += 1
        if r.get("submittedAt"):
            hourly[int(r["submittedAt"] // 3600) * 3600]["submitted"] += 1
    for rl in ratelimits:
        hourly[int(rl["ts"] // 3600) * 3600]["rateLimited"] += 1

    limit_msgs = []
    for tr in trs.values():
        for s in tr["sessions"]:
            if s["limitHits"]:
                limit_msgs.append({"ts": parse_ts(s["limitAt"]) if s["limitAt"] else s["endTs"], "msg": s["limitMsg"], "hits": s["limitHits"]})
    limit_msgs.sort(key=lambda x: x["ts"])
    for lm in limit_msgs:
        hourly[int(lm["ts"] // 3600) * 3600]["limitHits"] = hourly[int(lm["ts"] // 3600) * 3600].get("limitHits", 0) + lm["hits"]
    hourly_out = [{"ts": h, "accepted": v["accepted"], "submitted": v["submitted"], "rateLimited": v["rateLimited"], "limitHits": v.get("limitHits", 0),
                   "models": {m: dict(c) for m, c in v["models"].items()}} for h, v in sorted(hourly.items())]
    # rate-limit episodes: consecutive rate-limit lines within 20 min form one episode
    episodes = []
    for rl in sorted(ratelimits + [{"ts": lm["ts"], "msg": lm["msg"], "fromClaude": True} for lm in limit_msgs], key=lambda x: x["ts"]):
        if episodes and rl["ts"] - episodes[-1]["end"] < 20 * 60:
            episodes[-1]["end"] = rl["ts"]; episodes[-1]["hits"] += 1
            if rl.get("fromClaude"): episodes[-1]["claudeMsg"] = rl["msg"]
        else:
            episodes.append({"start": rl["ts"], "end": rl["ts"], "hits": 1, "claudeMsg": rl["msg"] if rl.get("fromClaude") else ""})
    for ep in episodes:
        window = ep["start"] - 3600
        prev = Counter()
        for tr in trs.values():
            for s in tr["sessions"]:
                if window <= s["startTs"] < ep["start"] or window <= s["endTs"] < ep["start"]:
                    prev[s["model"] or "unknown"] += s["usage"].get("output_tokens", 0) + s["usage"].get("cache_creation_input_tokens", 0)
                    prev["sessions"] += 1
        ep["prevHour"] = dict(prev)
        ep["durationMin"] = round((ep["end"] - ep["start"]) / 60)

    by_model = defaultdict(Counter)
    for tr in trs.values():
        for s in tr["sessions"]:
            c = by_model[s["model"] or "unknown"]
            c.update(s["usage"]); c["thinking"] += s["thinking"]; c["sessions"] += 1; c["turns"] += s["turns"]; c["cost"] += s["cost"] or 0
            c["durationS"] += s["durationS"]

    totals = Counter()
    for r in rows_out:
        totals["accepted"] += r["status"] != "no-journal"; totals["submitted"] += bool(r.get("submittedAt"))
        totals["rateLimited"] += r["status"] == "rate-limited"; totals["cancelled"] += r["status"] == "cancelled"
        totals["output"] += r["usage"].get("output_tokens", 0); totals["fresh"] += r["usage"].get("input_tokens", 0) + r["usage"].get("cache_creation_input_tokens", 0)
        totals["cacheRead"] += r["usage"].get("cache_read_input_tokens", 0); totals["cost"] += r["costUSD"]; totals["turns"] += r["turns"]
    last_alive = alive[-1] if alive else None
    return {"generatedAt": time.time(), "host": HOST, "journalError": jerr, "collectMs": round((time.time() - t0) * 1000),
            "journalFrom": rows[0][0] if rows else None, "totals": dict(totals), "byModel": {m: dict(c) for m, c in by_model.items()},
            "tasks": rows_out, "hourly": hourly_out, "events": events[-300:], "alive": alive[-2000:], "rateLimits": ratelimits,
            "episodes": episodes, "lastAlive": last_alive, "limitMsgs": limit_msgs}


# ================================================================ extras (explorer, host, config)
import shutil, urllib.request
from datetime import timedelta

CONFIG = os.path.join(IDENTITYMD_HOME, "config.json")
UNIT_FILE = os.path.join(HOME, ".config", "systemd", "user", UNIT)
EXPLORER = "https://explorer.imd.fun"
ALLOWED_MODELS = ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"]
# models that take no --effort (Haiku 4.5 errors on it)
NO_EFFORT_MODELS = {"claude-haiku-4-5-20251001"}
# premium tier: the worker only accepts Fable 5.1 high/xhigh/max here; anything else (e.g. Opus) makes it
# stop advertising premium capability to the server (= opt out of premium tasks)
PREMIUM_OPT_OUT = {"model": "claude-opus-5", "effort": "medium"}
ALLOWED_EFFORT = ["low", "medium", "high", "xhigh", "max"]
_slow = {}  # name -> (ts, value)


def memo(name, ttl, fn):
    now = time.time()
    hit = _slow.get(name)
    if hit and now - hit[0] < ttl:
        return hit[1]
    try:
        v = fn()
    except Exception as e:
        v = {"error": str(e)[:200]}
        if hit:  # keep stale value on failure
            v = dict(hit[1], error=str(e)[:200]) if isinstance(hit[1], dict) else hit[1]
        _slow[name] = (now - max(0, ttl - 120), v)  # a failed fetch is retried after 2 min, not a full ttl
        return v
    _slow[name] = (now, v)
    return v


def http_get(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": "imd-panel/1 (+localhost)"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def read_config():
    with open(CONFIG) as fh:
        c = json.load(fh)
    return {"tokenId": c.get("tokenId"), "maxConcurrency": c.get("maxConcurrency"), "skillsOptOut": c.get("skillsOptOut") or [],
            "inference": c.get("inference") or {}, "server": c.get("server"), "wallet": c.get("wallet")}


TIER_DEFAULTS = (("standard", {"model": "claude-opus-5", "effort": "high", "note": "Claude Code default"}),
                 ("economy", {"model": "claude-sonnet-5", "effort": "low", "note": "worker default"}),
                 ("premium", {"model": PREMIUM_MODEL, "effort": "high", "note": "fixed by the worker"}))


def config_tiers(c=None):
    """What each tier runs right now: the override from config.json, or the
    default the worker applies when a tier has none. Single source of truth for
    the config panel and for the tier log."""
    if c is None:
        try:
            with open(CONFIG) as fh:
                c = json.load(fh)
        except (OSError, ValueError):
            c = {}
    inf = c.get("inference") or {}
    out = {}
    for tier, dflt in TIER_DEFAULTS:
        own = (inf.get(tier) or {}).get("claude")
        if tier == "premium" and own and own.get("model") != PREMIUM_MODEL:
            # opting out sets premium to another tier's model; it serves nothing from then on
            out[tier] = {"model": own.get("model"), "effort": own.get("effort"), "optOut": True,
                         "source": "config.json", "note": "opted out — premium not advertised"}
        elif own:
            out[tier] = {"model": own.get("model"), "effort": own.get("effort"), "source": "config.json", "note": ""}
        else:
            out[tier] = {**dflt, "source": "default"}
    return out


def unit_started_at(unit=UNIT):
    """When the worker last started — i.e. when it last read config.json."""
    v = systemctl_show(unit, ["ExecMainStartTimestamp"]).get("ExecMainStartTimestamp", "")
    m = re.search(r"(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:\.\d+)?\s*(\S+)?", v)
    if not m:
        return None
    dt = datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S")
    tz = timezone.utc if (m.group(2) or "").upper() == "UTC" else None
    return dt.replace(tzinfo=tz).timestamp() if tz else dt.timestamp()


def sync_tiers():
    """Keep the tier log current, whoever changed the config and however."""
    try:
        mtime = os.path.getmtime(CONFIG)
    except OSError:
        mtime = None
    started = memo("worker-start", 30, unit_started_at)
    snap, pending = tiers.sync(config_tiers(), mtime, started if isinstance(started, float) else None)
    return {"snapshots": tiers.timeline(), "pending": pending,
            "configAt": mtime, "workerStartedAt": started if isinstance(started, float) else None,
            "recorded": snap}


def effective_config():
    """Everything that decides what the worker runs — read-only, secrets left out (for the config panel + export)."""
    try:
        with open(CONFIG) as fh:
            c = json.load(fh)
    except (OSError, ValueError):
        c = {}
    try:
        unit = open(UNIT_FILE).read()
    except OSError:
        unit = ""
    exec_ = re.search(r"^ExecStart=(.*)$", unit, re.M)
    args = re.findall(r'"([^"]*)"', exec_.group(1)) if exec_ else []
    flag = lambda k: (args[args.index(k) + 1] if k in args and args.index(k) + 1 < len(args) else None)
    inf = c.get("inference") or {}
    tmap = config_tiers(c)  # not `tiers`: that name is the module
    def ver(cmd):
        try:
            return subprocess.run(cmd, capture_output=True, text=True, timeout=30, env=imd_env()).stdout.strip()[:40]
        except Exception:
            return "?"
    return {"configPath": CONFIG, "unitPath": UNIT_FILE, "server": c.get("server"), "tokenId": c.get("tokenId"),
            "wallet": c.get("wallet"), "maxConcurrency": c.get("maxConcurrency"), "skillsOptOut": c.get("skillsOptOut") or [],
            "inference": inf, "tiers": tmap,
            "otherKeys": sorted(k for k in c if k not in ("server", "deviceKey", "devicePrivateKey", "maxConcurrency", "wallet", "tokenId", "skillsOptOut", "inference")),
            "unit": {"execStart": exec_.group(1) if exec_ else None, "runtime": flag("--runtime"), "concurrency": flag("--concurrency"),
                     "autoUpdate": "--auto-update" in args, "node": args[0] if args else None},
            "versions": {"node": ver(["node", "--version"]), "claude": ver(["claude", "--version"]), "worker": memo("version", 3600, worker_version)}}


def unit_concurrency():
    try:
        m = re.search(r'"--concurrency"\s+"(\d)"', open(UNIT_FILE).read())
        return int(m.group(1)) if m else None
    except OSError:
        return None


def explorer_fetch(token_id):
    """The explorer's own JSON readout for the agent. Rows, verdicts and job links now come from the control
    plane (see the "public API" section below), so the agent page is no longer scraped."""
    out = {"tokenId": token_id, "agentUrl": f"{EXPLORER}/agents/{token_id}", "verdicts": {}, "titles": {}, "rows": {}, "published": [], "unpublished": [], "counts": {}}
    if not token_id:
        return out
    out["agent"] = json.loads(http_get(f"{EXPLORER}/api/agents/{token_id}"))
    try:
        out["activity"] = json.loads(http_get(f"{EXPLORER}/api/activity", timeout=10))
    except Exception as e:
        out["activity"] = {"error": str(e)[:100]}
    return out


def imd_bin():
    p = shutil.which("imd")
    if p:
        return p
    cands = sorted(glob.glob(os.path.join(HOME, ".nvm", "versions", "node", "*", "bin", "imd")), reverse=True)
    return cands[0] if cands else "imd"


def imd_env():
    """The PATH a login shell has: the service unit only knows node's bin, but `imd doctor` looks for claude
    (~/.local/bin) and forge (~/.foundry/bin) on PATH and reports them missing otherwise."""
    extra = [os.path.dirname(imd_bin()), os.path.join(HOME, ".local", "bin"), os.path.join(HOME, ".foundry", "bin")]
    have = os.environ.get("PATH", "/usr/bin:/bin").split(":")
    return dict(os.environ, PATH=":".join([e for e in extra if e not in have] + have))


def skills_list():
    r = subprocess.run([imd_bin(), "skills"], capture_output=True, text=True, timeout=60, env=imd_env())
    out = []
    for line in r.stdout.splitlines():
        m = re.match(r"\s+(on|off)\s+(\S+)(?:\s+—\s+(.*))?", line)
        if m:
            out.append({"id": m.group(2), "on": m.group(1) == "on", "note": (m.group(3) or "").strip()})
    return out


def worker_version():
    r = subprocess.run([imd_bin(), "--help"], capture_output=True, text=True, timeout=30, env=imd_env())
    m = re.search(r"\(v([^)]+)\)", r.stdout + r.stderr)
    return m.group(1) if m else "?"


def systemctl_show(unit, props):
    r = subprocess.run(["systemctl", "--user", "show", unit, "-p", ",".join(props)], capture_output=True, text=True, timeout=15)
    return dict(l.split("=", 1) for l in r.stdout.splitlines() if "=" in l)


def du(path):
    r = subprocess.run(["du", "-sb", path], capture_output=True, text=True, timeout=120)
    try:
        return int(r.stdout.split()[0])
    except (IndexError, ValueError):
        return None


def host_stats():
    d = shutil.disk_usage("/")
    mem = {}
    with open("/proc/meminfo") as fh:
        for line in fh:
            k, v = line.split(":", 1); mem[k] = int(v.split()[0]) * 1024
    with open("/proc/uptime") as fh:
        up = float(fh.read().split()[0])
    w = systemctl_show(UNIT, ["ActiveState", "NRestarts", "MemoryCurrent", "MemoryPeak", "MemoryMax", "CPUUsageNSec", "CPUQuotaPerSecUSec", "ActiveEnterTimestamp", "TasksCurrent"])
    if PANEL["cleanUnit"]:
        t = systemctl_show(PANEL["cleanUnit"].replace(".service", "") + ".timer", ["LastTriggerUSec", "NextElapseUSecRealtime", "ActiveState"])
    else:  # the panel prunes by itself once a day (see server.prune_loop)
        t = {"ActiveState": "built-in", "NextElapseUSecRealtime": "daily", "LastTriggerUSec": ""}
    dash = systemctl_show("imd-panel.service", ["MemoryCurrent", "ActiveEnterTimestamp"])
    work = os.path.join(IDENTITYMD_HOME, "work")
    try:
        work_dirs = sum(1 for g in os.listdir(work) for _ in os.listdir(os.path.join(work, g)))
    except OSError:
        work_dirs = None
    tr_dirs = len(glob.glob(os.path.join(PROJECTS, "*identitymd-work*")))
    return {"disk": {"total": d.total, "free": d.free}, "mem": {"total": mem.get("MemTotal"), "available": mem.get("MemAvailable")},
            "load": os.getloadavg(), "uptimeS": up, "cpus": os.cpu_count(), "worker": w, "timer": t, "dashboard": dash,
            "workBytes": du(work), "workDirs": work_dirs, "transcriptBytes": du(PROJECTS), "transcriptDirs": tr_dirs,
            "version": memo("version", 3600, worker_version)}


RE_RESET = re.compile(r"resets (\d{1,2}):(\d\d)(am|pm) \(UTC\)")


CREDENTIALS = os.path.expanduser("~/.claude/.credentials.json")


def claude_usage():
    """Claude's own 5-hour / 7-day utilisation for this account (what `/usage` shows), via the OAuth token
    Claude Code keeps in ~/.claude/.credentials.json. Percentages only; the token never reaches the page."""
    with open(CREDENTIALS) as fh:
        tok = (json.load(fh).get("claudeAiOauth") or {}).get("accessToken")
    if not tok:
        raise RuntimeError("no OAuth token in credentials file")
    req = urllib.request.Request("https://api.anthropic.com/api/oauth/usage",
                                 headers={"Authorization": "Bearer " + tok, "anthropic-beta": "oauth-2025-04-20", "Accept": "application/json", "User-Agent": "imd-panel"})
    with urllib.request.urlopen(req, timeout=20) as r:
        u = json.loads(r.read().decode())
    def win(x):
        if not x: return None
        ra = x.get("resets_at")
        try:
            ts = _dt.datetime.fromisoformat(ra.replace("Z", "+00:00")).timestamp() if ra else None
        except ValueError:
            ts = None
        return {"pct": x.get("utilization"), "resetsAt": ts}
    limits = [{"kind": l.get("kind"), "pct": l.get("percent"), "severity": l.get("severity"), "resetsAt": win(l).get("resetsAt") if win(l) else None, "active": l.get("is_active")} for l in (u.get("limits") or [])]
    return {"fiveHour": win(u.get("five_hour")), "sevenDay": win(u.get("seven_day")), "limits": limits, "fetchedAt": time.time()}


def quota_window(limit_msgs, trs_sessions, now=None):
    """Approximate the Claude 5-hour session window from the last 'resets H:MMam (UTC)' message."""
    now = now or time.time()
    reset = None
    for lm in reversed(limit_msgs):
        m = RE_RESET.search(lm["msg"])
        if m:
            h, mi, ap = int(m.group(1)), int(m.group(2)), m.group(3)
            h = h % 12 + (12 if ap == "pm" else 0)
            day = datetime.fromtimestamp(lm["ts"], timezone.utc).replace(hour=h, minute=mi, second=0, microsecond=0)
            reset = day.timestamp()
            if reset < lm["ts"]:
                reset += 86400
            break
    starts = sorted(s["startTs"] for s in trs_sessions)
    start = None
    if reset and reset <= now:  # window began with the first session after the reset
        after = [t for t in starts if t >= reset]
        start = after[0] if after else None
    elif reset:
        start = reset - 5 * 3600
    if start is None and not reset:
        start = now - 5 * 3600
    # roll forward: each elapsed window is followed by a new one that opens with the next session
    while start is not None and start + 5 * 3600 < now:
        after = [t for t in starts if t >= start + 5 * 3600]
        start = after[0] if after else None
    if start is None:  # no active window: nothing ran since the last one elapsed
        return {"lastReset": reset, "windowStart": None, "windowEnd": None, "used": {}, "approx": True}
    used = Counter()
    for s in trs_sessions:
        if s["endTs"] >= start:
            u = s["usage"]; used[s["model"] or "unknown"] += u.get("output_tokens", 0) + u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
            used["cost"] += s["cost"] or 0; used["sessions"] += 1
    return {"lastReset": reset, "windowStart": start, "windowEnd": start + 5 * 3600, "used": dict(used), "approx": True}


def pass_config(d):
    """Config, effective tiers, skills, host stats, explorer agent page."""
    cfg = memo("config", 5, read_config)
    d["config"] = cfg
    d["config"]["unitConcurrency"] = unit_concurrency()
    d["config"]["allowedModels"] = ALLOWED_MODELS; d["config"]["allowedEffort"] = ALLOWED_EFFORT; d["config"]["noEffortModels"] = sorted(NO_EFFORT_MODELS)
    d["config"]["premiumModel"] = PREMIUM_MODEL
    d["effective"] = memo("effective", 30, effective_config)
    d["skills"] = memo("skills", 300, skills_list)
    d["hostName"] = HOST  # "host" below is replaced by the host stats
    d["host"] = memo("host", 60, host_stats)
    ex = memo("explorer", 300, lambda: explorer_fetch(cfg.get("tokenId")))
    d["explorer"] = {k: v for k, v in ex.items() if k not in ("verdicts", "titles")}
    verdicts = ex.get("verdicts", {}) if isinstance(ex, dict) else {}
    acc = defaultdict(Counter)
    for t in d["tasks"]:
        job = (t.get("workDir") or "/").split("/")[0]
        t["job"] = job or None
        t["jobUrl"] = f"{EXPLORER}/jobs/{job}" if job else None
        t["verdict"] = verdicts.get(job) or ("pending" if t.get("submittedAt") else None)
        if t["verdict"] in ("accepted", "rejected"):
            acc["model:" + (t.get("model") or "unknown")][t["verdict"]] += 1
            acc["tier:" + (t.get("tier") or "unknown")][t["verdict"]] += 1
            acc["all"][t["verdict"]] += 1
    d["acceptance"] = {k: dict(v) for k, v in acc.items()}
    sessions = [s for tr in transcripts().values() for s in tr["sessions"]]
    d["quota"] = quota_window(d["limitMsgs"], sessions)
    d["usage"] = memo("usage", 120, claude_usage)  # the endpoint rate-limits; a stale value is kept on failure
    # live view of what is running right now
    now = time.time()
    try:
        procs = subprocess.run(["pgrep", "-fc", "^claude -p "], capture_output=True, text=True, timeout=5).stdout.strip()
        d["claudeProcs"] = int(procs or 0)
    except Exception:
        d["claudeProcs"] = None
    running = []
    for t in d["tasks"]:
        if t["status"] != "accepted" or t.get("submittedAt"):
            continue
        names = by_short_names(trs_cache(), t["id"])
        live = [x for n in names for x in trs_cache()[n]["sessions"]]
        last = max(live, key=lambda x: x["endTs"]) if live else None
        running.append({"id": t["id"], "job": t.get("job"), "jobUrl": t.get("jobUrl"), "title": t.get("title"), "model": t.get("model"), "effort": t.get("effort"),
                        "tier": t.get("tier"), "acceptedAt": t["acceptedAt"], "elapsedS": round(now - t["acceptedAt"]), "turns": t["turns"], "maxTurns": t.get("maxTurns"),
                        "usage": t["usage"], "costUSD": t["costUSD"], "tools": t["tools"], "lastText": t.get("lastText"), "attempts": t.get("attempts"),
                        "lastActivityS": round(now - last["endTs"]) if last else None, "outputs": t.get("outputs")})
    d["running"] = running
    return d


_trs_cache = {"ts": 0, "v": None}


def trs_cache():
    return _trs_cache["v"] if _trs_cache["v"] is not None else transcripts()


def by_short_names(trs, sid):
    out = []
    for name, tr in trs.items():
        for u in (tr["group"], tr["task"]):
            if u and u[:8] == sid:
                out.append(name); break
    return out


ETHERSCAN = "https://etherscan.io"


# ================================================================ rejection reasons + transcript viewer
WORK = os.path.join(IDENTITYMD_HOME, "work")

def pass_explorer(d):
    """Explorer job pages and the running list."""
    # the explorer publishes a job page only once the job is done; while it is still executing the agent page shows
    # the job's short hash without a link — send those to the agent's pending list instead of a 404
    ex = d.get("explorer") or {}
    unpub = set(ex.get("unpublished") or []); tok = ex.get("tokenId"); rows = ex.get("rows") or {}
    for t in d["tasks"]:
        oracle_like = (t.get("outputs") or "").endswith("answer.json") or (t.get("title") or "").startswith("Answer this question")
        row = rows.get(t.get("submissionId") or "")
        if row:
            # the explorer's own row for this submission: its link (a launched job lives under its parent job page,
            # e.g. /jobs/<parent>#contracts), its kind label or oracle answer, and its verdict word
            if row.get("href"):
                t["jobUrl"] = EXPLORER + row["href"]; t["jobPublished"] = True
            if row.get("state") in ("accepted", "rejected"):
                t["verdict"] = row["state"]  # the row is keyed by our submission, so it beats the job-level lookup (a launched step lives under its parent job)
            is_oracle = oracle_like or row.get("word") in ("agreed", "differed") or (row.get("label") or "") in ("true", "false")
            t["kindLabel"] = "oracle" if is_oracle else ((row.get("label") or t.get("kind") or "").lower())
            t["explorer"] = {"answer": row.get("label") if is_oracle else None, "word": row.get("word"), "state": row.get("state"), "launched": "launched" in (row.get("tags") or [])}
        else:
            t["kindLabel"] = "oracle" if oracle_like else t.get("kind")
            if t.get("job") and t["job"][:8] in unpub and t["job"] not in (ex.get("published") or []) and tok:
                t["jobPublished"] = False
                t["jobUrl"] = f"{EXPLORER}/agents/{tok}?show=pending"
    by_id = {t["id"]: t for t in d["tasks"]}
    for r in d.get("running") or []:
        src = by_id.get(r["id"]) or {}
        r["kind"] = src.get("kind"); r["kindLabel"] = src.get("kindLabel"); r["jobUrl"] = src.get("jobUrl") or r.get("jobUrl")
    # the acceptance summary counts verdicts, so it must see the corrected ones
    if "acceptance" in d:
        acc = defaultdict(Counter)
        for t in d["tasks"]:
            if t.get("verdict") in ("accepted", "rejected"):
                acc["all"][t["verdict"]] += 1
                if t.get("tier"): acc["tier:" + t["tier"]][t["verdict"]] += 1
                if t.get("model"): acc["model:" + t["model"]][t["verdict"]] += 1
        d["acceptance"] = {k: dict(v) for k, v in acc.items()}
    return d


def find_transcripts(short_id):
    if not re.fullmatch(r"[0-9a-zA-Z_-]{1,40}", short_id):
        return []
    paths = []
    for d in glob.glob(os.path.join(PROJECTS, "*identitymd-work*")):
        rest = os.path.basename(d).split("identitymd-work-", 1)[1]
        uuids = re.findall(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", rest)
        if any(u.startswith(short_id) for u in uuids) or (not uuids and rest.startswith(short_id)):
            paths += glob.glob(os.path.join(d, "*.jsonl"))
    return sorted(paths, key=os.path.getmtime)


RE_URL = re.compile(r"https?://[^\s\"'<>)\]]+")
RPC_HOSTS = re.compile(r"rpc|drpc|alchemy|infura|ankr|quiknode|quicknode|publicnode|llamarpc|blastapi|chainstack|nodereal|1rpc|thirdweb|gateway\.tenderly|cloudflare-eth|ordofi", re.I)
PROXY_APIS = ("opensea", "coingecko", "trends", "magiceden")


def net_of(name, text):
    """Classify a tool call as network use: rpc (chain reads), api (market data / any other http host), web (the
    agent's own WebFetch/WebSearch). Returns None for local work."""
    if name in ("WebFetch", "WebSearch"):
        m = RE_URL.search(text or "")
        return {"kind": "web", "hosts": [m.group(0).split("/")[2] if m else name]}
    text = text or ""; kinds = Counter(); hosts = []
    for u in RE_URL.findall(text):
        try:
            host = u.split("/")[2]; path = "/" + "/".join(u.split("/")[3:])
        except IndexError:
            continue
        if PROXY_PORTS and host.split(":")[0] in ("127.0.0.1", "localhost") and host.split(":")[-1] in PROXY_PORTS:  # an operator's local keyed proxy (panel.json proxyPorts)
            seg = path.strip("/").split("/")[0].split("?")[0]
            if seg.isdigit(): kinds["rpc"] += 1; hosts.append(f"proxy rpc chain {seg}")
            elif seg in PROXY_APIS: kinds["api"] += 1; hosts.append(f"proxy {seg}")
            else: kinds["api"] += 1; hosts.append("proxy " + (seg or "/"))
        elif RPC_HOSTS.search(host) or "/rpc" in path.lower():
            kinds["rpc"] += 1; hosts.append(host)
        else:
            kinds["api"] += 1; hosts.append(host)
    if re.search(r"\bcast\s+(call|logs|block|rpc|balance|storage|code|receipt|tx|chain-id|block-number)\b", text) or "--rpc-url" in text:
        kinds["rpc"] += 1; hosts.append("cast")
    if "scan.mjs" in text and "rpc" not in " ".join(hosts).lower():
        kinds["rpc"] += 1; hosts.append("scan.mjs")
    if not kinds:
        return None
    kind = "rpc" if kinds["rpc"] >= kinds["api"] else "api"
    return {"kind": kind, "hosts": sorted(set(hosts))[:6]}


def parse_prompt(prompt):
    """The worker prompt's own sections: what the swarm asked, how it is judged, what was given to read."""
    out = {}
    m = re.search(r"^Task \((\w+)\):\s*\n(.*?)(?=\n\s*\nAcceptance criteria:|\n\s*\nReference for this kind|\Z)", prompt, re.S | re.M)
    if m: out["role"] = m.group(1); out["task"] = m.group(2).strip()
    m = re.search(r"^Acceptance criteria:\s*\n((?:[ \t]*-.*\n?)+)", prompt, re.M)
    if m: out["criteria"] = [l.strip()[1:].strip() for l in m.group(1).splitlines() if l.strip().startswith("-")]
    m = re.search(r"^What you have been given to read:\s*\n((?:[ \t]*-.*\n?)+)", prompt, re.M)
    if m: out["reads"] = [l.strip()[1:].strip() for l in m.group(1).splitlines() if l.strip().startswith("-")]
    m = re.search(r"You may only create or modify these paths: (.*)", prompt)
    if m: out["paths"] = m.group(1).strip()
    m = re.search(r"Execution/check profile: (\S+)", prompt)
    if m: out["profile"] = m.group(1).rstrip(".")
    ids = re.findall(r"\((oracle-request|workflow-brief|launch|planning-brief):([^)]+)\)", prompt)
    out["readIds"] = [f"{ns}:{name}" for ns, name in ids][:4]
    return out


def read_fetch(ref):
    """GET /reads/:namespace/:name — the exact input file the task was judged against (e.g. the pinned oracle request)."""
    ns, _, name = ref.partition(":")
    d = api_json(f"/reads/{ns}/{name}", timeout=20)
    files = []
    for f in d.get("files") or []:
        c = f.get("content") or ""
        parsed = None
        if f.get("path", "").endswith(".json"):
            try: parsed = json.loads(c)
            except ValueError: parsed = None
        files.append({"path": f.get("path"), "content": c[:8000], "json": parsed})
    return {"name": d.get("name") or ref, "files": files}


def transcript(short_id, max_chars=400000):
    """Prompt, condensed turn timeline, files written and artifacts for one task."""
    paths = find_transcripts(short_id)
    if not paths:
        return {"error": "no transcript for " + short_id}
    out = {"id": short_id, "sessions": [], "files": [], "artifacts": [], "workDir": None, "produced": []}
    written = []; produced = []
    for p in paths:
        sess = {"session": os.path.basename(p)[:-6], "prompt": "", "system": "", "turns": [], "final": "", "model": None, "cost": None}
        results = {}
        with open(p, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try: o = json.loads(line)
                except ValueError: continue
                typ = o.get("type"); m = o.get("message") or {}
                if typ == "user":
                    c = m.get("content")
                    if isinstance(c, list):
                        for b in c:
                            if isinstance(b, dict) and b.get("type") == "tool_result":
                                rc = b.get("content"); txt = rc if isinstance(rc, str) else " ".join(x.get("text", "") for x in (rc or []) if isinstance(x, dict))
                                results[b.get("tool_use_id")] = (txt or "")[:1500]
                    if not sess["prompt"]:
                        sess["prompt"] = text_of(c or "")
                        sess["cwd"] = o.get("cwd"); out["workDir"] = out["workDir"] or o.get("cwd")
                elif typ == "assistant":
                    if m.get("model") == "<synthetic>" or o.get("isApiErrorMessage"):
                        sess["turns"].append({"ts": o.get("timestamp"), "kind": "error", "text": text_of(m.get("content") or "")[:300]}); continue
                    sess["model"] = m.get("model") or sess["model"]
                    u = m.get("usage") or {}
                    turn = {"ts": o.get("timestamp"), "kind": "turn", "out": u.get("output_tokens", 0), "cacheW": u.get("cache_creation_input_tokens", 0), "cacheR": u.get("cache_read_input_tokens", 0), "text": "", "tools": []}
                    for b in m.get("content") or []:
                        if not isinstance(b, dict): continue
                        if b.get("type") == "text": turn["text"] += b.get("text", "")
                        elif b.get("type") == "thinking": turn["thinking"] = (turn.get("thinking", "") + b.get("thinking", ""))[:1200]
                        elif b.get("type") == "tool_use":
                            inp = b.get("input") or {}
                            summ = inp.get("command") or inp.get("file_path") or inp.get("pattern") or inp.get("url") or inp.get("query") or json.dumps(inp)[:300]
                            turn["tools"].append({"id": b.get("id"), "name": b.get("name"), "input": str(summ)[:600], "net": net_of(b.get("name"), str(summ))})
                            if b.get("name") in ("Write", "Edit", "MultiEdit", "NotebookEdit") and inp.get("file_path"):
                                written.append(inp["file_path"])
                                body = inp.get("content") if b.get("name") == "Write" else ("--- old\n%s\n+++ new\n%s" % (inp.get("old_string", ""), inp.get("new_string", "")))
                                produced.append({"path": inp["file_path"], "tool": b.get("name"), "ts": o.get("timestamp"), "content": (body or "")[:20000]})
                    turn["text"] = turn["text"][:4000]
                    if turn["text"]: sess["final"] = turn["text"]
                    sess["turns"].append(turn)
                elif typ == "cost-state":
                    sess["cost"] = o.get("totalCostUSD")
        net = Counter(); hosts = Counter()
        for turn in sess["turns"]:
            for t in turn.get("tools", []):
                t["result"] = results.get(t.pop("id"), "")
                if t.get("net"):
                    net[t["net"]["kind"]] += 1
                    for h in t["net"]["hosts"]: hosts[h] += 1
        sess["net"] = {"rpc": net["rpc"], "api": net["api"], "web": net["web"], "hosts": dict(hosts.most_common(12))}
        sess["ask"] = parse_prompt(sess["prompt"]) if sess["prompt"] else {}
        out["sessions"].append(sess)
    # the inputs the task was judged against (pinned oracle request, workflow brief …), from the control plane
    out["reads"] = []
    for ref in {r for sess in out["sessions"] for r in (sess.get("ask") or {}).get("readIds", [])}:
        rd = memo("read:" + ref, 6 * 3600, lambda ref=ref: read_fetch(ref))
        if isinstance(rd, dict) and not rd.get("error"):
            out["reads"].append(rd)
        else:
            out["reads"].append({"name": ref, "files": [], "error": (rd or {}).get("error") if isinstance(rd, dict) else str(rd)})
    out["files"] = sorted(set(written)); out["produced"] = produced[-40:]
    wd = out["workDir"]
    if wd and os.path.isdir(wd) and os.path.realpath(wd).startswith(os.path.realpath(WORK) + os.sep):
        out["workDirExists"] = True
        try:
            st = subprocess.run(["git", "-C", wd, "status", "--short", "--untracked-files=all"], capture_output=True, text=True, timeout=20).stdout
            out["gitStatus"] = st[:4000]
        except Exception: pass
        art = os.path.join(wd, "artifacts")
        if os.path.isdir(art):
            for root, _, files in os.walk(art):
                for f in sorted(files)[:20]:
                    fp = os.path.join(root, f)
                    try:
                        size = os.path.getsize(fp)
                        with open(fp, encoding="utf-8", errors="replace") as fh:
                            content = fh.read(20000)
                        out["artifacts"].append({"path": os.path.relpath(fp, wd), "size": size, "content": content})
                    except OSError: pass
    else:
        out["workDirExists"] = False
    total = json.dumps(out)
    if len(total) > max_chars:  # trim tool results first
        for sess in out["sessions"]:
            for turn in sess["turns"]:
                for t in turn.get("tools", []): t["result"] = t["result"][:200]
    return out


# ================================================================ IMD public API (imd.fun/docs) — seat, submissions, standing, network, earnings
API = "https://api.imd.fun"
CHAINS = {1: ("mainnet", "https://etherscan.io"), 11155111: ("sepolia", "https://sepolia.etherscan.io"), 8453: ("base", "https://basescan.org"),
          84532: ("base sepolia", "https://sepolia.basescan.org"), 10: ("optimism", "https://optimistic.etherscan.io"), 42161: ("arbitrum", "https://arbiscan.io")}
FINAL_JOB_STATES = ("completed", "cancelled", "blocked", "failed")
REVIEW_RANK = {"sent": 3, "submitted": 2, "queued": 1}
_subs = {}  # job id -> (ts, value): our attempts on that job, from /jobs/:id/submissions


def api_json(path, timeout=20):
    return json.loads(http_get(API + path, timeout=timeout))


def chain_of(cid):
    name, scan = CHAINS.get(int(cid or 0), (f"chain {cid}", None))
    return {"id": cid, "name": name, "scan": scan}


def seat_fetch(token):
    """GET /seats/:tokenId with every submission and review: the server's own record of this seat."""
    d = api_json(f"/seats/{token}?work=1000&reviews=1000", timeout=40)
    work = {}
    for w in d.get("work") or []:
        h = (w.get("submissionHash") or "")[:12]
        if h:
            work[h] = w
    reviews = {}; rstat = Counter()
    for r in d.get("reviews") or []:
        h = (r.get("submissionHash") or "")[:12]; rstat[r.get("status") or "?"] += 1
        if h and REVIEW_RANK.get(r.get("status"), 0) >= REVIEW_RANK.get((reviews.get(h) or {}).get("status"), 0):
            reviews[h] = r
    collab = d.get("collaborators") or []
    runtimes = d.get("runtimes") or []
    return {"tokenId": d.get("tokenId"), "agentId": d.get("agentId"), "owner": d.get("owner"), "ownership": d.get("ownership"), "status": d.get("status"),
            "online": d.get("online"), "daemonVersion": d.get("daemonVersion"), "devices": d.get("devices"), "pairedAt": d.get("pairedAt"),
            "premiumModel": (runtimes[0].get("premiumModel") if runtimes else None), "runtime": (runtimes[0].get("version") if runtimes else None),
            "record": {k: d.get(k) for k in ("attempts", "accepted", "rejected", "failed", "pending")},
            "reviews": dict(rstat), "collaborators": len(collab), "topCollaborators": sorted(collab, key=lambda c: -(c.get("sharedJobs") or 0))[:3],
            "collabList": [{"tokenId": c.get("tokenId"), "agentId": c.get("agentId"), "sharedJobs": c.get("sharedJobs")} for c in collab],
            "roles": dict(Counter(w.get("role") for w in work.values())), "nodeKeys": dict(Counter(w.get("nodeKey") for w in work.values())),
            "lastAcceptedAt": max((w.get("acceptedAt") or "" for w in work.values()), default=None),
            "work": work, "reviewBySub": reviews, "url": f"{API}/seats/{token}"}


def submissions_fetch(job, token):
    """Every attempt on a job; ours picked out by seat. Cached 6 h once our attempt is final, 5 min while pending."""
    d = api_json(f"/jobs/{job}/submissions", timeout=30)
    subs = d.get("submissions") or []
    mine = [s for s in subs if str((s.get("seat") or {}).get("tokenId")) == str(token)]
    field = {"attempts": len(subs), "accepted": sum(1 for s in subs if s.get("accepted")), "seats": len({(s.get("seat") or {}).get("tokenId") for s in subs}),
             "runtimes": dict(Counter((s.get("usage") or {}).get("runtime") or "?" for s in subs))}
    out = []
    for s in mine:
        v = s.get("verdict") or {}; o = s.get("oracleResult") or {}; u = s.get("usage") or {}
        final = bool(s.get("accepted")) or s.get("outcome") == "failed" or o.get("status") in ("accepted", "rejected") or v.get("status") == "rejected"
        out.append({"hash": (s.get("hash") or "")[:12], "nodeKey": s.get("nodeKey"), "role": s.get("role"), "attempt": s.get("attempt"), "outcome": s.get("outcome"),
                    "accepted": s.get("accepted"), "failureReason": s.get("failureReason"), "final": final, "createdAt": s.get("createdAt"),
                    "usage": {"model": u.get("model"), "runtime": u.get("runtime"), "turns": u.get("turns"), "input": u.get("inputTokens"), "output": u.get("outputTokens"),
                              "cached": u.get("cachedInputTokens"), "wallClockMs": u.get("wallClockMs")},
                    "verdict": {k: v.get(k) for k in ("status", "evaluation", "rejectionCode", "detail", "failedChecks", "at")} if v else None,
                    "oracle": {k: o.get(k) for k in ("status", "detail", "requestId", "createdAt")} if o else None,
                    "summary": (s.get("summary") or "")[:600], "artifacts": [a.get("path") for a in (s.get("artifacts") or [])],
                    "changedPaths": (s.get("changedPaths") or [])[:20], "findings": len(s.get("findings") or [])})
    allm = [{"tokenId": str((x.get("seat") or {}).get("tokenId")), "nodeKey": x.get("nodeKey"), "role": x.get("role"), "accepted": bool(x.get("accepted")),
             "final": bool(x.get("accepted")) or x.get("outcome") == "failed" or (x.get("oracleResult") or {}).get("status") in ("accepted", "rejected") or (x.get("verdict") or {}).get("status") == "rejected",
             "model": (x.get("usage") or {}).get("model"), "runtime": (x.get("usage") or {}).get("runtime")} for x in subs]
    return {"job": job, "mine": out, "all": allm, "field": field, "fetchedAt": time.time(), "final": all(m["final"] for m in out) if out else False}


def subs_cached(job, token, budget):
    """Cache in front of submissions_fetch. budget is a one-element list: fetches still allowed in this collect()."""
    hit = _subs.get(job)
    if hit and time.time() - hit[0] < (6 * 3600 if hit[1].get("final") else 300):
        return hit[1]
    if budget[0] <= 0:
        return hit[1] if hit else None
    budget[0] -= 1
    try:
        v = submissions_fetch(job, token)
    except Exception as e:
        v = dict(hit[1], error=str(e)[:120]) if hit else {"job": job, "mine": [], "field": {}, "error": str(e)[:120], "final": False}
    _subs[job] = (time.time(), v)
    return v


def standing_fetch(token):
    """GET /seats/:tokenId/standing: presence, breaker, dispatch eligibility, queue."""
    d = api_json(f"/seats/{token}/standing", timeout=20)
    p = d.get("presence") or {}; st = d.get("standing") or {}; q = d.get("queue") or {}; en = d.get("enrollment") or {}
    return {"at": d.get("at"), "enrollment": {k: en.get(k) for k in ("status", "registered", "pairedAt", "lastSeenAt")},
            "presence": {k: p.get(k) for k in ("connected", "acceptingWork", "connectedAt", "lastHeartbeatAt", "heartbeatAgeMs", "stale", "daemonVersion", "maxConcurrency", "kinds", "profiles")},
            "skills": len(p.get("skills") or []), "platform": p.get("platform"),
            "standing": {k: st.get(k) for k in ("consecutiveFailures", "lastFailedAt", "pausedUntil", "breaker", "working", "running", "recentFailures")},
            "queue": {k: q.get(k) for k in ("ready", "fleetOnline", "eligible", "blocked")}, "url": f"{API}/seats/{token}/standing"}


def network_fetch():
    """GET /health: what the control plane says about itself and the fleet."""
    h = api_json("/health", timeout=15)
    pay = h.get("payments") or {}
    return {"status": h.get("status"), "version": h.get("version"), "connectedDaemons": h.get("connectedDaemons"), "workingNow": h.get("workingNow"),
            "acceptedLastDay": h.get("acceptedLastDay"), "activeEnrollments": h.get("activeEnrollments"),
            "pending": {k[7:].lower(): h.get(k) for k in ("pendingVerification", "pendingAttestation", "pendingDeployment", "pendingDelivery", "pendingFeedback", "pendingOracle", "pendingFuzz", "pendingSites")},
            "services": {"verifier": h.get("verifierUp"), "publisher": h.get("publisherUp"), "deployer": h.get("deployerUp")}, "deployBreaker": h.get("deployBreaker"),
            "payments": {"enabled": pay.get("enabled"), "orders": pay.get("orders"), "lastPaidAt": pay.get("lastPaidAt"), "gasLow": (pay.get("gasWallet") or {}).get("low")}, "url": f"{API}/health"}


def fleet_fetch(token):
    """GET /contributors: every device's effort and outcome; our rank and a tokens-per-accepted benchmark."""
    d = api_json("/contributors", timeout=30)
    rows = []
    for c in d.get("contributors") or []:
        acc = c.get("accepted") or 0
        fresh = int(c.get("inputTokens") or 0) + int(c.get("outputTokens") or 0)
        out_t = int(c.get("outputTokens") or 0); cached = int(c.get("cachedInputTokens") or 0)
        # runtimes report input differently (Claude Code puts nearly everything under cached), so the comparable
        # per-accepted numbers are output tokens, all tokens, turns and minutes
        rows.append({"tokenId": c.get("tokenId"), "attempts": c.get("attempts") or 0, "accepted": acc, "rejected": c.get("rejected") or 0, "pending": c.get("pending") or 0,
                     "turns": c.get("turns") or 0, "fresh": fresh, "output": out_t, "cached": cached, "wallClockMs": int(c.get("wallClockMs") or 0),
                     "outPerAccepted": round(out_t / acc) if acc else None, "allPerAccepted": round((fresh + cached) / acc) if acc else None,
                     "turnsPerAccepted": round((c.get("turns") or 0) / acc, 1) if acc else None,
                     "minPerAccepted": round(int(c.get("wallClockMs") or 0) / acc / 60000, 1) if acc else None,
                     "acceptRate": round(acc / (acc + (c.get("rejected") or 0)) * 100) if acc + (c.get("rejected") or 0) else None})
    rows.sort(key=lambda r: -r["accepted"])
    ours = next((r for r in rows if str(r["tokenId"]) == str(token)), None)
    rank = next((i + 1 for i, r in enumerate(rows) if str(r["tokenId"]) == str(token)), None)
    peers = [r for r in rows if r["accepted"] >= 20]
    def med(k):
        v = sorted(r[k] for r in peers if r[k] is not None)
        return v[len(v) // 2] if v else None
    return {"receipts": d.get("receipts"), "contributors": len(rows), "peers": len(peers), "ours": ours, "rank": rank,
            "median": {k: med(k) for k in ("outPerAccepted", "allPerAccepted", "turnsPerAccepted", "minPerAccepted", "acceptRate")},
            "top": rows[:8], "url": f"{API}/contributors"}


def earnings_fetch(wallet):
    """GET /wallets/:address/earnings: launch token allocations to the seat's wallet."""
    if not wallet:
        return {"wallet": None, "items": [], "count": 0}
    d = api_json(f"/wallets/{wallet}/earnings?limit=200", timeout=30)
    items = []; by_chain = defaultdict(lambda: {"launches": 0, "tokens": 0})
    for e in d.get("earnings") or []:
        tok = e.get("token") or {}; dec = int(tok.get("decimals") or 18); ch = chain_of(e.get("chainId"))
        try:
            amt = int(e.get("amount") or 0) / 10 ** dec
        except (TypeError, ValueError):
            amt = None
        launch = memo("launch:" + str(e.get("launchId")), 6 * 3600, lambda: api_json(f"/launches/{e.get('launchId')}", timeout=20))
        items.append({"launchId": e.get("launchId"), "launchNumber": e.get("launchNumber"), "status": e.get("status"), "kind": e.get("kind"), "at": e.get("at"),
                      "chain": ch, "token": {"address": tok.get("address"), "name": tok.get("name"), "symbol": tok.get("symbol"), "decimals": dec}, "amount": amt,
                      "tokenUrl": f"{ch['scan']}/token/{tok.get('address')}?a={wallet}" if ch["scan"] and tok.get("address") else None,
                      "repoUrl": (launch or {}).get("sourceRepoUrl") if isinstance(launch, dict) else None,
                      "launchUrl": f"{API}/launches/{e.get('launchId')}"})
        by_chain[ch["name"]]["launches"] += 1; by_chain[ch["name"]]["tokens"] += 1
    return {"wallet": wallet, "count": len(items), "items": items, "byChain": dict(by_chain), "url": f"{API}/wallets/{wallet}/earnings"}


# ---------------------------------------------------------------- reputation registry: /feedback/batches + /jobs/:id/records
# What the chain points at for this seat. /feedback/batches is the fleet-wide feed of batches written to the
# reputation registry (each entry = one feedback about one submission, tagged with the seat); /jobs/:id/records
# lists the work records of a job and their on-chain status. Both replace the 8004scan lookups.
_records = {}  # job id -> (ts, value): the job's work records, from /jobs/:id/records


def registry_fetch(token, oldest_iso=None, pages=4):
    """Our seat's ERC-8004 registration (from /agents/by-token) plus every feedback-batch entry about this seat.
    Pages the feed backwards until it is older than our oldest task (or `pages` pages of 500)."""
    token = str(token)
    meta = api_json(f"/agents/by-token/{token}.json", timeout=20)
    reg = (meta.get("registrations") or [{}])[0]
    agent_id, chain = reg.get("agentId"), reg.get("chainId", 1)
    out = {"tokenId": token, "agentId": agent_id, "chainId": chain, "name": meta.get("name"), "active": meta.get("active"), "enrolled": meta.get("enrolled"),
           "agentRegistry": (reg.get("agentRegistry") or "").split(":")[-1] or None, "collection": reg.get("tokenContract"),
           "url": f"https://8004scan.io/agents/ethereum/{agent_id}" if agent_id else None, "docUrl": f"{API}/agents/by-token/{token}.json",
           "batches": {"sent": 0, "queued": 0, "submitted": 0, "failed": 0, "total": 0}, "entries": {"count": 0, "positive": 0, "byTag": {}},
           "bySub": {}, "byJob": {}, "lastSentAt": None, "lastTx": None, "workRegistry": None, "feedScanned": 0, "feedOldest": None}
    before = None; scanned = 0
    for _ in range(pages):
        q = f"/feedback/batches?limit=500" + (f"&before={before}" if before else "")
        d = api_json(q, timeout=40)
        batches = d.get("batches") or []
        if not batches:
            break
        for b in batches:
            scanned += 1
            out["workRegistry"] = out["workRegistry"] or b.get("workRegistry")
            mine = [e for e in b.get("entries") or [] if str(e.get("tokenId")) == token]
            if not mine:
                continue
            st = b.get("status") or "?"
            out["batches"][st if st in out["batches"] else "failed"] += 1; out["batches"]["total"] += 1
            row = {"batchId": b.get("id"), "jobId": b.get("jobId"), "status": st, "tx": b.get("txHash"), "txUrl": f"{ETHERSCAN}/tx/{b['txHash']}" if b.get("txHash") else None,
                   "sentAt": b.get("sentAt"), "createdAt": b.get("createdAt"), "documentHash": b.get("documentHash"), "failure": b.get("failure"),
                   "entries": [{"tag": e.get("tag1"), "policy": e.get("tag2"), "value": e.get("value"), "nodeKey": e.get("nodeKey"), "submissionHash": e.get("submissionHash")} for e in mine]}
            if st == "sent" and b.get("sentAt") and (out["lastSentAt"] or "") < b["sentAt"]:
                out["lastSentAt"], out["lastTx"] = b["sentAt"], b.get("txHash")
            for e in mine:
                out["entries"]["count"] += 1; out["entries"]["positive"] += 1 if e.get("value") == 1 else 0
                tag = e.get("tag1") or "?"; out["entries"]["byTag"][tag] = out["entries"]["byTag"].get(tag, 0) + 1
                h = (e.get("submissionHash") or "")[:12]
                if h and (h not in out["bySub"] or REVIEW_RANK.get(st, 0) >= REVIEW_RANK.get(out["bySub"][h]["status"], 0)):
                    out["bySub"][h] = dict(row, entry={"tag": e.get("tag1"), "policy": e.get("tag2"), "value": e.get("value"), "nodeKey": e.get("nodeKey")}, entries=None)
            out["byJob"].setdefault(b.get("jobId"), []).append({k: row[k] for k in ("batchId", "status", "tx", "txUrl", "sentAt", "documentHash")})
        before = batches[-1].get("createdAt"); out["feedOldest"] = before
        if oldest_iso and before and before < oldest_iso:
            break
    out["feedScanned"] = scanned
    out["lastTxUrl"] = f"{ETHERSCAN}/tx/{out['lastTx']}" if out.get("lastTx") else None
    return out


def records_fetch(job):
    """GET /jobs/:id/records: the job's work records and whether each reached the chain."""
    d = api_json(f"/jobs/{job}/records", timeout=20)
    recs = d.get("records") or []
    sent = [r for r in recs if r.get("status") == "sent" and r.get("txHash")]
    st = Counter(r.get("status") or "?" for r in recs)
    return {"job": job, "count": len(recs), "sent": st.get("sent", 0), "queued": st.get("queued", 0) + st.get("submitted", 0), "failed": sum(1 for r in recs if r.get("failure")),
            "tx": sent[-1]["txHash"] if sent else None, "txUrl": f"{ETHERSCAN}/tx/{sent[-1]['txHash']}" if sent else None, "hash": (sent[-1].get("hash") if sent else (recs[-1].get("hash") if recs else None)),
            "docUrl": f"{API}/work-records/{sent[-1]['hash']}.json" if sent else None, "registry": recs[0].get("registry") if recs else None,
            "final": bool(recs) and all(r.get("status") == "sent" for r in recs), "fetchedAt": time.time()}


def records_cached(job, budget):
    """Cache in front of records_fetch: 6 h once every record is sent, 10 min while any is still queued."""
    hit = _records.get(job)
    if hit and time.time() - hit[0] < (6 * 3600 if hit[1].get("final") else 600):
        return hit[1]
    if budget[0] <= 0:
        return hit[1] if hit else None
    budget[0] -= 1
    try:
        v = records_fetch(job)
    except Exception as e:
        v = dict(hit[1], error=str(e)[:120]) if hit else {"job": job, "count": 0, "error": str(e)[:120], "final": False}
    _records[job] = (time.time(), v)
    return v


def reason_from_server(m):
    """A one-line rejection / failure reason from our server-side attempt record."""
    if not m:
        return None
    if m.get("failureReason"):
        return f"failed — {m['failureReason']}"
    o = m.get("oracle") or {}; v = m.get("verdict") or {}
    if o.get("status") == "rejected":
        return "differed — " + (o.get("detail") or "answer did not match the finalized oracle result")
    if v.get("status") == "rejected":
        bits = [v.get("rejectionCode"), v.get("detail")] + [f"failed check: {c}" for c in (v.get("failedChecks") or [])[:3]]
        return "rejected — " + "; ".join(str(b) for b in bits if b)
    return None


def pass_api(d):
    """Seat record, standing, network, fleet, earnings, verdicts and reasons from api.imd.fun, registry and work records."""
    cfg = d.get("config") or {}; token = cfg.get("tokenId"); wallet = cfg.get("wallet")
    seat = memo("seat", 60, lambda: seat_fetch(token)) if token else {}
    d["seat"] = {k: v for k, v in seat.items() if k not in ("work", "reviewBySub")} if isinstance(seat, dict) else {"error": str(seat)}
    d["standing"] = memo("standing", 30, lambda: standing_fetch(token)) if token else {}
    d["network"] = memo("network", 60, network_fetch)
    d["fleet"] = memo("fleet", 900, lambda: fleet_fetch(token))
    d["earnings"] = memo("earnings", 900, lambda: earnings_fetch(wallet))
    work = seat.get("work") or {} if isinstance(seat, dict) else {}; reviews = seat.get("reviewBySub") or {} if isinstance(seat, dict) else {}
    budget = [6]  # new /jobs/:id/submissions fetches per collect(); the cache fills within a few refreshes
    # rejected / failed / pending first, then the most recent: those are the ones whose server record can still change or explain something
    prio = {"rejected": 0, "failed": 0, "pending": 1, "accepted": 2}
    order = sorted([t for t in d["tasks"] if t.get("submissionId")], key=lambda t: (prio.get((work.get(t["submissionId"]) or {}).get("status"), 1), -t.get("acceptedAt", 0)))
    for t in order:
        sid = t["submissionId"]; w = work.get(sid)
        if w:
            job = w.get("jobId") or t.get("job")
            t["job"] = job; t["jobUrl"] = f"{EXPLORER}/jobs/{job}"
            t["jobPublished"] = (w.get("jobState") in FINAL_JOB_STATES) or None
            if t["jobPublished"] is None and token:
                t["jobUrl"] = f"{EXPLORER}/agents/{token}?show=pending"; t["jobPublished"] = False
            t["verdict"] = {"accepted": "accepted", "rejected": "rejected", "failed": "failed"}.get(w.get("status"), "pending" if t.get("submittedAt") else None)
            t["seatWork"] = {k: w.get(k) for k in ("nodeKey", "role", "jobState", "launch", "submittedAt", "acceptedAt")}
            nk = w.get("nodeKey") or ""; role = w.get("role") or ""
            # nodeKey is the step key the job's author chose (a template like impl_tests_review names its steps
            # impl / tests / review / manifest); show the role with it unless the key already says it
            pretty = nk.replace("_", " ")
            if nk == "oracle_assess": t["kindLabel"] = "oracle"
            elif not nk: t["kindLabel"] = t.get("kindLabel") or t.get("kind")
            elif not role or nk == role or re.search(r"\b%s\b" % re.escape(role), pretty) or " " in pretty: t["kindLabel"] = pretty  # descriptive key
            else: t["kindLabel"] = f"{role} · {pretty}"  # short template key such as impl / manifest
            r = reviews.get(sid)
            if r:
                t["review"] = {"status": r.get("status"), "verdict": r.get("verdict"), "policy": r.get("policy"), "value": r.get("value"), "tx": r.get("txHash"), "sentAt": r.get("sentAt")}
                t["onchain"] = {"tx": r["txHash"], "txUrl": f"{ETHERSCAN}/tx/{r['txHash']}", "status": "sent", "at": r.get("sentAt")} if r.get("status") == "sent" and r.get("txHash") else None
        if not t.get("job"):
            continue
        sub = subs_cached(t["job"], token, budget)
        if not sub:
            continue
        mine = next((m for m in sub["mine"] if m["hash"] == sid), None) or (sub["mine"][-1] if sub["mine"] else None)
        t["server"] = {"attempt": mine, "field": sub.get("field"), "error": sub.get("error"), "fetchedAt": sub.get("fetchedAt")}
        if mine:
            if mine.get("accepted"): t["verdict"] = "accepted"
            elif mine.get("outcome") == "failed": t["verdict"] = "failed"
            elif (mine.get("oracle") or {}).get("status") == "rejected" or (mine.get("verdict") or {}).get("status") == "rejected": t["verdict"] = "rejected"
            srv = reason_from_server(mine)
            scraped = (t.get("reason") or {}).get("note")
            if t.get("verdict") in ("rejected", "failed") and srv and not scraped:
                t["reason"] = {"reason": srv, "source": "api", "state": t["verdict"]}
            o = mine.get("oracle") or {}
            if o.get("status") and not (t.get("explorer") or {}).get("word"):
                t.setdefault("explorer", {})["word"] = {"accepted": "agreed", "rejected": "differed"}.get(o["status"], o["status"])
    # the reputation registry: feedback batches about this seat (replaces 8004scan) and the work records per job
    oldest = min((t.get("acceptedAt") or 0 for t in d["tasks"] if t.get("acceptedAt")), default=None)
    oldest_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(oldest)) if oldest else None
    reg = memo("registry", 900, lambda: registry_fetch(token, oldest_iso)) if token else {}
    d["registry"] = {k: v for k, v in reg.items() if k not in ("bySub", "byJob")} if isinstance(reg, dict) else {"error": str(reg)}
    by_sub = reg.get("bySub") or {} if isinstance(reg, dict) else {}
    rbudget = [4]  # new /jobs/:id/records fetches per collect()
    for t in order:
        fb = by_sub.get(t["submissionId"])
        if fb:
            t["feedback"] = {k: fb.get(k) for k in ("status", "tx", "txUrl", "sentAt", "documentHash", "jobId")}; t["feedback"]["entry"] = fb.get("entry")
            if not t.get("onchain") and fb.get("status") == "sent" and fb.get("tx"):
                t["onchain"] = {"tx": fb["tx"], "txUrl": fb["txUrl"], "status": "sent", "at": fb.get("sentAt"), "source": "feedback"}
        if t.get("job") and t.get("verdict") in ("accepted", "rejected"):
            rec = records_cached(t["job"], rbudget)
            if rec:
                t["records"] = {k: rec.get(k) for k in ("count", "sent", "queued", "failed", "tx", "txUrl", "docUrl", "error")}
    d["totals"]["onchain"] = sum(1 for t in d["tasks"] if t.get("onchain"))
    d["totals"]["recordsSent"] = sum(1 for t in d["tasks"] if (t.get("records") or {}).get("sent"))
    d["totals"]["reviewsQueued"] = sum(1 for t in d["tasks"] if (t.get("review") or {}).get("status") in ("queued", "submitted"))
    by_id = {t["id"]: t for t in d["tasks"]}
    for r in d.get("running") or []:
        src = by_id.get(r["id"]) or {}
        r["kindLabel"] = src.get("kindLabel") or r.get("kindLabel"); r["jobUrl"] = src.get("jobUrl") or r.get("jobUrl")
    acc = defaultdict(Counter)
    for t in d["tasks"]:
        if t.get("verdict") in ("accepted", "rejected"):
            acc["all"][t["verdict"]] += 1
            if t.get("tier"): acc["tier:" + t["tier"]][t["verdict"]] += 1
            if t.get("model"): acc["model:" + t["model"]][t["verdict"]] += 1
    d["acceptance"] = {k: dict(v) for k, v in acc.items()}
    d["subsCache"] = {"jobs": len(_subs), "budgetLeft": budget[0], "records": len(_records), "recordsBudgetLeft": rbudget[0]}
    return d


# ================================================================ the swarm: fleet, events, what the network is doing, our crew
import sqlite3
SWARM_DB = state("swarm.sqlite")
_explorer_agents = {}  # tokenId -> (ts, explorer /api/agents/:id)


def swarm_db():
    c = sqlite3.connect(SWARM_DB)
    c.execute("CREATE TABLE IF NOT EXISTS samples (ts REAL PRIMARY KEY, online INT, working INT, enrolled INT, acceptedDay INT, jobsDay INT, oraclesDay INT, tokens INT)")
    c.execute("CREATE TABLE IF NOT EXISTS events (at TEXT, kind TEXT, tokenId TEXT, state TEXT, step TEXT, role TEXT, jobId TEXT, objective TEXT, PRIMARY KEY (at, kind, tokenId))")
    return c


def swarm_fetch():
    """GET /swarm (10 s server cache): health, counts, every seat's live flags, the last 60 events. Samples and events
    are accumulated in swarm.sqlite so the tab can show a day of online/working and more than 60 events."""
    s = api_json("/swarm", timeout=30)
    h = s.get("health") or {}; counts = s.get("counts") or {}; owners = s.get("owners") or []
    seats = {}
    for k, v in (s.get("seats") or {}).items():
        tid = str(v.get("tokenId", k))
        try:
            owner = owners[int(tid)] if int(tid) < len(owners) else None
        except (ValueError, TypeError):
            owner = None
        seats[tid] = {"tokenId": tid, "agentId": v.get("agentId"), "accepted": v.get("accepted") or 0, "failed": v.get("failed") or 0, "last": v.get("last"),
                      "working": bool(v.get("working")), "queued": v.get("queued") or 0, "owner": owner}
    events = s.get("events") or []
    now = time.time(); c = swarm_db()
    last = c.execute("SELECT MAX(ts) FROM samples").fetchone()[0] or 0
    if now - last >= 60:
        c.execute("INSERT OR REPLACE INTO samples VALUES (?,?,?,?,?,?,?,?)", (now, h.get("agentsOnline"), h.get("workingNow"), h.get("seatsEnrolled"), h.get("acceptedLastDay"),
                                                                             h.get("jobsDoneLastDay"), h.get("oraclesDoneLastDay"), counts.get("inferenceTokens")))
    for e in events:
        c.execute("INSERT OR IGNORE INTO events VALUES (?,?,?,?,?,?,?,?)", (e.get("at"), e.get("kind"), str(e.get("tokenId")), e.get("state"), e.get("step"), e.get("role"), e.get("jobId"), (e.get("objective") or "")[:200]))
    c.execute("DELETE FROM samples WHERE ts < ?", (now - 8 * 86400,)); c.execute("DELETE FROM events WHERE at < ?", (time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now - 3 * 86400)),))
    c.commit()
    # 5-minute buckets of the last 24 h
    samples = []
    for row in c.execute("SELECT (CAST(ts/300 AS INT))*300 AS b, MAX(online), MAX(working), MAX(enrolled) FROM samples WHERE ts >= ? GROUP BY b ORDER BY b", (now - 86400,)):
        samples.append({"ts": row[0], "online": row[1], "working": row[2], "enrolled": row[3]})
    ev_rows = [{"at": r[0], "kind": r[1], "tokenId": r[2], "state": r[3], "step": r[4], "role": r[5], "jobId": r[6], "objective": r[7]}
               for r in c.execute("SELECT * FROM events ORDER BY at DESC LIMIT 200")]
    n_ev = c.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    c.close()
    return {"at": s.get("at"), "health": h, "counts": counts, "seats": seats, "events": ev_rows, "eventsStored": n_ev, "samples": samples}


def workers_fetch():
    """GET /workers: every connected daemon — runtime, premium model, platform, version — keyed by seat."""
    d = api_json("/workers", timeout=30)
    by = {}; fleet = {"runtime": Counter(), "model": Counter(), "os": Counter(), "daemon": Counter(), "concurrency": Counter(), "paused": 0}
    for w in d.get("workers") or []:
        tid = str((w.get("seat") or {}).get("tokenId") or "")
        rt = (w.get("runtimes") or [{}])[0]; pm = rt.get("premiumModel") or {}
        entry = {"runtime": rt.get("id"), "runtimeVersion": rt.get("version"), "model": pm.get("model"), "effort": pm.get("effort"), "os": (w.get("platform") or {}).get("os"),
                 "daemonVersion": w.get("daemonVersion"), "working": w.get("working"), "paused": w.get("paused"), "connectedAt": w.get("connectedAt"),
                 "lastHeartbeatAt": w.get("lastHeartbeatAt"), "skills": len(w.get("skills") or []), "maxConcurrency": w.get("maxConcurrency"), "profiles": w.get("profiles")}
        if tid:
            by[tid] = entry
        fleet["runtime"][rt.get("id") or "none"] += 1; fleet["model"][pm.get("model") or "no premium"] += 1; fleet["os"][entry["os"] or "?"] += 1
        fleet["daemon"][w.get("daemonVersion") or "?"] += 1; fleet["concurrency"][str(w.get("maxConcurrency") or "?")] += 1; fleet["paused"] += bool(w.get("paused"))
    fleet = {k: (dict(v.most_common(8)) if isinstance(v, Counter) else v) for k, v in fleet.items()}
    fleet["connected"] = len(d.get("workers") or [])
    return {"by": by, "fleet": fleet}


def recent_fetch():
    """What the network is working on: recent jobs, oracle questions, launches."""
    out = {}
    j = api_json("/jobs?limit=40", timeout=30)
    out["jobs"] = [{"id": x.get("id"), "state": x.get("state"), "template": x.get("template"), "objective": (x.get("objective") or "")[:240], "createdAt": x.get("createdAt"),
                    "updatedAt": x.get("updatedAt"), "blockedReason": x.get("blockedReason")} for x in j.get("jobs") or []]
    o = api_json("/oracle/requests?limit=12", timeout=30)
    out["oracle"] = [{"id": x.get("id"), "status": x.get("status"), "question": (x.get("question") or "")[:240], "chainId": x.get("chainId"), "answerType": x.get("answerType"),
                      "jobId": x.get("jobId"), "attestedAt": x.get("attestedAt"), "createdAt": x.get("createdAt")} for x in o.get("requests") or []]
    out["attester"] = o.get("attester")
    return out


def sites_fetch():
    """GET /sites (newest 100) joined with /publications?type=sites for the job title and repository."""
    sites = api_json("/sites", timeout=30)
    sites = sites.get("sites") if isinstance(sites, dict) else sites
    titles = {}
    try:
        pub = api_json("/publications?type=sites&pageSize=100", timeout=30)
        for it in pub.get("items") or []:
            for x in it.get("sites") or []:
                titles[x.get("id")] = {"title": (it.get("title") or "").split("\n")[0][:140], "repoUrl": x.get("repoUrl")}
    except Exception:
        pass
    out = []
    for x in sites or []:
        t = titles.get(x.get("id")) or {}
        out.append({"id": x.get("id"), "jobId": x.get("jobId"), "label": x.get("label"), "url": x.get("url"), "ensName": x.get("ensName"), "status": x.get("status"),
                    "bytes": x.get("bytes"), "createdAt": x.get("createdAt"), "namedAt": x.get("namedAt"), "failure": x.get("failure"), "txHash": x.get("txHash"),
                    "superseded": bool(x.get("supersededBy")), "title": t.get("title") or "", "repoUrl": t.get("repoUrl")})
    return {"sites": out}


def publications_fetch():
    """GET /publications?type=all: every project the network shipped — contract launches, sites, research reports —
    with the job title; launch numbers, repositories and parked reasons joined from /launches."""
    items = []; page = 1
    while page <= 10:
        d = api_json(f"/publications?type=all&pageSize=100&page={page}", timeout=30)
        items += d.get("items") or []
        if page >= (d.get("totalPages") or 1):
            break
        page += 1
    launches = {}
    try:
        for l in api_json("/launches?limit=500", timeout=30).get("launches") or []:
            launches[l.get("id")] = l
    except Exception:
        pass
    out = []
    for it in items:
        pid = it.get("id") or ""; kind, _, ref = pid.partition(":")
        contracts = []
        for c in it.get("contracts") or []:
            l = launches.get(c.get("id")) or {}
            arts = [{"name": a.get("name"), "role": a.get("role"), "address": a.get("address"), "txHash": a.get("txHash")} for a in (c.get("artifacts") or [])]
            tok = next((a for a in arts if a["role"] == "token"), None)
            contracts.append({"id": c.get("id"), "launchNumber": l.get("launchNumber"), "kind": c.get("kind"), "status": c.get("status"), "chain": chain_of(c.get("chainId")),
                              "artifacts": arts, "token": tok, "repoUrl": l.get("sourceRepoUrl"), "parkedReason": l.get("parkedReason"), "createdAt": c.get("createdAt")})
        sites = [{"id": x.get("id"), "jobId": x.get("jobId"), "label": x.get("label"), "ensName": x.get("ensName"), "url": f"https://{x.get('ensName')}.limo" if x.get("ensName") else None,
                  "status": x.get("status"), "failure": x.get("failure"), "cid": x.get("cid"), "namedAt": x.get("namedAt"), "createdAt": x.get("createdAt"), "repoUrl": x.get("repoUrl"),
                  "superseded": bool(x.get("supersededBy"))} for x in it.get("sites") or []]
        research = [{"jobId": r.get("jobId"), "repoUrl": r.get("repoUrl"), "publishedAt": r.get("publishedAt"), "pullRequestUrl": r.get("pullRequestUrl")} for r in it.get("research") or []]
        title = (it.get("title") or "").strip()
        # the first line is sometimes a header like "Original request:" — take the first line that says something
        lines = [l.strip() for l in title.split("\n") if l.strip()]
        head = next((l for l in lines if len(l) > 24 and not l.endswith(":")), lines[0] if lines else "")
        out.append({"id": pid, "refKind": kind, "ref": ref, "title": head[:220], "titleFull": title[:600], "types": it.get("types") or [], "publishedAt": it.get("publishedAt"),
                    "contracts": contracts, "sites": sites, "research": research, "release": it.get("release"),
                    "jobUrl": f"{EXPLORER}/jobs/{ref}" if kind == "job" else (f"{EXPLORER}/jobs/{sites[0]['jobId']}" if sites and sites[0].get("jobId") else None)})
    out.sort(key=lambda x: x.get("publishedAt") or "", reverse=True)
    return {"items": out, "count": len(out), "launchesKnown": len(launches)}


def explorer_agent(tid, budget):
    hit = _explorer_agents.get(tid)
    if hit and time.time() - hit[0] < 3600:
        return hit[1]
    if budget[0] <= 0:
        return hit[1] if hit else None
    budget[0] -= 1
    try:
        v = json.loads(http_get(f"{EXPLORER}/api/agents/{tid}", timeout=10))
    except Exception as e:
        v = {"error": str(e)[:80]}
    _explorer_agents[tid] = (time.time(), v)
    return v


def crew_build(token, seat, workers_by, budget):
    """Our collaborators (seats we shared jobs with), enriched with the explorer readout and with what the cached
    /jobs/:id/submissions say about how those shared jobs went: agreed/differed on oracles, who reviewed whom."""
    collab = {str(c.get("tokenId")): {"tokenId": str(c.get("tokenId")), "agentId": c.get("agentId"), "sharedJobs": c.get("sharedJobs") or 0} for c in (seat.get("collabList") or [])}
    stats = defaultdict(lambda: Counter())
    for job, (ts, sub) in list(_subs.items()):
        allm = sub.get("all") or []
        ours = [m for m in allm if str(m.get("tokenId")) == str(token)]
        if not ours:
            continue
        o = ours[-1]
        for m in allm:
            tid = str(m.get("tokenId"))
            if tid == str(token):
                continue
            st = stats[tid]; st["seen"] += 1
            if o.get("nodeKey") == "oracle_assess" and m.get("nodeKey") == "oracle_assess" and o.get("final") and m.get("final"):
                st["agreed" if bool(m.get("accepted")) == bool(o.get("accepted")) else "differed"] += 1
            if m.get("role") == "review" and o.get("role") != "review": st["reviewedUs"] += 1
            if o.get("role") == "review" and m.get("role") != "review": st["weReviewed"] += 1
            if m.get("model"): st["model:" + m["model"]] += 1
    rows = sorted(collab.values(), key=lambda c: -c["sharedJobs"])
    for i, c in enumerate(rows):
        w = workers_by.get(c["tokenId"]) or {}
        c["runtime"] = w.get("runtime"); c["model"] = w.get("model"); c["online"] = bool(w)
        st = stats.get(c["tokenId"]) or Counter()
        c["seen"] = st["seen"]; c["agreed"] = st["agreed"]; c["differed"] = st["differed"]; c["reviewedUs"] = st["reviewedUs"]; c["weReviewed"] = st["weReviewed"]
        models = [(k[6:], v) for k, v in st.items() if k.startswith("model:")]
        c["seenModel"] = max(models, key=lambda kv: kv[1])[0] if models else None
        if i < 16:
            a = explorer_agent(c["tokenId"], budget) or {}
            c["ownerName"] = a.get("ownerName"); c["owner"] = a.get("owner"); c["accepted"] = a.get("accepted"); c["attempts"] = a.get("attempts"); c["lastAcceptedAt"] = a.get("lastAcceptedAt")
    return rows


def pass_swarm(d):
    """The swarm: fleet, workers, recent jobs, publications, crew."""
    cfg = d.get("config") or {}; token = str(cfg.get("tokenId") or "")
    sw = memo("swarm", 30, swarm_fetch)
    wk = memo("workers", 120, workers_fetch)
    rc = memo("recent", 120, recent_fetch)
    pb = memo("publications", 300, publications_fetch)
    seat = _slow.get("seat", (0, {}))[1] if isinstance(_slow.get("seat", (0, {}))[1], dict) else {}
    budget = [5]
    if not isinstance(sw, dict) or "seats" not in sw:
        d["swarm"] = {"error": (sw or {}).get("error") if isinstance(sw, dict) else str(sw)}
        return d
    by = (wk.get("by") if isinstance(wk, dict) else None) or {}
    crew = crew_build(token, seat, by, budget) if seat else []
    crew_by = {c["tokenId"]: c for c in crew}
    seats = []
    for tid, s in sw["seats"].items():
        w = by.get(tid) or {}; c = crew_by.get(tid)
        seats.append({**s, "online": bool(w) or tid in sw["seats"] and s.get("working"), "runtime": w.get("runtime"), "model": w.get("model"), "os": w.get("os"),
                      "daemonVersion": w.get("daemonVersion"), "paused": w.get("paused"), "connectedAt": w.get("connectedAt"),
                      "sharedJobs": c["sharedJobs"] if c else 0, "agreed": c["agreed"] if c else 0, "differed": c["differed"] if c else 0, "ownerName": (c or {}).get("ownerName")})
    for tid, w in by.items():  # connected daemons the /swarm seat list does not carry
        if tid and tid not in sw["seats"]:
            seats.append({"tokenId": tid, "agentId": None, "accepted": 0, "failed": 0, "last": None, "working": bool(w.get("working")), "queued": 0, "owner": None, "online": True,
                          "runtime": w.get("runtime"), "model": w.get("model"), "os": w.get("os"), "daemonVersion": w.get("daemonVersion"), "paused": w.get("paused"),
                          "connectedAt": w.get("connectedAt"), "sharedJobs": 0, "agreed": 0, "differed": 0, "ownerName": None})
    d["swarm"] = {"at": sw.get("at"), "health": sw.get("health"), "counts": sw.get("counts"), "seats": seats, "events": sw.get("events"), "eventsStored": sw.get("eventsStored"),
                  "samples": sw.get("samples"), "fleet": (wk.get("fleet") if isinstance(wk, dict) else {"error": str(wk)}), "jobs": (rc or {}).get("jobs") if isinstance(rc, dict) else [],
                  "oracle": (rc or {}).get("oracle") if isinstance(rc, dict) else [],
                  "publications": (pb.get("items") if isinstance(pb, dict) else []) or [], "publicationsError": pb.get("error") if isinstance(pb, dict) else str(pb),
                  "crew": crew, "ours": token, "errors": [x.get("error") for x in (sw, wk, rc, pb) if isinstance(x, dict) and x.get("error")]}
    return d


# ================================================================ worker releases & installation (Settings → worker updates)
WORKER_REPO = "Identity-md/worker"
VERSIONS_DIR = state("worker-versions")
UPDATES_LOG = state("updates.json")


def worker_root():
    p = os.path.realpath(imd_bin())  # …/bin/imd → symlink to …/node_modules/@identitymd/worker/dist/cli.js
    return os.path.dirname(os.path.dirname(p)) if p.endswith("cli.js") else os.path.join(os.path.dirname(os.path.dirname(p)), "lib", "node_modules", "@identitymd", "worker")


def tag_build(tag):
    """worker-v0.1.0-61d04d62e2ac → 0.1.0+61d04d62 (what the daemon calls itself)."""
    m = re.match(r"worker-v(\d+\.\d+\.\d+)-([0-9a-f]{8})", tag or "")
    return f"{m.group(1)}+{m.group(2)}" if m else tag


def releases_fetch():
    """GitHub releases of the worker (public API, 60 calls/h unauthenticated — memoised 15 min)."""
    req = urllib.request.Request(f"https://api.github.com/repos/{WORKER_REPO}/releases?per_page=12", headers={"User-Agent": "imd-panel/1", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        rel = json.loads(r.read().decode())
    out = []
    for x in rel:
        assets = {a.get("name"): a.get("browser_download_url") for a in x.get("assets") or []}
        out.append({"tag": x.get("tag_name"), "build": tag_build(x.get("tag_name")), "publishedAt": x.get("published_at"), "prerelease": x.get("prerelease"),
                    "notes": (x.get("body") or "").strip()[:1500], "url": x.get("html_url"), "tgz": assets.get("identitymd-worker.tgz"), "sums": assets.get("SHA256SUMS")})
    out.sort(key=lambda r: r["publishedAt"] or "", reverse=True)
    return {"releases": out, "fetchedAt": time.time()}


def worker_install():
    root = worker_root()
    out = {"root": root, "build": None, "commit": None, "installedAt": None}
    try:
        with open(os.path.join(root, "build.json")) as fh:
            b = json.load(fh)
        out["build"] = b.get("daemonVersion"); out["commit"] = b.get("sourceCommit"); out["installedAt"] = os.path.getmtime(os.path.join(root, "build.json"))
    except (OSError, ValueError) as e:
        out["error"] = str(e)[:120]
    cache = []
    if os.path.isdir(VERSIONS_DIR):
        for f in sorted(os.listdir(VERSIONS_DIR)):
            if f.endswith(".tgz"):
                p = os.path.join(VERSIONS_DIR, f); cache.append({"tag": f[:-4], "build": tag_build(f[:-4]), "bytes": os.path.getsize(p), "at": os.path.getmtime(p)})
    out["cache"] = cache
    return out


def updates_history(rows):
    """The worker's own 'updated A → B' journal lines plus the dashboard's manual update / rollback log."""
    hist = []
    for ts, msg in rows:
        m = RE_UPDATED.match(msg)
        if m:
            hist.append({"ts": ts, "from": m.group(1), "to": m.group(2), "by": "auto-update"})
            continue
        m = RE_UPDATE_FAILED.match(msg)
        if m:  # the daemon refused a release (bad archive, unexpected file…) and stayed on its build; one row per distinct reason per hour
            note = m.group(1)[:160]
            if not any(h.get("action") == "failed" and h.get("note") == note and abs(h["ts"] - ts) < 3600 for h in hist):
                hist.append({"ts": ts, "by": "auto-update", "action": "failed", "note": note})
    try:
        with open(UPDATES_LOG) as fh:
            hist += json.load(fh)
    except (OSError, ValueError):
        pass
    hist.sort(key=lambda h: h.get("ts") or 0, reverse=True)
    return hist[:20]


def pass_updates(d):
    """Installed worker build, GitHub releases, update history."""
    inst = memo("install", 60, worker_install)
    rel = memo("releases", 900, releases_fetch)
    releases = rel.get("releases") if isinstance(rel, dict) else None
    latest = releases[0] if releases else None
    d["updates"] = {"installed": inst, "releases": releases or [], "releasesError": rel.get("error") if isinstance(rel, dict) else str(rel),
                    "latest": latest, "available": bool(latest and inst.get("build") and latest["build"] != inst["build"]),
                    "autoUpdate": ((d.get("effective") or {}).get("unit") or {}).get("autoUpdate"),
                    "history": updates_history(_journal_rows_cache[0] or [])}
    return d


# ================================================================ protocol additions of 2026-09-24: workflows, research panels, fuzz campaigns,
# delivered results, the three services, per-seat fleet records (imd.fun/docs, control plane 0.1.0+f986ffe7)
JOB_FINAL = ("completed", "cancelled", "blocked", "failed", "superseded")
_jobs = {}       # job id -> (ts, value)   /jobs/:id
_workflows = {}  # workflow id -> (ts, value)   /workflows/:id
_results = {}    # job id -> (ts, value)   /jobs/:id/result
_panels = {}     # job id -> (ts, value)   /jobs/:id/panel or /jobs/:id/fuzz
RE_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
NODE_LABELS = {"panel": "research panel", "campaign": "fuzz campaign", "oracle_assess": "oracle"}


def _cached(store, key, budget, fetch, final_ttl=6 * 3600, live_ttl=300):
    """Generic cache: keep a final value for hours, a live one for minutes; budget = fetches still allowed in this collect()."""
    hit = store.get(key)
    if hit and time.time() - hit[0] < (final_ttl if hit[1].get("final") else live_ttl):
        return hit[1]
    if budget[0] <= 0:
        return hit[1] if hit else None
    budget[0] -= 1
    try:
        v = fetch(key)
    except Exception as e:
        v = dict(hit[1], error=str(e)[:120]) if hit else {"error": str(e)[:120], "final": False}
    store[key] = (time.time(), v)
    return v


def job_fetch(job):
    """GET /jobs/:id: state, template, the workflow it belongs to, delivery (repo / PR / media), site, launch and our step's node."""
    j = api_json(f"/jobs/{job}", timeout=20)
    wf = j.get("workflow") or {}; dv = j.get("delivery") or {}; site = j.get("site") or {}; la = j.get("launch") or {}
    nodes = [{"key": n.get("key"), "role": n.get("role"), "state": n.get("state"), "attempt": n.get("attempt"), "failureReason": n.get("failureReason"),
              "seat": str((n.get("seat") or {}).get("tokenId") or "") if isinstance(n.get("seat"), dict) else (str(n.get("seat")) if n.get("seat") else None),
              "verdict": (n.get("verdict") or {}).get("status") if isinstance(n.get("verdict"), dict) else n.get("verdict")} for n in j.get("nodes") or []]
    return {"job": job, "state": j.get("state"), "template": j.get("template"), "objective": (j.get("objective") or "")[:300], "createdAt": j.get("createdAt"), "updatedAt": j.get("updatedAt"),
            "blockedReason": j.get("blockedReason"), "deliver": j.get("deliver"), "host": j.get("host"),
            "workflowId": wf.get("id"), "workflowObjective": (wf.get("objective") or "")[:300],
            "delivery": {k: dv.get(k) for k in ("repoUrl", "pullRequestUrl", "commit", "deliveredAt", "media", "failure")} if dv else None,
            "site": {k: site.get(k) for k in ("id", "url", "status", "label", "ensName", "cid", "kind")} if site else None,
            "launch": {k: la.get(k) for k in ("requested", "kind", "id", "status", "chainId")} if la and (la.get("requested") or la.get("id")) else None,
            "nodes": nodes, "final": j.get("state") in JOB_FINAL, "url": f"{API}/jobs/{job}", "fetchedAt": time.time()}


def workflow_fetch(wid):
    """GET /workflows/:id: contracts → deployment → frontend → publication as one record."""
    w = api_json(f"/workflows/{wid}", timeout=20)
    stage = lambda k: ({kk: (w.get(k) or {}).get(kk) for kk in ("id", "state", "failure", "repoUrl", "commit")} if w.get(k) else None)
    la = w.get("launch") or {}; site = w.get("site") or {}; fp = w.get("frontendPlan") or {}
    stages = [("contracts", (w.get("contracts") or {}).get("state")), ("launch", la.get("status")), ("frontend", (w.get("frontend") or {}).get("state")), ("site", site.get("status"))]
    return {"id": wid, "status": w.get("status"), "failure": w.get("failure"), "chainId": w.get("chainId"), "chain": chain_of(w.get("chainId"))["name"] if w.get("chainId") else None,
            "objective": (w.get("objective") or "")[:400], "waitingForHosting": w.get("waitingForHosting"), "createdAt": w.get("createdAt"), "updatedAt": w.get("updatedAt"),
            "contracts": stage("contracts"), "frontend": stage("frontend"), "frontendSkill": fp.get("skill"),
            "launch": {"id": la.get("id"), "status": la.get("status")} if la else None,
            "site": {k: site.get(k) for k in ("status", "ensName", "cid", "failure")} if site else None,
            "siteUrl": f"https://{site['ensName']}.limo" if site.get("ensName") else None,
            "stages": [{"name": n, "state": s} for n, s in stages if s], "final": w.get("status") in JOB_FINAL, "url": f"{API}/workflows/{wid}", "fetchedAt": time.time()}


def result_fetch(job):
    """GET /jobs/:id/result: the accepted source bundles, named output files (media, reports) and where they were delivered."""
    r = api_json(f"/jobs/{job}/result", timeout=20)
    files = [{"name": f.get("name"), "path": f.get("path"), "mediaType": f.get("mediaType"), "bytes": f.get("bytes"), "hash": f.get("hash"),
              "url": (API + f["url"]) if (f.get("url") or "").startswith("/") else f.get("url")} for f in r.get("files") or []]
    src = [{"node": s.get("node"), "evaluation": s.get("evaluation"), "profile": s.get("profile"), "url": s.get("url"), "hash": (s.get("hash") or "")[:12]} for s in r.get("source") or []]
    dv = r.get("delivery") or {}
    return {"job": job, "state": r.get("state"), "complete": r.get("complete"), "files": files, "source": src,
            "delivery": {k: dv.get(k) for k in ("requested", "mode", "repoUrl", "pullRequestUrl", "commit", "deliveredAt", "failure", "ipfs", "cid")} if dv else None,
            "launch": r.get("launch") if (r.get("launch") or {}).get("requested") else None, "final": bool(r.get("complete")), "url": f"{API}/jobs/{job}/result", "fetchedAt": time.time()}


def panel_fetch(job, token=None):
    """GET /jobs/:id/panel: a research panel — N answers wanted, quorum of matching ones; ours picked out by seat."""
    p = api_json(f"/jobs/{job}/panel", timeout=20)
    answers = p.get("answers") or []
    mine = next((a for a in answers if str((a.get("seat") or {}).get("tokenId")) == str(token)), None)
    u = (mine or {}).get("usage") or {}; rt = (mine or {}).get("runtime") or {}
    return {"kind": "panel", "job": job, "state": p.get("state"), "wanted": p.get("wanted"), "quorum": p.get("quorum"), "answers": len(answers), "vendors": p.get("vendors"),
            "seats": [str((a.get("seat") or {}).get("tokenId")) for a in answers],
            "ours": {"turns": u.get("turns"), "output": u.get("outputTokens"), "wallClockMs": u.get("wallClockMs"), "citations": len(mine.get("citations") or []) if isinstance(mine.get("citations"), list) else mine.get("citations"),
                     "finishedAt": mine.get("finishedAt"), "runtime": rt.get("id"), "model": rt.get("model"), "answer": (mine.get("answer") or "")[:1200]} if mine else None,
            "final": p.get("state") in ("accepted", "rejected", "failed", "cancelled", "blocked"), "url": f"{API}/jobs/{job}/panel", "fetchedAt": time.time()}


def fuzz_fetch(job, token=None):
    """GET /jobs/:id/fuzz: a fuzz campaign — runs, confirmed findings, per-seat results; ours picked out by seat."""
    f = api_json(f"/jobs/{job}/fuzz", timeout=20)
    res = f.get("results") or []
    mine = [r for r in res if str((r.get("seat") or {}).get("tokenId")) == str(token)]
    last = mine[-1] if mine else None
    return {"kind": "fuzz", "job": job, "state": f.get("state"), "runs": f.get("runs"), "confirmed": f.get("confirmed"), "results": len(res),
            "outcomes": dict(Counter(r.get("outcome") or "?" for r in res)),
            "ours": {"outcome": last.get("outcome"), "detail": (last.get("detail") or "")[:400], "property": last.get("property"), "runs": last.get("runs"),
                     "verdictStatus": last.get("verdictStatus"), "verdictDetail": (last.get("verdictDetail") or "")[:300], "reportedAt": last.get("reportedAt"), "results": len(mine)} if last else None,
            "final": f.get("state") in JOB_FINAL, "url": f"{API}/jobs/{job}/fuzz", "fetchedAt": time.time()}


def services_fetch():
    """GET /services + GET /version: verifier, publisher and deployer with their builds, and the control plane's commit."""
    out = {"services": [], "build": None}
    s = api_json("/services", timeout=15)
    for x in s.get("services") or []:
        out["services"].append({"kind": x.get("kind"), "version": x.get("version"), "up": x.get("up"), "lastSeenAt": x.get("lastSeenAt"), "claims": x.get("claims"), "key": x.get("key")})
    try:
        v = api_json("/version", timeout=10)
        out["build"] = {"commit": (v.get("commit") or "")[:12], "branch": v.get("branch"), "deployedAt": v.get("deployedAt"), "protocolVersion": v.get("protocolVersion"),
                        "features": sorted(k for k, on in (v.get("features") or {}).items() if on)}
    except Exception as e:
        out["buildError"] = str(e)[:120]
    out["fetchedAt"] = time.time()
    return out


def seat_records_fetch(token):
    """GET /seats/records: every seat's outcome totals — our rank by accepted, the fleet's totals and acceptance."""
    d = api_json("/seats/records", timeout=30)
    rows = d.get("seats") or []
    for r in rows:
        dec = (r.get("accepted") or 0) + (r.get("rejected") or 0) + (r.get("failed") or 0)
        r["acceptRate"] = round((r.get("accepted") or 0) / dec * 100) if dec else None
    rows.sort(key=lambda r: -(r.get("accepted") or 0))
    ours = next((r for r in rows if str(r.get("tokenId")) == str(token)), None)
    rank = next((i + 1 for i, r in enumerate(rows) if str(r.get("tokenId")) == str(token)), None)
    tot = {k: sum(int(r.get(k) or 0) for r in rows) for k in ("attempts", "accepted", "rejected", "failed", "pending")}
    dec = tot["accepted"] + tot["rejected"] + tot["failed"]
    day_ago = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 86400))
    active = sum(1 for r in rows if (r.get("lastWorkedAt") or "") >= day_ago)
    rates = sorted(r["acceptRate"] for r in rows if r["acceptRate"] is not None and (r.get("accepted") or 0) >= 20)
    return {"count": len(rows), "ours": ours, "rank": rank, "totals": tot, "acceptRate": round(tot["accepted"] / dec * 100) if dec else None,
            "medianAcceptRate": rates[len(rates) // 2] if rates else None, "activeDay": active, "top": rows[:8], "url": f"{API}/seats/records", "fetchedAt": time.time()}


def kind_label_for(nk, role, current):
    if nk in NODE_LABELS:
        return NODE_LABELS[nk]
    return current


def pass_protocol(d):
    """Workflows, research panels, fuzz campaigns, delivered results, services, seat records."""
    cfg = d.get("config") or {}; token = str(cfg.get("tokenId") or "")
    net = d.get("network") if isinstance(d.get("network"), dict) else None
    sv = memo("services", 120, services_fetch)
    if net is not None:
        net["servicesDetail"] = sv.get("services") if isinstance(sv, dict) else None
        net["build"] = sv.get("build") if isinstance(sv, dict) else None
        net["servicesError"] = sv.get("error") if isinstance(sv, dict) else str(sv)
    rec = memo("seatRecords", 900, lambda: seat_records_fetch(token)) if token else None
    if isinstance(d.get("fleet"), dict):
        d["fleet"]["seats"] = {k: v for k, v in rec.items() if k != "top"} if isinstance(rec, dict) else {"error": str(rec)}
        d["fleet"]["seats"]["top"] = (rec or {}).get("top") if isinstance(rec, dict) else None
    jb = [4]; wb = [3]; rb = [3]; pb = [3]
    for t in d.get("tasks") or []:
        job = t.get("job")
        if not job:
            m = RE_UUID.search(t.get("jobUrl") or "")
            job = m.group(0) if m else None
        nk = (t.get("seatWork") or {}).get("nodeKey") or ""
        if not job or nk == "oracle_assess" or (t.get("kindLabel") == "oracle" and nk == ""):
            continue  # oracle answers have no workflow, delivery or result files; nothing to fetch
        t["kindLabel"] = kind_label_for(nk, (t.get("seatWork") or {}).get("role"), t.get("kindLabel"))
        ji = _cached(_jobs, job, jb, job_fetch)
        if not ji or (ji.get("error") and not ji.get("state")):
            continue
        t["job"] = job
        node = next((n for n in ji.get("nodes") or [] if n.get("key") == nk), None) if nk else None
        if not node and len(ji.get("nodes") or []) == 1:
            node = ji["nodes"][0]
        t["jobInfo"] = {"state": ji.get("state"), "template": ji.get("template"), "blockedReason": ji.get("blockedReason"), "delivery": ji.get("delivery"), "site": ji.get("site"),
                        "launch": ji.get("launch"), "node": node, "nodes": len(ji.get("nodes") or []), "url": ji.get("url"),
                        # who the network's record credits for our step — another seat when we released it or lost the attempt
                        "takenBy": (node or {}).get("seat") if node and node.get("seat") and str(node.get("seat")) != token and node.get("state") in ("accepted", "completed") else None}
        if not nk and node and node.get("key"):
            t["kindLabel"] = kind_label_for(node["key"], node.get("role"), t.get("kindLabel"))
        if ji.get("workflowId"):
            wf = _cached(_workflows, ji["workflowId"], wb, workflow_fetch)
            stage = "frontend" if wf and (wf.get("frontend") or {}).get("id") == job else "contracts" if wf and (wf.get("contracts") or {}).get("id") == job else None
            t["workflow"] = dict(wf or {"id": ji["workflowId"], "objective": ji.get("workflowObjective")}, stage=stage)
            # the explorer has no page per stage job: a workflow lives at /jobs/<workflowId> with #contracts / #website anchors
            t["workflow"]["explorerUrl"] = f"{EXPLORER}/jobs/{ji['workflowId']}#{'website' if stage == 'frontend' else 'contracts'}"
            t["jobUrl"] = t["workflow"]["explorerUrl"]; t["jobPublished"] = True
        tmpl = ji.get("template") or ""
        kind = "panel" if (nk == "panel" or tmpl == "research" or (node or {}).get("key") == "panel") else "fuzz" if (nk == "campaign" or tmpl == "fuzz" or (node or {}).get("key") == "campaign") else None
        if kind:
            pf = _cached(_panels, job, pb, (lambda j: panel_fetch(j, token)) if kind == "panel" else (lambda j: fuzz_fetch(j, token)))
            if pf and pf.get("state"):
                t[kind] = pf
                if t.get("verdict") in (None, "pending"):  # these jobs have no /submissions record: the panel or campaign is the verdict
                    if kind == "panel":
                        if pf.get("ours") and pf["state"] == "accepted": t["verdict"] = "accepted"
                        elif pf.get("ours") and pf["state"] in ("rejected", "failed"): t["verdict"] = "rejected"
                    else:
                        o = pf.get("ours") or {}
                        if o.get("outcome") == "failed" or o.get("verdictStatus") == "rejected": t["verdict"] = "failed" if o.get("outcome") == "failed" else "rejected"
                        elif o.get("verdictStatus") == "accepted" or (o.get("outcome") in ("confirmed", "ok", "clean") and pf["state"] == "completed"): t["verdict"] = "accepted"
                    if t.get("verdict") in ("rejected", "failed") and not t.get("reason"):
                        o = pf.get("ours") or {}
                        t["reason"] = {"reason": (o.get("verdictDetail") or o.get("detail") or f"{kind} {pf['state']}")[:300], "source": "api", "state": t["verdict"]}
        if t.get("verdict") == "accepted" and ji.get("state") == "completed":  # what the network kept and where it went
            rs = _cached(_results, job, rb, result_fetch, live_ttl=600)
            if rs and (rs.get("files") or rs.get("delivery") or rs.get("source")):
                t["result"] = {k: rs.get(k) for k in ("complete", "files", "source", "delivery", "launch", "url")}
    d["totals"]["workflows"] = len({t["workflow"]["id"] for t in d["tasks"] if t.get("workflow") and t["workflow"].get("id")})
    d["totals"]["delivered"] = sum(1 for t in d["tasks"] if ((t.get("result") or {}).get("delivery") or {}).get("deliveredAt") or ((t.get("jobInfo") or {}).get("delivery") or {}).get("deliveredAt"))
    d["subsCache"].update({"jobs2": len(_jobs), "workflows": len(_workflows), "results": len(_results), "panels": len(_panels), "jobsBudgetLeft": jb[0]})
    by_id = {t["id"]: t for t in d["tasks"]}
    for r in d.get("running") or []:
        src = by_id.get(r["id"]) or {}
        r["kindLabel"] = src.get("kindLabel") or r.get("kindLabel"); r["workflow"] = {"id": src["workflow"].get("id"), "stage": src["workflow"].get("stage")} if src.get("workflow") else None
    return d


# ---- oracle requests: a "pending" answer on a job the network already closed is not pending — the panel disagreed (no quorum)
# or the job is blocked. GET /oracle/requests paged back to our oldest open submission, memoised 5 min.
def oracle_family(q):
    """The shape of an oracle question with the specifics removed: proper nouns, symbols, numbers, addresses — so
    'Which address sent the most SAND on Ethereum mainnet in the last 6 hours?' groups with the APE / ENJ / RARI ones."""
    words = (q or "").split("?")[0].split()
    keep = []
    for i, w in enumerate(words):
        if i and (w[:1].isupper() or w.isupper()) and not w.lower() in ("nft", "erc-1155", "erc-20"):
            continue
        keep.append(w.lower())
    s = " ".join(keep)
    s = re.sub(r"0x[0-9a-f]{6,}", "<addr>", s); s = re.sub(r"\d[\d,.]*", "<n>", s); s = re.sub(r"\([^)]*\)", "", s); s = re.sub(r"\s+", " ", s).strip()
    return " ".join(s.split()[:9])


def oracle_status_fetch(oldest_iso, pages=6):
    out = {}; before = None
    for _ in range(pages):
        d = api_json("/oracle/requests?limit=500" + (f"&before={before}" if before else ""), timeout=30)
        rs = d.get("requests") or []
        if not rs:
            break
        for r in rs:
            if r.get("jobId") and r["jobId"] not in out:
                out[r["jobId"]] = {"status": r.get("status"), "updatedAt": r.get("updatedAt"), "attestedAt": r.get("attestedAt"), "id": r.get("id"),
                                   "chainId": r.get("chainId"), "answerType": r.get("answerType"), "question": (r.get("question") or "")[:200], "family": oracle_family(r.get("question"))}
        before = rs[-1].get("createdAt")
        if not before or (oldest_iso and before < oldest_iso):
            break
    return {"byJob": out, "fetchedAt": time.time()}


VERDICT_LABEL = {"noquorum": "no quorum", "blocked": "blocked"}
def pass_oracle_status(d):
    """Oracle answers on closed requests: no quorum / blocked instead of pending; the question behind every oracle task."""
    oracle = [t for t in d.get("tasks") or [] if t.get("job") and (t.get("kindLabel") == "oracle" or (t.get("seatWork") or {}).get("nodeKey") == "oracle_assess")]
    openq = [t for t in d.get("tasks") or [] if t.get("verdict") == "pending" and t.get("job")]
    if oracle or openq:
        oldest = min(t.get("submittedAt") or t.get("acceptedAt") or 0 for t in oracle + openq)
        oldest_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(oldest - 3600)) if oldest else None
        om = memo("oracleStatus", 300, lambda: oracle_status_fetch(oldest_iso))
        by = om.get("byJob") if isinstance(om, dict) else {}
        for t in oracle:
            r = by.get(t["job"]) if by else None
            if r:
                t["oracleQ"] = {k: r.get(k) for k in ("chainId", "answerType", "question", "family", "status")}
        for t in openq:
            js = (t.get("seatWork") or {}).get("jobState") or (t.get("jobInfo") or {}).get("state")
            r = by.get(t["job"]) if by else None
            t["oracleRequest"] = r
            if js == "blocked" or (r or {}).get("status") == "blocked":
                t["verdict"] = "blocked"
                t["reason"] = {"reason": "job blocked on the network" + (" — " + str((t.get("jobInfo") or {}).get("blockedReason")) if (t.get("jobInfo") or {}).get("blockedReason") else "") + "; the answer was verified but will never be judged", "source": "api", "state": "blocked"}
            elif r and r.get("status") == "disagreed" and js in FINAL_JOB_STATES:
                t["verdict"] = "noquorum"
                t["reason"] = {"reason": "no quorum — the panel never agreed on an answer, the request closed without an attestation", "source": "api", "state": "noquorum"}
                t.setdefault("explorer", {})["word"] = "no quorum"
    d["totals"]["noquorum"] = sum(1 for t in d["tasks"] if t.get("verdict") == "noquorum")
    d["totals"]["blocked"] = sum(1 for t in d["tasks"] if t.get("verdict") == "blocked")
    d["totals"]["pending"] = sum(1 for t in d["tasks"] if t.get("verdict") == "pending")
    # work lost: tasks released on the rate limit after real work (turns, minutes, cost) — nothing was delivered
    lost = [t for t in d["tasks"] if t.get("status") == "rate-limited" and (t.get("turns") or 0) > 0]
    d["totals"]["wasted"] = {"tasks": len(lost), "turns": sum(t.get("turns") or 0 for t in lost), "cost": round(sum(t.get("costUSD") or 0 for t in lost), 2), "seconds": sum(t.get("durationS") or 0 for t in lost)}
    return d


# ---- the API sentinel: imd.fun/docs lists every public route; a daily diff says when the dashboard has something new to read
DOCS_URL = "https://imd.fun/docs/"
API_ROUTES_FILE = state("api-routes.json")
RE_ROUTE = re.compile(r"\b(GET|POST|PUT|DELETE|PATCH)\s+(/[A-Za-z0-9_:./?=&{}<>-]+)")


def api_docs_fetch():
    import html as _html
    page = http_get(DOCS_URL, timeout=30)
    text = _html.unescape(re.sub(r"<[^>]+>", " ", re.sub(r"<script.*?</script>", "", page, flags=re.S)))
    routes = sorted({f"{m} {p}" for m, p in RE_ROUTE.findall(text) if not re.search(r"[A-Z]{3,}_[A-Z]+|JOB_ID|_ID\b", p)})
    try:
        with open(API_ROUTES_FILE) as fh:
            known = json.load(fh)
    except (OSError, ValueError):
        known = {"routes": {}, "firstRun": True}
    today = time.strftime("%Y-%m-%d", time.gmtime())
    first = known.get("firstRun") or not known.get("routes")
    new = [r for r in routes if r not in known["routes"]]
    gone = [r for r in known["routes"] if r not in routes]
    for r in new:
        known["routes"][r] = today
    if gone:
        for r in gone:
            known.setdefault("removed", {})[r] = today; known["routes"].pop(r, None)
    known["firstRun"] = False; known["checkedAt"] = today
    try:
        with open(API_ROUTES_FILE, "w") as fh:
            json.dump(known, fh, indent=1)
    except OSError:
        pass
    recent = time.strftime("%Y-%m-%d", time.gmtime(time.time() - 14 * 86400))
    return {"count": len(routes), "new": [] if first else [{"route": r, "since": today} for r in new], "recent": sorted(({"route": r, "since": dte} for r, dte in known["routes"].items() if dte >= recent and not first), key=lambda x: x["since"], reverse=True),
            "removed": [{"route": r, "since": today} for r in gone] if not first else [], "baseline": today if first else None, "checkedAt": time.time(), "url": DOCS_URL}


def pass_api_docs(d):
    """Route catalogue of imd.fun/docs, diffed daily against the last visit."""
    r = memo("apiDocs", 6 * 3600, api_docs_fetch)
    if isinstance(d.get("network"), dict):
        d["network"]["apiRoutes"] = r if isinstance(r, dict) else {"error": str(r)}
    return d


# ================================================================ the pipeline: one base pass, then every enrichment in order
PASSES = [pass_config, pass_explorer, pass_api, pass_swarm, pass_updates, pass_protocol, pass_oracle_status, pass_api_docs]


def collect():
    log = sync_tiers()  # first: collect_base labels every task against this log
    d = collect_base()
    d["tierLog"] = log
    for p in PASSES:
        d = p(d) or d
    return d


if __name__ == "__main__":
    import sys
    d = collect()
    if "--summary" in sys.argv:
        print(json.dumps({k: d[k] for k in ("totals", "byModel", "episodes", "lastAlive", "tierLog", "collectMs")}, indent=1, default=str))
    elif "--tiers" in sys.argv:
        print(json.dumps(d["tierLog"], indent=1, default=str))
    else:
        json.dump(d, sys.stdout)
