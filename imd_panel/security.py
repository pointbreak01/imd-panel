"""What keeps a task from turning against the machine: the panel's API token, and the Claude Code hook (imd-task-guard)
that blocks hostile tool calls inside every task. Read-only here except for the token file."""
import hashlib, hmac, json, os, secrets, shutil, time
from .paths import HERE, state

HOME = os.path.expanduser("~")
TOKEN_FILE = state("token")
HOOK_SRC = os.path.join(os.path.dirname(HERE), "system", "imd-task-guard.py")  # the copy that ships with the code
HOOK_BIN = os.path.join(HOME, ".local", "bin", "imd-task-guard")                # the copy Claude Code runs
BLOCKED = os.path.join(HOME, ".local", "state", "imd-task-guard", "blocked.jsonl")
SETTINGS = os.path.join(HOME, ".claude", "settings.json")
CLAUDE_MD = os.path.join(HOME, ".claude", "CLAUDE.md")
MARKER = "imd-task-guard"  # the installer's paragraph in CLAUDE.md names the hook


def token():
    """The API token: created on first use (32 url-safe bytes, file mode 600), rotated with new_token()."""
    try:
        with open(TOKEN_FILE) as fh:
            t = fh.read().strip()
        if len(t) >= 32:
            return t
    except OSError:
        pass
    return new_token()


def new_token():
    t = secrets.token_urlsafe(32)
    tmp = TOKEN_FILE + ".tmp"
    with open(tmp, "w") as fh:
        fh.write(t + "\n")
    os.chmod(tmp, 0o600); os.replace(tmp, TOKEN_FILE)
    return t


def token_ok(given):
    return bool(given) and hmac.compare_digest(str(given).strip(), token())


def _sha(path):
    try:
        with open(path, "rb") as fh:
            return hashlib.sha256(fh.read()).hexdigest()
    except OSError:
        return None


def blocked(limit=50):
    """The hook's log, newest first, plus counts (all time, last 24 h)."""
    out = []; total = 0; day = 0; now = time.time()
    try:
        with open(BLOCKED, "rb") as fh:
            fh.seek(0, 2); size = fh.tell(); fh.seek(max(0, size - 512 * 1024))  # the tail is enough for the table
            lines = fh.read().decode("utf-8", "replace").splitlines()
        if size > 512 * 1024:
            lines = lines[1:]
        for ln in lines:
            try:
                r = json.loads(ln)
            except ValueError:
                continue
            total += 1
            if now - (r.get("ts") or 0) < 86400:
                day += 1
            out.append(r)
    except OSError:
        pass
    out.sort(key=lambda r: r.get("ts") or 0, reverse=True)
    return {"recent": out[:limit], "total": total, "day": day}


def status():
    """Hook installed and current? Named in settings.json? Deny rules there? The CLAUDE.md paragraph in place?"""
    src, binh = _sha(HOOK_SRC), _sha(HOOK_BIN)
    hook = "missing" if not binh else "current" if binh == src else "outdated"
    hooked = False; deny = []
    try:
        with open(SETTINGS) as fh:
            s = json.load(fh)
        deny = (s.get("permissions") or {}).get("deny") or []
        for ent in (s.get("hooks") or {}).get("PreToolUse") or []:
            for h in ent.get("hooks") or []:
                if MARKER in str(h.get("command") or ""):
                    hooked = True
    except (OSError, ValueError):
        pass
    try:
        with open(CLAUDE_MD) as fh:
            lesson = MARKER in fh.read()
    except OSError:
        lesson = False
    sb = {}
    try:
        with open(SETTINGS) as fh:
            sbx = (json.load(fh).get("sandbox") or {})
        sb = {"enabled": bool(sbx.get("enabled")), "failIfUnavailable": bool(sbx.get("failIfUnavailable")), "noRetry": sbx.get("allowUnsandboxedCommands") is False,
              "strict": bool((sbx.get("network") or {}).get("strictAllowlist")), "domains": len((sbx.get("network") or {}).get("allowedDomains") or []),
              "denyRead": len((sbx.get("filesystem") or {}).get("denyRead") or []), "bwrap": shutil.which("bwrap") is not None, "socat": shutil.which("socat") is not None}
        sb["ok"] = sb["enabled"] and sb["failIfUnavailable"] and sb["noRetry"] and sb["bwrap"] and sb["socat"] and sb["denyRead"] > 0
    except (OSError, ValueError):
        pass
    return {"hook": hook, "hookPath": HOOK_BIN, "hooked": hooked, "denyRules": len(deny), "deny": deny, "lesson": lesson, "sandbox": sb,
            "tokenSet": os.path.exists(TOKEN_FILE), "tokenAt": os.path.getmtime(TOKEN_FILE) if os.path.exists(TOKEN_FILE) else None,
            "ok": hook == "current" and hooked and len(deny) > 0 and lesson}


def data():
    return {**status(), "blocked": blocked()}
