"""Telegram bot: the notifier's channel made two-way. The panel long-polls getUpdates (the VPS opens no port; the
bot never sees the panel's address) and answers commands from the one chat in notify.json — any other chat is
ignored, except that an unbound bot tells a chat its own id so it can be pasted into Settings. Actions reuse the
dashboard's own handlers (act_config, act_worker, …); anything that stops, restarts or updates asks for a tap on
a confirm button first, and a command older than two minutes (queued while the panel was down) is dropped."""
import html, json, os, sys, threading, time, urllib.error, urllib.parse, urllib.request

from . import collect, notify, earnings
from .paths import state

STATE = state("telegram.state.json")  # the getUpdates offset, so a restart never replays an old /restart
MAX_AGE = 120
MODEL_ALIASES = {"sonnet": "claude-sonnet-5", "opus": "claude-opus-5-5", "opus5": "claude-opus-5", "haiku": "claude-haiku-4-5-20251001", "fable": "claude-fable-5-1"}
S = None  # the server module (data(), the act_* handlers, guard/smart state), set by start()
_log = lambda m: sys.stderr.write("telegram: %s\n" % m)
_pending = {}  # confirm token -> (expires, label, fn)


# ---------------------------------------------------------------- Bot API
def api(token, method, http_timeout=35, **params):
    body = json.dumps(params).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/{method}", data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=http_timeout) as r:
        out = json.loads(r.read().decode())
    if not out.get("ok"):
        raise RuntimeError(out.get("description") or method)
    return out.get("result")


def send(text, keyboard=None, chat=None, c=None):
    c = c or notify.cfg(); chat = chat or c.get("telegramChatId")
    if not (c.get("telegramToken") and chat):
        return None
    params = {"chat_id": chat, "text": text[:4000], "parse_mode": "HTML", "disable_web_page_preview": True}
    if keyboard:
        params["reply_markup"] = {"inline_keyboard": keyboard}
    try:
        return api(c["telegramToken"], "sendMessage", **params)
    except Exception as e:
        _log("send failed: %s" % str(e)[:160])
        try:  # a formatting slip must not swallow the message: retry as plain text
            return api(c["telegramToken"], "sendMessage", chat_id=chat, text=html.unescape(text).replace("<b>", "").replace("</b>", "")[:4000])
        except Exception as e2:
            _log("plain send failed: %s" % str(e2)[:160])
    return None


# ---------------------------------------------------------------- formatting helpers
E = lambda s: html.escape(str(s if s is not None else ""), quote=False)
B = lambda s: "<b>%s</b>" % E(s)
C = lambda s: "<code>%s</code>" % E(s)


def hm(ts):
    return time.strftime("%H:%M", time.gmtime(ts)) + " UTC" if ts else "?"


