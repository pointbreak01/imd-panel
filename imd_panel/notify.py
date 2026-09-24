"""Event notifier for the IMD dashboard: Telegram bot and/or generic webhook. Config in notify.json (mode 600)."""
import json, os, sys, time, urllib.request, urllib.parse
from .paths import state

FILE = state("notify.json")
STATE = state("notify.state.json")
DEFAULT = {"telegramToken": "", "telegramChatId": "", "webhookUrl": "",
           "events": {"limit": True, "guard": True, "heartbeat": True, "worker": True, "rejected": True, "disk": True, "released": True, "daily": True, "standing": True},
           "heartbeatMin": 5, "diskGB": 10, "dailyHourUTC": 8}
_hist = []  # (ts, text) recent sends for the UI


def cfg():
    try:
        with open(FILE) as fh:
            c = json.load(fh)
        return {**DEFAULT, **c, "events": {**DEFAULT["events"], **(c.get("events") or {})}}
    except (OSError, ValueError):
        return json.loads(json.dumps(DEFAULT))


def save(c):
    tmp = FILE + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(c, fh, indent=2)
    os.chmod(tmp, 0o600); os.replace(tmp, FILE)


def load_state():
    try:
        with open(STATE) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {"seen": {}, "lastDaily": 0}


def save_state(s):
    tmp = STATE + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(s, fh)
    os.replace(tmp, STATE)


def send(text, c=None):
    c = c or cfg(); sent = []; errors = []
    if c.get("telegramToken") and c.get("telegramChatId"):
        try:
            body = urllib.parse.urlencode({"chat_id": c["telegramChatId"], "text": text, "parse_mode": "HTML", "disable_web_page_preview": "true"}).encode()
            req = urllib.request.Request(f"https://api.telegram.org/bot{c['telegramToken']}/sendMessage", data=body)
            with urllib.request.urlopen(req, timeout=15) as r:
                r.read(); sent.append("telegram")
        except Exception as e:
            errors.append("telegram: " + str(e)[:160])
    if c.get("webhookUrl"):
        try:
            req = urllib.request.Request(c["webhookUrl"], data=json.dumps({"text": text, "source": "imd-panel"}).encode(), headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=15) as r:
                r.read(); sent.append("webhook")
        except Exception as e:
            errors.append("webhook: " + str(e)[:160])
    _hist.append({"ts": time.time(), "text": text, "sent": sent, "errors": errors}); del _hist[:-50]
    sys.stderr.write("notify [%s] %s%s\n" % (",".join(sent) or "none", text.replace("\n", " | ")[:160], (" ERR " + "; ".join(errors)) if errors else ""))
    return {"sent": sent, "errors": errors}


def hm(ts):
    return time.strftime("%H:%M", time.gmtime(ts)) + " UTC"


