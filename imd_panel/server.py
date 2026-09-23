#!/usr/bin/env python3
"""IMD worker dashboard: serves index.html and /api/data on localhost only."""
import glob, json, os, re, shutil, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from . import collect, notify, history
from .paths import HERE, state

HOST, PORT = "127.0.0.1", int(os.environ.get("PORT", "8787"))
TTL = int(os.environ.get("CACHE_TTL", "20"))
INDEX = os.environ.get("INDEX", "index.html")  # preview a candidate page without swapping the live one
_lock = threading.Lock()
_cache = {"ts": 0, "body": b""}


def data(force=False):
    with _lock:
        if force or time.time() - _cache["ts"] > TTL:
            d = collect.collect()
            _cache["raw"] = d
            _cache["ts"] = time.time()
        d = dict(_cache["raw"]); d["guard"] = {"config": guard_cfg(), "state": _guard_state}
        nc = notify.cfg(); d["notify"] = {"config": {**nc, "telegramToken": ("•••" + nc["telegramToken"][-4:]) if nc.get("telegramToken") else ""}, "history": notify._hist[-10:]}
        return json.dumps(d, default=str).encode()


class H(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def send(self, code, ctype, body):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ---- write actions: localhost only + custom header (blocks cross-site form/XHR posts)
    def do_POST(self):
        if self.headers.get("X-Dashboard") != "1" or self.client_address[0] != "127.0.0.1":
            return self.send(403, "application/json", b'{"error":"forbidden"}')
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return self.send(400, "application/json", b'{"error":"bad json"}')
        path = self.path.split("?", 1)[0]
        try:
            fn = ACTIONS.get(path)
            if not fn:
                return self.send(404, "application/json", b'{"error":"no such action"}')
            res = fn(body)
            # drop what the action may have just changed, including the worker start
            # time — the tier log keys snapshots off it right after a restart
            for k in ("config", "skills", "host", "effective", "worker-start"):
                collect._slow.pop(k, None)
            data(force=True)
            return self.send(200, "application/json", json.dumps({"ok": True, **(res or {})}).encode())
        except Exception as e:
            return self.send(400, "application/json", json.dumps({"ok": False, "error": str(e)[:400]}).encode())

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            with open(os.path.join(HERE, INDEX), "rb") as fh:
                return self.send(200, "text/html; charset=utf-8", fh.read())
        if path.startswith("/assets/"):  # artwork for the room (the pepe sprite): plain files under ./assets
            name = os.path.basename(path)
            fp = os.path.join(HERE, "assets", name)
            if not re.fullmatch(r"[A-Za-z0-9_.-]+", name) or not os.path.isfile(fp):
                return self.send(404, "text/plain", b"not found")
            ctype = {"webp": "image/webp", "png": "image/png", "jpg": "image/jpeg", "svg": "image/svg+xml"}.get(name.rsplit(".", 1)[-1], "application/octet-stream")
            with open(fp, "rb") as fh:
                body = fh.read()
            self.send_response(200); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(body))); self.send_header("Cache-Control", "max-age=86400"); self.end_headers(); self.wfile.write(body)
            return
        if path == "/api/transcript":
            from urllib.parse import parse_qs
            q = parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            sid = (q.get("id") or [""])[0]
            return self.send(200, "application/json", json.dumps(collect.transcript(sid), default=str).encode())
        if path == "/api/history":
            return self.send(200, "application/json", json.dumps(history.read()).encode())
        if path == "/api/data":
            return self.send(200, "application/json", data(force="refresh=1" in self.path))
        if path == "/api/export":  # raw log exports; same guard as writes (localhost + header) so a stray browser tab can't pull them
            if self.headers.get("X-Dashboard") != "1" or self.client_address[0] != "127.0.0.1":
                return self.send(403, "application/json", b'{"error":"forbidden"}')
            from urllib.parse import parse_qs
            q = parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            what = (q.get("what") or [""])[0]; hours = int((q.get("hours") or ["24"])[0] or 0)
            units = {"journal": collect.UNIT, "panel-log": "imd-panel"}
            if what in units:
                cmd = ["journalctl", "--user", "-u", units[what], "--no-pager", "-o", "short-iso"] + (["--since", "-%dh" % hours] if hours else [])
                out = subprocess.run(cmd, capture_output=True, text=True, timeout=60).stdout
                return self.send(200, "text/plain; charset=utf-8", out.encode())
            if what == "guard-log":
                return self.send(200, "application/json", json.dumps(_guard_state.get("log", [])).encode())
            return self.send(404, "application/json", b'{"error":"unknown export"}')
        return self.send(404, "text/plain", b"not found")


