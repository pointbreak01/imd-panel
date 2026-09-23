"""Tier attribution that follows the worker's inference config through time.

`model + effort -> tier` is not a constant: it is whatever `inference` in
config.json said at the moment the task ran, and that changes every time a tier
is switched from the dashboard (or by hand). Labelling old tasks with today's
mapping silently moves them between tiers, which corrupts exactly the per-tier
verdict stats a switch is meant to be judged by — so instead keep an
append-only log of config snapshots and resolve every task against the snapshot
that was in force when it started.

A snapshot is recorded only once the worker has actually restarted onto it: the
worker reads config.json at startup, so an edit that has not been restarted into
is not yet deciding anything.
"""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(HERE, "config-history.json")
TIERS = ("standard", "economy", "premium")
# systemd reports start times to the second, so a restart the dashboard fires
# right after writing config.json can look a fraction of a second too early.
GRACE_S = 5
PREMIUM_MODEL = "claude-fable-5-1"  # hard-wired in the worker (PREMIUM_MODELS); server-assigned tier

# What ran before this log existed. effort is None = "any effort": the seed
# cannot know which efforts were used back then, and matching on the model alone
# is enough while the three tiers run three different models.
SEED = {"standard": {"model": "claude-opus-5", "effort": None},
        "economy": {"model": "claude-sonnet-5", "effort": None},
        "premium": {"model": PREMIUM_MODEL, "effort": None}}
SEED_NOTE = "seed — worker defaults in force before the log existed"

_cache = {"key": None, "v": []}


def _load():
    """Snapshots as stored, oldest first; re-read only when the file changes."""
    try:
        st = os.stat(LOG)
    except OSError:
        return []
    key = (st.st_mtime, st.st_size)
    if _cache["key"] == key:
        return _cache["v"]
    try:
        with open(LOG) as fh:
            snaps = json.load(fh).get("snapshots") or []
    except (OSError, ValueError):
        return _cache["v"]  # keep the last good copy rather than silently reseeding
    snaps.sort(key=lambda s: s.get("ts", 0))
    _cache["key"] = key; _cache["v"] = snaps
    return snaps


def normalize(tiers):
    """config-panel tier dicts -> just what decides attribution."""
    out = {}
    for k in TIERS:
        v = tiers.get(k) or {}
        if v.get("model"):
            out[k] = {"model": v["model"], "effort": v.get("effort") or None,
                      **({"optOut": True} if v.get("optOut") else {})}
    return out


def _seed():
    return {"ts": 0, "source": SEED_NOTE, "tiers": SEED, "seed": True}


def snapshots():
    snaps = _load()
    if not snaps or snaps[0]["ts"] > 0:
        snaps = [_seed()] + list(snaps)
    return snaps


def record(tiers, ts, source):
    """Append a snapshot if the mapping actually changed. Returns the snapshot or None."""
    snaps = list(_load()) or [_seed()]
    if snaps[-1]["tiers"] == tiers:
        return None
    snap = {"ts": max(float(ts), snaps[-1]["ts"] + 1), "source": source, "tiers": tiers}
    snaps.append(snap)
    tmp = LOG + ".tmp"
    with open(tmp, "w") as fh:
        json.dump({"v": 1, "snapshots": snaps}, fh, indent=1)
    os.replace(tmp, LOG)
    _cache["key"] = None
    return snap


def sync(tiers, config_mtime, worker_start, source="config.json"):
    """Record the current mapping if the worker is already running on it.

    Returns (snapshot|None, pending) — pending means config.json has been edited
    since the worker started, so the new mapping is not in force yet.
    """
    tiers = normalize(tiers)
    if not tiers:
        return None, False
    if config_mtime and worker_start and worker_start + GRACE_S < config_mtime:
        return None, True  # edited but not restarted into: not deciding anything yet
    return record(tiers, worker_start or config_mtime or 0, source), False


def at(ts):
    """The snapshot in force at `ts`."""
    snaps = snapshots()
    cur = snaps[0]
    for s in snaps:
        if s["ts"] > (ts or 0):
            break
        cur = s
    return cur


def _fallback(model, effort):
    """Used when the snapshot cannot decide: two tiers on one model, or a model
    no tier claims (a manual run, or a tier switched without a restart)."""
    if model == PREMIUM_MODEL and effort in ("high", "xhigh", "max"):
        return "premium"
    if model == "claude-sonnet-5":
        return "economy"
    return "standard"


def tier_of(model, effort, ts=None):
    """Which tier `model`/`effort` belonged to when it ran at `ts`."""
    if not model:
        return None
    # an opted-out premium mirrors another tier's model — it serves nothing, so ignore it
    tiers = {k: v for k, v in (at(ts).get("tiers") or {}).items() if not v.get("optOut")}
    exact = [k for k, v in tiers.items() if v["model"] == model and v["effort"] == effort]
    if len(exact) == 1:
        return exact[0]
    same = [k for k, v in tiers.items() if v["model"] == model]
    if len(same) == 1:  # right model, different effort: a default, or an untracked edit
        return same[0]
    return _fallback(model, effort)


def timeline():
    """Snapshots for the UI, newest first, each with what changed since the previous one."""
    snaps = snapshots()
    out = []
    for i, s in enumerate(snaps):
        if not i:
            out.append({**s, "changed": [k for k in TIERS if s["tiers"].get(k)]})
            continue
        prev = snaps[i - 1]
        # the seed records no efforts, so against it only a model change is a real change
        base = prev.get("seed") or not prev["ts"]
        key = (lambda v: v and v.get("model")) if base else (lambda v: v or None)
        changed = [k for k in TIERS if key(s["tiers"].get(k)) != key(prev["tiers"].get(k))]
        out.append({**s, "changed": changed, **({"baseline": True} if base else {})})
    return out[::-1]