def check(d, guard_state):
    """Given the dashboard data dict, emit notifications for new events. Idempotent via notify.state.json."""
    c = cfg(); ev = c["events"]
    if not (c.get("telegramToken") and c.get("telegramChatId")) and not c.get("webhookUrl"):
        return
    st = load_state(); seen = st.setdefault("seen", {}); now = time.time(); host = d.get("host", {})
    out = []
    if not st.get("seeded"):  # first run: don't replay history, only report what happens from now on
        for t in d.get("tasks", []):
            if t.get("verdict") in ("rejected", "failed"):
                seen["rejected:" + t["id"]] = now
        for lm in d.get("limitMsgs") or []:
            seen["limit:%d" % int(lm["ts"] // 600)] = now
        st["seeded"] = True

    def once(key, text, ttl=6 * 3600):
        if now - seen.get(key, 0) < ttl:
            return
        seen[key] = now; out.append(text)

    # 1. Claude session-limit errors (from transcripts)
    lm = (d.get("limitMsgs") or [])[-1:] 
    if ev.get("limit") and lm and now - lm[0]["ts"] < 1800:
        once("limit:%d" % int(lm[0]["ts"] // 600), f"🚦 <b>Claude limit hit</b> at {hm(lm[0]['ts'])}\n{lm[0]['msg']}")
    # 2. tasks released because of rate limit
    rel = [t for t in d.get("tasks", []) if t.get("status") == "rate-limited" and now - (t.get("endedAt") or t.get("acceptedAt", 0)) < 1800]
    if ev.get("released") and rel:
        once("released:%d" % int(now // 1800), f"↩️ <b>{len(rel)} task(s) released</b> on rate limit in the last 30 min (last: {rel[0]['id']})")
    # 3. guard
    if ev.get("guard") and guard_state.get("paused"):
        once("guard:%d" % int(guard_state.get("pausedAt") or 0), f"⏸ <b>Budget guard paused the worker</b> at {hm(guard_state['pausedAt'])}\n{guard_state.get('reason','')}\nresumes {hm(guard_state['resumeAt']) if guard_state.get('resumeAt') else 'manually'}")
    if ev.get("guard") and not guard_state.get("paused"):
        for l in (guard_state.get("log") or [])[-3:]:
            if l["msg"].startswith("resumed") and now - l["ts"] < 600:
                once("guardresume:%d" % int(l["ts"]), f"▶️ <b>Worker resumed</b> at {hm(l['ts'])} ({l['msg']})")
    # 3b. a release the daemon refused to install (bad archive, unexpected file…) — it stays on its build and retries every 5 min
    if ev.get("worker"):
        for h in ((d.get("updates") or {}).get("history") or [])[:6]:
            if h.get("action") == "failed" and now - (h.get("ts") or 0) < 3 * 3600:
                once("updfail:" + (h.get("note") or "")[:60], f"⚠️ <b>Worker update failed</b> · {h.get('note') or ''} — still on {((d.get('updates') or {}).get('installed') or {}).get('build') or '?'}", 24 * 3600)
    # 4. heartbeat / worker state
    la = d.get("lastAlive"); w = host.get("worker") or {}
    if ev.get("heartbeat") and la and now - la["ts"] > c["heartbeatMin"] * 60 and w.get("ActiveState") == "active":
        once("heartbeat", f"💤 <b>No worker heartbeat</b> for {int((now - la['ts']) / 60)} min (service is active — check journal)", 2 * 3600)
    if ev.get("worker") and w.get("ActiveState") not in ("active", None) and not guard_state.get("paused"):
        once("worker:" + w.get("ActiveState", "?"), f"🛑 <b>Worker service is {w.get('ActiveState')}</b> ({w.get('NRestarts','?')} restarts)", 2 * 3600)
    # 5. rejected verdicts
    if ev.get("rejected"):
        for t in d.get("tasks", []):
            if t.get("verdict") in ("rejected", "failed") and now - t.get("acceptedAt", 0) < 48 * 3600:
                why = (t.get("reason") or {}).get("reason") or ""
                head = "❌ <b>Rejected</b>" if t["verdict"] == "rejected" else "💥 <b>Failed on the network</b>"
                once("rejected:" + t["id"], f"{head} {t['id']} · {t.get('kindLabel') or t.get('kind') or ''} · {t.get('model') or '?'} {t.get('effort') or ''} · {(t.get('title') or '')[:120]}{chr(10) + why[:200] if why else ''}\n{t.get('jobUrl') or ''}", 10 ** 9)
    # 5b. the network's view of this seat: dispatch pause / breaker, failures it recorded, stale presence
    stg = d.get("standing") or {}; ss = stg.get("standing") or {}; pr = stg.get("presence") or {}
    if ev.get("standing") and isinstance(ss, dict):
        pu = ss.get("pausedUntil")
        if pu:
            once("standing-paused:" + str(pu), f"⛔ <b>Dispatch paused by the network</b> until {str(pu).replace('T', ' ')[:16]} UTC — {ss.get('consecutiveFailures', '?')} consecutive failures (breaker {((ss.get('breaker') or {}).get('failures'))} → {int(((ss.get('breaker') or {}).get('cooldownMs') or 0) / 60000)} min)", 10 ** 9)
        for f in ss.get("recentFailures") or []:
            try:
                at = time.mktime(time.strptime(str(f.get("at"))[:19], "%Y-%m-%dT%H:%M:%S")) - time.timezone
            except (ValueError, TypeError):
                at = 0
            if now - at < 3600:
                once("netfail:" + str(f.get("at")), f"⚠️ <b>Failure recorded by the network</b>: {f.get('reason')} · {f.get('nodeKey') or ''} · job {str(f.get('jobId') or '')[:8]}\nhttps://explorer.imd.fun/jobs/{f.get('jobId') or ''}", 10 ** 9)
        if pr.get("connected") is False and (host.get("worker") or {}).get("ActiveState") == "active" and not guard_state.get("paused"):
            once("standing-offline", "🔌 <b>Seat not connected</b> according to api.imd.fun while the service is active (last seen " + str(pr.get("lastHeartbeatAt") or "?")[:16].replace("T", " ") + ")", 2 * 3600)
    # 6. disk
    disk = host.get("disk") or {}
    if ev.get("disk") and disk.get("free") and disk["free"] < c["diskGB"] * 1024 ** 3:
        once("disk", f"💽 <b>Low disk</b>: {disk['free'] / 1024**3:.1f} GB free", 24 * 3600)
    # 7. daily digest
    if ev.get("daily"):
        g = time.gmtime(now)
        if g.tm_hour == c["dailyHourUTC"] and now - st.get("lastDaily", 0) > 20 * 3600:
            day0 = now - 86400; T = [t for t in d.get("tasks", []) if t.get("acceptedAt", 0) >= day0 and t.get("status") != "no-journal"]
            acc = sum(1 for t in T if t.get("verdict") == "accepted"); rej = sum(1 for t in T if t.get("verdict") == "rejected")
            cost = sum(t.get("costUSD", 0) for t in T); out_tok = sum(t.get("usage", {}).get("output_tokens", 0) for t in T)
            lim = sum(l["hits"] for l in d.get("limitMsgs", []) if l["ts"] >= day0)
            ex = (d.get("explorer") or {}).get("agent") or {}; rec = (d.get("seat") or {}).get("record") or {}; fl = d.get("fleet") or {}
            out.append(f"📊 <b>IMD daily</b> — {len(T)} tasks · {sum(1 for t in T if t.get('submittedAt'))} submitted · {acc} ✓ {rej} ✗ · ${cost:.0f} API-equiv · {out_tok/1e6:.2f}M out · {lim} limit errors\nseat {rec.get('accepted', ex.get('accepted', '?'))}/{rec.get('attempts', ex.get('attempts', '?'))} accepted all-time · {rec.get('pending', '?')} pending · rank #{fl.get('rank', '?')} of {fl.get('contributors', '?')} contributors")
            st["lastDaily"] = now
    save_state(st)
    for text in out:
        send(text, c)