def run(cmd, timeout=90, env=None):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
    if r.returncode:
        raise RuntimeError((r.stderr or r.stdout).strip()[:400] or "command failed")
    return (r.stdout or "").strip()


def act_config(body):
    """Update inference overrides and/or concurrency. Other config keys are never touched."""
    with open(collect.CONFIG) as fh:
        cfg = json.load(fh)
    changed = []
    if "inference" in body:
        inf = body["inference"] or {}
        clean = {}
        for tier, by_rt in inf.items():
            if tier not in ("economy", "standard", "premium") or not isinstance(by_rt, dict):
                raise ValueError("bad tier " + str(tier))
            if tier == "premium":  # only two states: accept (no override) or opt out
                if by_rt != {"claude": collect.PREMIUM_OPT_OUT}:
                    raise ValueError("premium can only be left to the worker or opted out")
                clean["premium"] = {"claude": dict(collect.PREMIUM_OPT_OUT)}
                continue
            for rt, choice in by_rt.items():
                if rt != "claude" or not isinstance(choice, dict):
                    raise ValueError("bad runtime " + str(rt))
                model = choice.get("model"); effort = choice.get("effort")
                if model not in collect.ALLOWED_MODELS:
                    raise ValueError("model not allowed: " + str(model))
                if effort is not None and effort not in collect.ALLOWED_EFFORT:
                    raise ValueError("effort not allowed: " + str(effort))
                if effort and model in collect.NO_EFFORT_MODELS:
                    raise ValueError(model + " takes no effort setting")
                clean.setdefault(tier, {})[rt] = {"model": model, **({"effort": effort} if effort else {})}
        if clean != cfg.get("inference", {}):
            cfg["inference"] = clean; changed.append("inference")
    if "maxConcurrency" in body:
        n = int(body["maxConcurrency"])
        if not 1 <= n <= 4:
            raise ValueError("concurrency must be 1-4")
        if n != cfg.get("maxConcurrency"):
            cfg["maxConcurrency"] = n; changed.append("maxConcurrency")
        unit = open(collect.UNIT_FILE).read()
        new = re.sub(r'"--concurrency"\s+"\d"', '"--concurrency" "%d"' % n, unit)
        if new != unit:
            shutil.copy2(collect.UNIT_FILE, collect.UNIT_FILE + ".bak-dashboard")
            with open(collect.UNIT_FILE, "w") as fh:
                fh.write(new)
            run(["systemctl", "--user", "daemon-reload"]); changed.append("unit")
    if "inference" in changed or "maxConcurrency" in changed:
        tmp = collect.CONFIG + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(cfg, fh, indent=2)
        os.chmod(tmp, 0o600); os.replace(tmp, collect.CONFIG)
    return {"changed": changed, "restartNeeded": bool(changed)}


def act_skills(body):
    sid = str(body.get("id", ""))
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", sid):
        raise ValueError("bad skill id")
    out = run([collect.imd_bin(), "skills", "add" if body.get("on") else "remove", sid], env=collect.imd_env())
    return {"output": out[-300:], "restartNeeded": True}


def act_worker(body):
    action = body.get("action")
    if action not in ("restart", "stop", "start"):
        raise ValueError("action must be restart|stop|start")
    run(["systemctl", "--user", action, collect.UNIT])
    if action in ("start", "restart"):
        _guard_state.update({"paused": False, "pausedAt": None, "reason": "", "resumeAt": None, "overrideUntil": time.time() + 3600})
    time.sleep(2)
    return {"state": run(["systemctl", "--user", "is-active", collect.UNIT], timeout=15)}