def ago(ts):
    if not ts: return "?"
    s = int(time.time() - ts)
    return "%ds" % s if s < 60 else "%dm" % (s // 60) if s < 3600 else "%dh%02dm" % (s // 3600, s % 3600 // 60) if s < 86400 else "%dd%dh" % (s // 86400, s % 86400 // 3600)


def dur(s):
    s = int(s or 0)
    return "%ds" % s if s < 60 else "%dm" % (s // 60) if s < 3600 else "%dh%02dm" % (s // 3600, s % 3600 // 60)


def short_model(m, effort=None):
    m = {"claude-fable-5-1": "Fable", "claude-opus-5-5": "Opus 5.5", "claude-opus-5": "Opus 5", "claude-sonnet-5": "Sonnet 5", "claude-haiku-4-5-20251001": "Haiku"}.get(m, m or "?")
    return m + (" " + effort if effort else "")


def usd(v):
    return "$%.2f" % v if v is not None else "?"


def tier_line(name, t):
    return "%s %s" % (name, short_model(t.get("model"), t.get("effort"))) if t else "%s worker default" % name


def D():
    return json.loads(S.data())


# ---------------------------------------------------------------- read-only views
def v_status(d):
    w = (d.get("host") or {}).get("worker") or {}; st = d.get("standing") or {}; pr = st.get("presence") or {}; q = st.get("queue") or {}
    rec = (d.get("seat") or {}).get("record") or {}; fl = d.get("fleet") or {}; la = d.get("lastAlive") or {}
    g = d.get("guard") or {}; gs = g.get("state") or {}; sm = (d.get("smart") or {}); ss = sm.get("state") or {}
    u = d.get("usage") or {}; fh = u.get("fiveHour") or {}; sd = u.get("sevenDay") or {}
    scoped = next((l for l in u.get("limits") or [] if l.get("kind") == "weekly_scoped"), None)
    tiers = (d.get("effective") or {}).get("tiers") or {}
    run = d.get("running") or []
    lines = ["%s %s · seat %s · %s" % ("🟢" if w.get("ActiveState") == "active" else "🔴", B("worker " + str(w.get("ActiveState") or "?")), E(d.get("config", {}).get("tokenId") or "?"), "connected" if pr.get("connected") else "NOT connected")]
    if gs.get("paused"):
        lines.append("⏸ guard paused: %s · resumes %s" % (E(gs.get("reason") or ""), hm(gs.get("resumeAt")) if gs.get("resumeAt") else "manually"))
    lines.append("heartbeat %s ago · %s · running %d/%s" % (ago(la.get("ts")), E(la.get("state") or "?"), len(run), d.get("config", {}).get("maxConcurrency") or "?"))
    for t in run:
        lines.append("  ▸ %s · %s · %s · %s turns · %s" % (E(t.get("kindLabel") or t.get("kind") or "task"), short_model(t.get("model"), t.get("effort")), dur(t.get("elapsedS")), t.get("turns"), E((t.get("title") or "")[:60])))
    lines.append("record %s ✓ · %s ✗ · %s pending · rank #%s of %s" % (rec.get("accepted", "?"), rec.get("rejected", "?"), rec.get("pending", "?"), fl.get("rank", "?"), fl.get("contributors") or "?"))
    lines.append("fleet %s online · queue %s ready · network standing: %s failures" % (q.get("fleetOnline", "?"), q.get("ready", "?"), (st.get("standing") or {}).get("consecutiveFailures", "?")))
    lines.append("usage 5h %s%% · 7d %s%% · Fable %s%%%s" % (fh.get("pct", "?"), sd.get("pct", "?"), scoped.get("pct", "?") if scoped else "?", " (resets %s)" % hm(scoped["resetsAt"]) if scoped and scoped.get("resetsAt") else ""))
    lines.append("tiers: " + " · ".join(tier_line(k, tiers.get(k)) for k in ("economy", "standard", "premium")))
    if sm.get("config", {}).get("enabled"):
        lines.append("smart premium: %s%s" % (E(ss.get("mode") or "?"), " · " + E(ss.get("reason")) if ss.get("reason") else ""))
    up = d.get("updates") or {}; cc = d.get("claudeCode") or {}
    lines.append("worker %s%s · Claude Code %s%s" % (E((up.get("installed") or {}).get("build") or "?"), " ⬆️" if up.get("available") else "", E((cc.get("installed") or {}).get("version") or "?"), " ⬆️" if cc.get("available") else ""))
    return "\n".join(lines)


def v_tasks(d, n=8):
    T = [t for t in d.get("tasks") or [] if t.get("status") != "no-journal" and t.get("kind") not in ("doctor", "untracked")]
    T.sort(key=lambda t: -(t.get("acceptedAt") or 0))
    out = [B("last %d tasks" % min(n, len(T)))]
    for t in T[:n]:
        v = t.get("verdict") or ("running" if not t.get("submittedAt") and t.get("status") == "accepted" else t.get("status") or "?")
        mark = {"accepted": "✅", "rejected": "❌", "failed": "💥", "running": "⏳", "rate-limited": "🚦"}.get(v, "⏳" if v in ("submitted", "pending") else "•")
        out.append("%s %s · %s · %s · %s · %s · %s" % (mark, hm(t.get("acceptedAt")), E(t.get("kindLabel") or t.get("kind") or ""), short_model(t.get("model"), t.get("effort")), usd(t.get("costUSD")), dur(t.get("durationS")), E((t.get("title") or "")[:70])))
    day0 = time.time() - 86400; T24 = [t for t in T if (t.get("acceptedAt") or 0) >= day0]
    out.append("\n24h: %d tasks · %d ✓ · %d ✗ · %s API-eq" % (len(T24), sum(1 for t in T24 if t.get("verdict") == "accepted"), sum(1 for t in T24 if t.get("verdict") in ("rejected", "failed")), usd(sum(t.get("costUSD") or 0 for t in T24))))
    return "\n".join(out)


def v_usage(d):
    u = d.get("usage") or {}; g = (d.get("guard") or {}); gc = g.get("config") or {}; gs = g.get("state") or {}
    out = [B("Claude usage")]
    for l in u.get("limits") or []:
        name = {"session": "5-hour window", "weekly_all": "7-day, all models", "weekly_scoped": "7-day, Fable"}.get(l.get("kind"), l.get("kind"))
        out.append("%s %s: %s%% · resets %s" % ("🔴" if (l.get("pct") or 0) >= 100 else "🟡" if (l.get("pct") or 0) >= gc.get("sessionPct", 101) else "🟢", E(name), l.get("pct", "?"), hm(l.get("resetsAt"))))
    if u.get("fetchedAt"): out.append("read %s ago" % ago(u["fetchedAt"]))
    out.append("\n%s pause at %s%% of the 5h window%s · today %s API-eq · window %s tokens" % (B("guard"), gc.get("sessionPct"), "" if gc.get("enabled") else " (OFF)", usd(gs.get("daily")), gs.get("tokens", "?")))
    sm = d.get("smart") or {}; ss = sm.get("state") or {}
    out.append("%s %s · mode %s · Fable %s%%" % (B("smart premium"), "on" if sm.get("config", {}).get("enabled") else "off", E(ss.get("mode") or "-"), ss.get("fablePct", "?")))
    return "\n".join(out)


def v_tiers(d):
    tiers = (d.get("effective") or {}).get("tiers") or {}
    out = [B("tiers in force")]
    for k in ("economy", "standard", "premium"):
        t = tiers.get(k) or {}
        out.append("• %s · source %s%s" % (tier_line(k, t), E(t.get("source") or "?"), " · " + E(t["note"]) if t.get("note") else ""))
    sm = d.get("smart") or {}
    out.append("smart premium %s (fallback %s)" % ("ON" if sm.get("config", {}).get("enabled") else "off", short_model((sm.get("config", {}).get("fallback") or {}).get("model"), (sm.get("config", {}).get("fallback") or {}).get("effort"))))
    out.append("concurrency %s" % (d.get("config") or {}).get("maxConcurrency"))
    out.append("\n/premium fable|opus|default|off · /smart on|off · /tier economy sonnet low · /concurrency 2")
    return "\n".join(out)


def v_earnings():
    e = earnings.data()
    if e.get("error"):
        return "earnings: " + E(e["error"])
    p = e.get("prices") or {}; t = e.get("totals") or {}; a = e.get("adam") or {}
    out = [B("earnings") + " · wallet " + C((e.get("wallet") or "")[:10] + "…")]
    out.append("IMD %s · ETH %s" % ("$%.4f" % p["imdUsd"] if p.get("imdUsd") else "?", "$%.0f" % p["ethUsd"] if p.get("ethUsd") else "?"))
    out.append("IMD payouts received: %.2f IMD%s" % (t.get("payoutsImd") or 0, " (≈ $%.2f)" % (t["payoutsImd"] * p["imdUsd"]) if p.get("imdUsd") and t.get("payoutsImd") else ""))
    out.append("launch rewards: %d claimable (≈ $%.2f) · claimed ≈ $%.2f · held ≈ $%.2f" % (t.get("claimable") or 0, t.get("claimableUsd") or 0, t.get("claimedUsd") or 0, t.get("heldUsd") or 0))
    if a:
        out.append("ADAM: %.0f claimable · %.0f claimed · %.0f balance · tranche %s/10%s" % (a.get("claimable") or 0, a.get("claimed") or 0, a.get("balance") or 0, a.get("tranches", "?"), " · next unlock %s" % hm(a["nextUnlock"]) if a.get("nextUnlock") else ""))
    items = e.get("items") or []
    live = [x for x in items if x.get("status") == "claimable" and (x.get("valueUsd") or 0) > 0.5]
    if live:
        out.append("\n" + B("worth claiming"))
        for x in sorted(live, key=lambda x: -(x.get("valueUsd") or 0))[:6]:
            out.append("• #%s %s · %.0f %s ≈ $%.2f · gas ≈ $%.2f" % (x.get("launchNumber"), E((x.get("token") or {}).get("symbol")), x.get("amount") or 0, E((x.get("token") or {}).get("symbol")), x.get("valueUsd") or 0, x.get("gasUsd") or 0))
    out.append("\nlast launches:")
    for x in items[:5]:
        out.append("• #%s %s · %s · %s%s" % (x.get("launchNumber"), E((x.get("token") or {}).get("symbol")), E((x.get("chain") or {}).get("name")), E(x.get("status")), " ≈ $%.2f" % x["valueUsd"] if x.get("valueUsd") else ""))
    if e.get("pending"): out.append("(%d launch(es) still loading)" % e["pending"])
    if e.get("errors"): out.append("⚠️ " + E("; ".join(e["errors"])[:200]))
    out.append("claims are signed from the panel's Earnings tab (the bot holds no key)")
    return "\n".join(out)


def v_system(d):
    h = d.get("host") or {}; sy = d.get("system") or {}; disk = h.get("disk") or {}; mem = h.get("mem") or {}; w = h.get("worker") or {}
    out = [B("VPS") + " " + E(d.get("hostName") or "")]
    out.append("%s · kernel %s · up %s" % (E(sy.get("os") or "?"), E(sy.get("kernel") or "?"), dur(h.get("uptimeS"))))
    out.append("load %s · mem %.1f/%.1f GB free · disk %.0f/%.0f GB free" % (" ".join("%.2f" % x for x in h.get("load") or []), (mem.get("available") or 0) / 1e9, (mem.get("total") or 0) / 1e9, (disk.get("free") or 0) / 1e9, (disk.get("total") or 0) / 1e9))
    out.append("worker RSS %.0f MB (peak %.0f, cap %s) · work %.1f GB · transcripts %.1f GB" % (int(w.get("MemoryCurrent") or 0) / 1e6, int(w.get("MemoryPeak") or 0) / 1e6, (("%.0fG" % (int(w["MemoryMax"]) / 2**30)) if str(w.get("MemoryMax") or "").isdigit() and int(w["MemoryMax"]) < 2**62 else "none"), (h.get("workBytes") or 0) / 1e9, (h.get("transcriptBytes") or 0) / 1e9))
    up = sy.get("upgradable") or []
    out.append("OS updates: %s · reboot %s" % ("%d pending" % len(up) if up else "none pending", "REQUIRED (%s)" % E(", ".join(sy.get("rebootPkgs") or [])) if sy.get("rebootRequired") else "not needed"))
    ir = sy.get("idleReboot") or {}
    if ir.get("decision"): out.append("idle reboot: %s" % E(ir["decision"]))
    u = d.get("updates") or {}; cc = d.get("claudeCode") or {}
    out.append("worker %s (latest %s, auto %s) · Claude Code %s (latest %s, auto %s)" % (E((u.get("installed") or {}).get("build") or "?"), E((u.get("latest") or {}).get("build") or "?"), "on" if u.get("autoUpdate") else "off", E((cc.get("installed") or {}).get("version") or "?"), E(cc.get("target") or "?"), "on" if cc.get("auto") else "off"))
    return "\n".join(out)


def v_fleet(d):
    f = d.get("fleet") or {}; o = f.get("ours") or {}; m = f.get("median") or {}; n = d.get("network") or {}
    out = [B("fleet") + " · rank #%s of %s contributors" % (f.get("rank", "?"), f.get("contributors") or "?")]
    if o:
        out.append("ours: %s/%s accepted · %s%% · %s turns/task · %s min/task" % (o.get("accepted"), o.get("attempts"), o.get("acceptRate"), o.get("turnsPerAccepted"), o.get("minPerAccepted")))
    out.append("median peer: %s%% · %s turns/task · %s min/task" % (m.get("acceptRate"), m.get("turnsPerAccepted"), m.get("minPerAccepted")))
    for i, t in enumerate((f.get("top") or [])[:3]):
        out.append("#%d seat %s · %s accepted" % (i + 1, t.get("tokenId"), t.get("accepted")))
    out.append("\n%s %s online · %s working now · %s accepted/day · %s enrolled" % (B("network"), n.get("connectedDaemons", "?"), n.get("workingNow", "?"), n.get("acceptedLastDay", "?"), n.get("activeEnrollments", "?")))
    pend = n.get("pending") or {}
    if pend: out.append("pending: " + ", ".join("%s %s" % (v, k) for k, v in pend.items() if v))
    return "\n".join(out)


def v_log(d, n=12):
    ev = (d.get("events") or [])[-n:]
    out = [B("worker log")] + ["%s %s" % (hm(e.get("ts")), E((e.get("msg") or "")[:110])) for e in reversed(ev)]
    gl = ((d.get("guard") or {}).get("state") or {}).get("log") or []
    if gl: out += ["", B("panel")] + ["%s %s" % (hm(l["ts"]), E(l["msg"][:110])) for l in reversed(gl[-5:])]
    return "\n".join(out)


def v_notify():
    c = notify.cfg(); ev = c["events"]
    return B("notifications") + "\n" + "\n".join("%s %s" % ("🔔" if v else "🔕", k) for k, v in ev.items()) + "\n\n/notify &lt;event&gt; on|off"


# ---------------------------------------------------------------- keyboards
MENU = [[{"text": "📊 status", "callback_data": "status"}, {"text": "🧾 tasks", "callback_data": "tasks"}, {"text": "💰 earnings", "callback_data": "earnings"}],
        [{"text": "📈 usage", "callback_data": "usage"}, {"text": "🎚 tiers", "callback_data": "tiers"}, {"text": "🖥 system", "callback_data": "system"}],
        [{"text": "🌐 fleet", "callback_data": "fleet"}, {"text": "📜 log", "callback_data": "log"}, {"text": "⚙️ worker", "callback_data": "workermenu"}]]
WORKER_MENU = [[{"text": "🔄 restart", "callback_data": "ask:restart"}, {"text": "⏸ stop", "callback_data": "ask:stop"}, {"text": "▶️ start", "callback_data": "start"}],
               [{"text": "⬆️ update worker", "callback_data": "ask:update"}, {"text": "⬆️ update Claude Code", "callback_data": "ask:claude"}, {"text": "🩺 doctor", "callback_data": "doctor"}],
               [{"text": "◀️ menu", "callback_data": "menu"}]]
PREMIUM_MENU = [[{"text": "Fable (default)", "callback_data": "premium:default"}, {"text": "Opus 5.5 high", "callback_data": "premium:opus"}, {"text": "opt out", "callback_data": "premium:off"}],
                [{"text": "smart on", "callback_data": "smart:on"}, {"text": "smart off", "callback_data": "smart:off"}, {"text": "◀️ menu", "callback_data": "menu"}]]
HELP = """<b>imd-panel bot</b>
/status · /tasks [n] · /earnings · /usage · /tiers · /system · /fleet · /log · /menu
/premium fable|opus|default|off — the premium tier (an approved model, or opt out)
/smart on|off — Fable while its weekly meter lasts, Opus 5.5 after
/tier economy|standard &lt;sonnet|opus|opus5|haiku&gt; [low|medium|high] — the other tiers
/concurrency 1-4 · /guard &lt;pct&gt;|on|off — budget guard
/restart · /stop · /start — the worker (restart/stop ask to confirm)
/update · /claude — install the latest worker / Claude Code (confirm)
/doctor — imd doctor (takes a minute) · /notify [event on|off]"""


# ---------------------------------------------------------------- actions
def confirm(label, fn):
    tok = "%x" % int(time.time() * 1000)
    _pending[tok] = (time.time() + 300, label, fn)
    for k in [k for k, v in _pending.items() if v[0] < time.time()]:
        _pending.pop(k, None)
    return "⚠️ %s — confirm?" % E(label), [[{"text": "✅ yes, " + label[:30], "callback_data": "ok:" + tok}, {"text": "✖️ cancel", "callback_data": "menu"}]]


def restart_needed(res):
    return "\nthe worker reads config.json at start: /restart when it is idle (or the smart premium / guard restart will pick it up)" if res.get("restartNeeded") else ""


def a_premium(arg):
    arg = (arg or "").lower()
    if arg in ("fable", "default", ""):
        choice = {"model": collect.PREMIUM_MODEL, "effort": "high"} if arg == "fable" else None
    elif arg in ("opus", "opus5.5"):
        choice = {"model": "claude-opus-5-5", "effort": "high"}
    elif arg in ("off", "optout", "opt-out"):
        choice = collect.PREMIUM_OPT_OUT
    else:
        return "usage: /premium fable|opus|default|off", PREMIUM_MENU
    if S.smart_cfg()["enabled"] and arg not in ("off",):
        return "smart premium is on and owns the premium tier — /smart off first, or leave it to the meter", PREMIUM_MENU
    with open(collect.CONFIG) as fh:
        inf = (json.load(fh).get("inference") or {})
    inf = {k: v for k, v in inf.items() if k != "premium"}
    if choice is not None:
        inf["premium"] = {"claude": choice}
    res = S.act_config({"inference": inf})
    return "premium → %s%s" % (short_model(choice["model"], choice["effort"]) if choice and choice != collect.PREMIUM_OPT_OUT else "opted out" if choice else "Fable (worker default)", restart_needed(res)), None


def a_smart(arg):
    on = (arg or "").lower() in ("on", "1", "yes")
    if (arg or "").lower() not in ("on", "off", "1", "0", "yes", "no"):
        return "usage: /smart on|off", PREMIUM_MENU
    S.act_config({"premiumSmart": on})
    return "smart premium %s" % ("ON — Fable while the weekly meter lasts, Opus 5.5 high after" if on else "off — the premium tier stays as set"), None


def a_tier(args):
    p = (args or "").split()
    if len(p) < 2 or p[0] not in ("economy", "standard"):
        return "usage: /tier economy|standard sonnet|opus|opus5|haiku [low|medium|high]", None
    model = MODEL_ALIASES.get(p[1], p[1]); effort = p[2] if len(p) > 2 else None
    with open(collect.CONFIG) as fh:
        inf = (json.load(fh).get("inference") or {})
    inf[p[0]] = {"claude": {"model": model, **({"effort": effort} if effort else {})}}
    res = S.act_config({"inference": inf})
    return "%s → %s%s" % (p[0], short_model(model, effort), restart_needed(res)), None


def a_concurrency(arg):
    try:
        n = int(arg)
    except (TypeError, ValueError):
        return "usage: /concurrency 1-4", None
    res = S.act_config({"maxConcurrency": n})
    return "concurrency → %d%s" % (n, restart_needed(res)), None


def a_guard(arg):
    a = (arg or "").lower()
    if not a:
        return v_usage(D()), None
    if a in ("on", "off"):
        S.act_guard({"enabled": a == "on"}); return "guard %s" % a, None
    try:
        S.act_guard({"sessionPct": int(a)}); return "guard pauses the worker at %d%% of the 5h window" % int(a), None
    except ValueError as e:
        return "usage: /guard &lt;pct&gt;|on|off (%s)" % E(e), None


def a_worker(action):
    res = S.act_worker({"action": action})
    return "worker %s → %s" % (action, E(res.get("state")))


def a_update():
    res = S.act_update({"action": "update"})
    return "worker: %s → %s%s" % (E(res.get("from") or res.get("before") or "?"), E(res.get("to") or res.get("after") or "?"), "" if res.get("changed", True) else " (already latest)")


def a_claude():
    res = S.act_claude({"action": "update"})
    return "Claude Code: %s → %s%s" % (E(res.get("from")), E(res.get("to")), "" if res.get("changed") else " (already latest)")


def a_doctor():
    res = S.act_doctor({})
    out = res.get("output") or ""
    keep = [l for l in out.splitlines() if l.strip().startswith(("✓", "✗", "→", "!", "the network", "everything"))]
    return "🩺 " + B("imd doctor") + " (%.0fs)\n" % res.get("took", 0) + C("\n".join(keep or out.splitlines()[-25:])[:3500])


def a_notify(args):
    p = (args or "").split()
    if len(p) != 2 or p[1] not in ("on", "off"):
        return v_notify()
    c = notify.cfg()
    if p[0] not in c["events"]:
        return "unknown event %s\n%s" % (E(p[0]), v_notify())
    c["events"][p[0]] = p[1] == "on"; notify.save(c)
    return "%s %s" % (p[0], p[1])


def slow(chat, label, fn):
    """Run a long action (doctor, updates) off the poll thread and report when done."""
    send("⏳ %s…" % label, chat=chat)
    def go():
        try:
            send(fn(), chat=chat, keyboard=MENU)
        except Exception as e:
            send("💥 %s failed: %s" % (label, E(str(e)[:300])), chat=chat)
    threading.Thread(target=go, daemon=True).start()


# ---------------------------------------------------------------- dispatch
def handle(cmd, arg, chat):
    """One command or callback -> (text, keyboard). Confirmed actions come back through 'ok:<token>'."""
    cmd = cmd.lower().lstrip("/").split("@")[0]
    if cmd in ("start", "help"): return HELP, MENU
    if cmd == "menu": return B("imd-panel"), MENU
    if cmd == "workermenu": return B("worker"), WORKER_MENU
    if cmd == "status": return v_status(D()), MENU
    if cmd == "tasks": return v_tasks(D(), max(1, min(int(arg), 30)) if (arg or "").isdigit() else 8), MENU
    if cmd == "usage": return v_usage(D()), MENU
    if cmd == "tiers": return v_tiers(D()), PREMIUM_MENU
    if cmd == "system": return v_system(D()), MENU
    if cmd == "fleet": return v_fleet(D()), MENU
    if cmd == "log": return v_log(D()), MENU
    if cmd == "earnings": slow(chat, "reading the chain", v_earnings); return None, None
    if cmd == "doctor": slow(chat, "running imd doctor", a_doctor); return None, None
    if cmd == "premium":
        if arg: return a_premium(arg)
        return v_tiers(D()), PREMIUM_MENU
    if cmd == "smart": return a_smart(arg)
    if cmd == "tier": return a_tier(arg)
    if cmd == "concurrency": return a_concurrency(arg)
    if cmd == "guard": return a_guard(arg)
    if cmd == "notify": return a_notify(arg), None
    if cmd == "start_worker" or cmd == "resume": return a_worker("start"), MENU
    if cmd in ("restart", "stop"): return confirm("%s the worker" % cmd, lambda: a_worker(cmd))
    if cmd == "update": return confirm("install the latest worker release", a_update)
    if cmd == "claude": return confirm("update Claude Code", a_claude)
    if cmd.startswith("ask:"):
        what = cmd[4:]
        return {"restart": lambda: confirm("restart the worker", lambda: a_worker("restart")), "stop": lambda: confirm("stop the worker", lambda: a_worker("stop")),
                "update": lambda: confirm("install the latest worker release", a_update), "claude": lambda: confirm("update Claude Code", a_claude)}.get(what, lambda: ("?", MENU))()
    if cmd.startswith("ok:"):
        p = _pending.pop(cmd[3:], None)
        if not p or p[0] < time.time(): return "that confirmation expired — ask again", MENU
        if p[2] in (a_update, a_claude): slow(chat, p[1], p[2]); return None, None
        return p[2](), MENU
    if cmd.startswith("premium:"): return a_premium(cmd[8:])
    if cmd.startswith("smart:"): return a_smart(cmd[6:])
    return "unknown command — /help", MENU


def on_update(u, c):
    chat_ok = str(c.get("telegramChatId") or "")
    msg = u.get("message") or u.get("edited_message"); cb = u.get("callback_query")
    if cb:
        chat = str(((cb.get("message") or {}).get("chat") or {}).get("id") or "")
        try: api(c["telegramToken"], "answerCallbackQuery", callback_query_id=cb["id"])
        except Exception: pass
        if chat != chat_ok:
            _log("callback from chat %s ignored" % chat); return
        cmd, arg = cb.get("data") or "", ""
    elif msg:
        chat = str((msg.get("chat") or {}).get("id") or "")
        if time.time() - (msg.get("date") or 0) > MAX_AGE:
            return  # queued while the panel was down
        text = (msg.get("text") or "").strip()
        if not chat_ok:
            send("this chat's id is <code>%s</code> — paste it into the panel's Settings → notifications to bind this bot" % E(chat), chat=chat, c=c); return
        if chat != chat_ok:
            _log("message from chat %s ignored" % chat); return
        if not text.startswith("/"):
            cmd, arg = "menu", ""
        else:
            parts = text.split(None, 1); cmd, arg = parts[0], (parts[1] if len(parts) > 1 else "")
    else:
        return
    # callbacks ("status") and typed commands ("/status") take the same path; "start" from a tap means start the worker
    if cb and cmd == "start": cmd = "start_worker"
    try:
        text, kb = handle(cmd, arg, chat)
    except Exception as e:
        text, kb = "💥 %s" % E(str(e)[:400]), MENU
    if text:
        send(text, keyboard=kb, chat=chat, c=c)


def load_offset():
    try:
        with open(STATE) as fh: return int(json.load(fh).get("offset") or 0)
    except (OSError, ValueError): return 0


def save_offset(o):
    tmp = STATE + ".tmp"
    with open(tmp, "w") as fh: json.dump({"offset": o}, fh)
    os.replace(tmp, STATE)


def loop():
    offset = load_offset(); announced = None
    while True:
        c = notify.cfg(); tok = c.get("telegramToken")
        if not tok:
            time.sleep(30); continue
        try:
            if announced != tok:  # the command list under the "/" button, once per token
                api(tok, "setMyCommands", commands=[{"command": k, "description": v} for k, v in COMMANDS])
                announced = tok
            for u in api(tok, "getUpdates", http_timeout=40, offset=offset, timeout=30, allowed_updates=["message", "callback_query"]) or []:
                offset = u["update_id"] + 1; save_offset(offset)
                try:
                    on_update(u, c)
                except Exception as e:
                    _log("update %s failed: %s" % (u.get("update_id"), str(e)[:200]))
        except urllib.error.HTTPError as e:
            _log("HTTP %s: %s" % (e.code, (e.read() or b"")[:160])); time.sleep(60 if e.code in (401, 404, 409) else 10)
        except Exception as e:
            _log(str(e)[:200]); time.sleep(10)


COMMANDS = [("status", "worker, seat, usage, tiers at a glance"), ("tasks", "last tasks and their verdicts"), ("earnings", "IMD payouts, launch rewards, ADAM"),
            ("usage", "Claude meters and the budget guard"), ("tiers", "models per tier, smart premium"), ("premium", "fable | opus | default | off"),
            ("smart", "smart premium on | off"), ("system", "VPS, updates, memory, disk"), ("fleet", "rank and the network"), ("log", "last worker events"),
            ("restart", "restart the worker (confirm)"), ("stop", "stop the worker (confirm)"), ("resume", "start the worker"), ("update", "install the latest worker release"),
            ("claude", "update Claude Code"), ("doctor", "run imd doctor"), ("guard", "pause threshold, on | off"), ("concurrency", "tasks at once, 1-4"),
            ("tier", "economy | standard model and effort"), ("notify", "event toggles"), ("menu", "buttons"), ("help", "all commands")]


def start(server):
    global S
    S = server
    threading.Thread(target=loop, daemon=True, name="telegram").start()