def act_doctor(body):
    """Run `imd doctor` (the worker's own check-up; it pings Claude once) and hand back its report."""
    t0 = time.time()
    r = subprocess.run([collect.imd_bin(), "doctor"], capture_output=True, text=True, timeout=240, env=collect.imd_env())
    out = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", (r.stdout or "") + (("\n" + r.stderr) if r.stderr.strip() else ""))
    return {"output": out.strip()[-12000:], "rc": r.returncode, "took": round(time.time() - t0, 1)}


def prune(work_days=None, transcript_days=None):
    """Remove finished task work dirs older than work_days and their Claude Code transcripts older than transcript_days.
    Only touches <identitymd home>/work/<job>/<node> and ~/.claude/projects/*identitymd-work*; never the work root itself."""
    work_days = work_days or collect.PANEL["pruneWorkDays"]; transcript_days = transcript_days or collect.PANEL["pruneTranscriptDays"]
    now = time.time(); removed = {"work": 0, "transcripts": 0}
    root = os.path.join(collect.IDENTITYMD_HOME, "work")
    if os.path.isdir(root):
        for job in os.listdir(root):
            jp = os.path.join(root, job)
            if not os.path.isdir(jp):
                continue
            for node in os.listdir(jp):
                np_ = os.path.join(jp, node)
                if os.path.isdir(np_) and now - os.path.getmtime(np_) > work_days * 86400:
                    shutil.rmtree(np_, ignore_errors=True); removed["work"] += 1
            try:
                if not os.listdir(jp) and now - os.path.getmtime(jp) > work_days * 86400:
                    os.rmdir(jp)
            except OSError:
                pass
    for d in glob.glob(os.path.join(collect.PROJECTS, "*identitymd-work*")):
        if os.path.isdir(d) and now - os.path.getmtime(d) > transcript_days * 86400:
            shutil.rmtree(d, ignore_errors=True); removed["transcripts"] += 1
    return removed


def act_cleanup(body):
    if collect.PANEL["cleanUnit"]:
        run(["systemctl", "--user", "start", collect.PANEL["cleanUnit"]], timeout=300)
        log = run(["journalctl", "--user", "-u", collect.PANEL["cleanUnit"], "-n", "3", "--no-pager", "-o", "cat"], timeout=15)
        return {"output": log[-300:]}
    r = prune()
    return {"output": "removed %d work dir(s) older than %d d and %d transcript dir(s) older than %d d" % (r["work"], collect.PANEL["pruneWorkDays"], r["transcripts"], collect.PANEL["pruneTranscriptDays"])}


# ---------------------------------------------------------------- worker updates: check, update, roll back, auto-update toggle
import hashlib, urllib.request


def _updates_log(entry):
    try:
        with open(collect.UPDATES_LOG) as fh:
            log = json.load(fh)
    except (OSError, ValueError):
        log = []
    log.append({"ts": time.time(), **entry})
    tmp = collect.UPDATES_LOG + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(log[-50:], fh, indent=1)
    os.replace(tmp, collect.UPDATES_LOG)


def _release_tgz(tag):
    """The release archive for a tag, downloaded from GitHub once and verified against SHA256SUMS; kept in worker-versions/."""
    if not re.fullmatch(r"worker-v[0-9.]+-[0-9a-f]{12}", tag or ""):
        raise ValueError("bad release tag")
    os.makedirs(collect.VERSIONS_DIR, exist_ok=True)
    dst = os.path.join(collect.VERSIONS_DIR, tag + ".tgz")
    if os.path.exists(dst) and os.path.getsize(dst) > 1000:
        return dst
    base = f"https://github.com/{collect.WORKER_REPO}/releases/download/{tag}/"
    def get(name, limit):
        req = urllib.request.Request(base + name, headers={"User-Agent": "imd-panel/1"})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read(limit + 1)
        if len(data) > limit:
            raise ValueError(name + " larger than expected")
        return data
    sums = get("SHA256SUMS", 4096).decode()
    want = next((l.split()[0] for l in sums.splitlines() if l.strip().endswith("identitymd-worker.tgz")), None)
    if not want:
        raise ValueError("SHA256SUMS does not list identitymd-worker.tgz")
    blob = get("identitymd-worker.tgz", 32 * 1024 * 1024)
    if hashlib.sha256(blob).hexdigest() != want:
        raise ValueError("SHA-256 mismatch on the downloaded release")
    with open(dst + ".tmp", "wb") as fh:
        fh.write(blob)
    os.replace(dst + ".tmp", dst)
    return dst


def _set_auto_update(on):
    unit = open(collect.UNIT_FILE).read()
    has = '"--auto-update"' in unit
    if on == has:
        return False
    new = unit.replace(' "--auto-update"', "") if not on else re.sub(r'("--concurrency"\s+"\d")', r'\1 "--auto-update"', unit, count=1)
    if on and '"--auto-update"' not in new:
        raise ValueError("could not place --auto-update in the unit's ExecStart")
    shutil.copy2(collect.UNIT_FILE, collect.UNIT_FILE + ".bak-dashboard")
    with open(collect.UNIT_FILE, "w") as fh:
        fh.write(new)
    run(["systemctl", "--user", "daemon-reload"])
    return True


def _restart_worker():
    run(["systemctl", "--user", "restart", collect.UNIT], timeout=120)
    _guard_state.update({"paused": False, "pausedAt": None, "reason": "", "resumeAt": None, "overrideUntil": time.time() + 3600})
    time.sleep(3)
    return run(["systemctl", "--user", "is-active", collect.UNIT], timeout=15)


def act_update(body):
    action = body.get("action")
    for k in ("install", "releases", "effective", "worker-version", "config"):
        collect._slow.pop(k, None)
    if action == "check":
        rel = collect.releases_fetch(); collect._slow["releases"] = (time.time(), rel)
        inst = collect.worker_install()
        latest = (rel.get("releases") or [{}])[0]
        return {"installed": inst.get("build"), "latest": latest.get("build"), "tag": latest.get("tag"), "available": bool(latest.get("build") and latest["build"] != inst.get("build"))}
    if action == "autoUpdate":
        on = bool(body.get("on"))
        changed = _set_auto_update(on)
        state = _restart_worker() if changed else run(["systemctl", "--user", "is-active", collect.UNIT], timeout=15)
        _updates_log({"by": "dashboard", "action": "auto-update " + ("on" if on else "off"), "from": None, "to": None})
        return {"autoUpdate": on, "changed": changed, "state": state}
    if action == "update":
        before = collect.worker_install().get("build")
        out = run([collect.imd_bin(), "update"], timeout=300, env=collect.imd_env())
        after = collect.worker_install().get("build")
        state = _restart_worker() if after != before else run(["systemctl", "--user", "is-active", collect.UNIT], timeout=15)
        _updates_log({"by": "dashboard", "action": "update", "from": before, "to": after})
        return {"from": before, "to": after, "changed": after != before, "output": out[-600:], "state": state}
    if action == "rollback":
        tag = body.get("tag"); before = collect.worker_install().get("build")
        if collect.tag_build(tag) == before:
            raise ValueError("that build is already installed")
        tgz = _release_tgz(tag)
        auto_off = _set_auto_update(False)  # otherwise the daemon reinstalls the latest release within five minutes
        out = run(["npm", "install", "-g", "--no-audit", "--no-fund", tgz], timeout=300, env=collect.imd_env())
        after = collect.worker_install().get("build")
        if after != collect.tag_build(tag):
            raise ValueError(f"npm installed {after}, expected {collect.tag_build(tag)}: {out[-300:]}")
        state = _restart_worker()
        _updates_log({"by": "dashboard", "action": "rollback", "from": before, "to": after})
        return {"from": before, "to": after, "autoUpdateTurnedOff": auto_off, "output": out[-600:], "state": state}
    if action == "fetch":  # just cache a release archive (verified), no install
        return {"path": _release_tgz(body.get("tag"))}
    raise ValueError("action must be check|update|rollback|autoUpdate|fetch")


# ---------------------------------------------------------------- budget guard
GUARD_FILE = state("guard.json")
GUARD_DEFAULT = {"enabled": False, "sessionPct": 90, "weeklyPct": 0, "windowTokens": 0, "windowCost": 0, "dailyCost": 0, "waitForIdle": True, "resumeAtReset": True}
_guard_state = {"paused": False, "pausedAt": None, "reason": "", "resumeAt": None, "lastCheck": None, "overrideUntil": None, "log": []}


def guard_cfg():
    try:
        with open(GUARD_FILE) as fh:
            return {**GUARD_DEFAULT, **json.load(fh)}
    except (OSError, ValueError):
        return dict(GUARD_DEFAULT)


def guard_log(msg):
    _guard_state["log"] = (_guard_state["log"] + [{"ts": time.time(), "msg": msg}])[-30:]
    sys.stderr.write("guard: %s\n" % msg)


def worker_state():
    try:
        return run(["systemctl", "--user", "is-active", collect.UNIT], timeout=10)
    except RuntimeError as e:
        return str(e).strip() or "inactive"


def guard_tick():
    g = guard_cfg(); now = time.time(); _guard_state["lastCheck"] = now
    d = json.loads(data())
    q = d.get("quota") or {}; used = q.get("used") or {}
    tokens = sum(v for k, v in used.items() if k not in ("cost", "sessions"))
    cost = used.get("cost", 0)
    day0 = now - (now % 86400)
    daily = sum(t.get("costUSD", 0) for t in d.get("tasks", []) if t.get("acceptedAt", 0) >= day0)
    over = []
    # Claude's own utilisation (what /usage shows) is the number that actually limits us; the token/$ counts below are estimates
    u = d.get("usage") or {}; fh = u.get("fiveHour") or {}; sd = u.get("sevenDay") or {}
    if g.get("sessionPct") and fh.get("pct") is not None and fh["pct"] >= g["sessionPct"]: over.append("Claude 5h window at %d%% >= %d%%" % (fh["pct"], g["sessionPct"]))
    if g.get("weeklyPct") and sd.get("pct") is not None and sd["pct"] >= g["weeklyPct"]: over.append("Claude weekly at %d%% >= %d%%" % (sd["pct"], g["weeklyPct"]))
    if g["windowTokens"] and tokens >= g["windowTokens"]: over.append("window tokens %s >= %s" % (f"{tokens:,}", f"{g['windowTokens']:,}"))
    if g["windowCost"] and cost >= g["windowCost"]: over.append("window cost $%.2f >= $%.2f" % (cost, g["windowCost"]))
    if g["dailyCost"] and daily >= g["dailyCost"]: over.append("daily cost $%.2f >= $%.2f" % (daily, g["dailyCost"]))
    _guard_state.update({"tokens": tokens, "cost": round(cost, 2), "daily": round(daily, 2), "over": over, "enabled": g["enabled"], "sessionPct": fh.get("pct"), "weeklyPct": sd.get("pct")})
    state = worker_state()
    if _guard_state["paused"]:
        resume = _guard_state.get("resumeAt")
        if not g["enabled"] or (resume and now >= resume):
            if state != "active":
                run(["systemctl", "--user", "start", collect.UNIT]); guard_log("resumed worker (%s)" % ("guard disabled" if not g["enabled"] else "window reset"))
            _guard_state.update({"paused": False, "pausedAt": None, "reason": "", "resumeAt": None, "overrideUntil": now + 600 if g["enabled"] else None})
        return
    if not g["enabled"] or state != "active":
        return
    if _guard_state.get("overrideUntil") and now < _guard_state["overrideUntil"]:
        return
    if over:
        running = len(d.get("running") or [])
        if g["waitForIdle"] and running:
            _guard_state["pending"] = "over budget — waiting for %d running task(s) to finish" % running
            return
        run(["systemctl", "--user", "stop", collect.UNIT])
        if g["resumeAtReset"]:
            resume_at = (sd.get("resetsAt") if any("weekly" in o for o in over) else None) or fh.get("resetsAt") or q.get("windowEnd") or now + 5 * 3600
        else:
            resume_at = None
        if resume_at and resume_at <= now:
            resume_at = now + 3600
        _guard_state.update({"paused": True, "pausedAt": now, "reason": "; ".join(over), "resumeAt": resume_at, "pending": None})
        guard_log("paused worker: %s; resume at %s" % ("; ".join(over), time.strftime("%H:%M UTC", time.gmtime(resume_at)) if resume_at else "manual"))
    else:
        _guard_state["pending"] = None


def guard_loop():
    while True:
        try:
            guard_tick()
        except Exception as e:
            guard_log("error: %s" % str(e)[:200])
        try:
            notify.check(json.loads(data()), _guard_state)
        except Exception as e:
            sys.stderr.write("notify error: %s\n" % str(e)[:200])
        try:
            if time.time() - _last_snap[0] > 600:
                history.snapshot(json.loads(data())); _last_snap[0] = time.time()
        except Exception as e:
            sys.stderr.write("history error: %s\n" % str(e)[:200])
        try:  # built-in daily prune of old work dirs and transcripts (unless a cleanup unit is configured)
            if not collect.PANEL["cleanUnit"] and time.time() - _last_prune[0] > 86400:
                r = prune(); _last_prune[0] = time.time()
                if r["work"] or r["transcripts"]:
                    sys.stderr.write("prune: %d work dir(s), %d transcript dir(s) removed\n" % (r["work"], r["transcripts"]))
        except Exception as e:
            sys.stderr.write("prune error: %s\n" % str(e)[:200])
        time.sleep(30)


_last_snap = [0]
_last_prune = [time.time()]  # first prune a day after start, not at boot


def act_guard(body):
    g = guard_cfg()
    for k in ("windowTokens", "windowCost", "dailyCost", "sessionPct", "weeklyPct"):
        if k in body:
            v = float(body[k] or 0)
            if v < 0: raise ValueError(k + " must be >= 0")
            if k.endswith("Pct") and v > 100: raise ValueError(k + " is a percentage")
            g[k] = int(v) if k in ("windowTokens", "sessionPct", "weeklyPct") else round(v, 2)
    for k in ("enabled", "waitForIdle", "resumeAtReset"):
        if k in body: g[k] = bool(body[k])
    tmp = GUARD_FILE + ".tmp"
    with open(tmp, "w") as fh: json.dump(g, fh, indent=2)
    os.replace(tmp, GUARD_FILE)
    if body.get("resumeNow") and _guard_state["paused"]:
        run(["systemctl", "--user", "start", collect.UNIT])
        _guard_state.update({"paused": False, "pausedAt": None, "reason": "", "resumeAt": None, "overrideUntil": time.time() + 3600})
        guard_log("resumed manually; guard overridden for 1h")
    threading.Thread(target=guard_tick, daemon=True).start()
    return {"guard": g}


def act_notify(body):
    c = notify.cfg()
    for k in ("telegramToken", "telegramChatId", "webhookUrl"):
        if k in body and body[k] is not None:
            v = str(body[k]).strip()
            if k == "webhookUrl" and v and not v.startswith("https://"):
                raise ValueError("webhook must be https://")
            c[k] = v
    if isinstance(body.get("events"), dict):
        c["events"] = {k: bool(body["events"].get(k, c["events"].get(k))) for k in c["events"]}
    for k in ("heartbeatMin", "diskGB", "dailyHourUTC"):
        if k in body: c[k] = int(body[k])
    notify.save(c)
    res = {}
    if body.get("test"):
        res = notify.send("✅ imd-panel test notification from %s" % collect.HOST, c)
        if res["errors"]: raise ValueError("; ".join(res["errors"]))
    return {"notify": {**c, "telegramToken": ("•••" + c["telegramToken"][-4:]) if c["telegramToken"] else ""}, **res}


ACTIONS = {"/api/update": act_update, "/api/doctor": act_doctor, "/api/notify": act_notify, "/api/config": act_config, "/api/skills": act_skills, "/api/worker": act_worker, "/api/cleanup": act_cleanup, "/api/guard": act_guard}


def serve(port=None):
    port = port or PORT
    if not os.environ.get("NO_GUARD"):  # a preview instance must not act on the worker
        threading.Thread(target=guard_loop, daemon=True).start()
    srv = ThreadingHTTPServer((HOST, port), H)
    print("imd-panel listening on http://%s:%d (state in %s)" % (HOST, port, state("")), flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    serve()
