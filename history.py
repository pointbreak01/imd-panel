"""Daily history snapshots in SQLite so the dashboard keeps months of aggregates after transcripts are pruned."""
import json, os, sqlite3, time
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, "history.sqlite")
RECOMPUTE_DAYS = 3  # verdicts and on-chain feedback arrive after the fact


def conn():
    c = sqlite3.connect(DB)
    c.execute("""CREATE TABLE IF NOT EXISTS days (
        day TEXT PRIMARY KEY, tasks INT, submitted INT, accepted INT, rejected INT, released INT, limitHits INT,
        cost REAL, costOpus REAL, costSonnet REAL, outTokens INT, freshTokens INT, cacheRead INT, turns INT,
        sessionsOpus INT, sessionsSonnet INT, onchain INT, guardPauses INT, updatedAt REAL, extra TEXT)""")
    c.execute("CREATE TABLE IF NOT EXISTS events (ts REAL, day TEXT, type TEXT, msg TEXT)")
    c.execute("CREATE INDEX IF NOT EXISTS ev_day ON events(day)")
    return c


def day_of(ts):
    return time.strftime("%Y-%m-%d", time.gmtime(ts))


def aggregate(d, day):
    T = [t for t in d.get("tasks", []) if day_of(t.get("acceptedAt", 0)) == day and t.get("status") != "no-journal"]
    r = Counter()
    for t in T:
        u = t.get("usage", {})
        r["tasks"] += 1; r["submitted"] += bool(t.get("submittedAt")); r["accepted"] += t.get("verdict") == "accepted"
        r["rejected"] += t.get("verdict") == "rejected"; r["released"] += t.get("status") == "rate-limited"
        r["cost"] += t.get("costUSD", 0); r["outTokens"] += u.get("output_tokens", 0); r["turns"] += t.get("turns", 0)
        r["freshTokens"] += u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0); r["cacheRead"] += u.get("cache_read_input_tokens", 0)
        r["onchain"] += bool(t.get("onchain"))
        # fixed columns kept for the rows written before extra.byModel existed; new
        # readers should use extra["byModel"], which covers every model
        if (t.get("model") or "").startswith("claude-opus-"):  # any Opus (5, 5.5, …)
            r["costOpus"] += t.get("costUSD", 0); r["sessionsOpus"] += 1
        if t.get("model") == "claude-sonnet-5": r["costSonnet"] += t.get("costUSD", 0); r["sessionsSonnet"] += 1
    r["limitHits"] = sum(l["hits"] for l in d.get("limitMsgs", []) if day_of(l["ts"]) == day)
    g = (d.get("guard") or {}).get("state") or {}
    r["guardPauses"] = sum(1 for l in g.get("log", []) if l["msg"].startswith("paused") and day_of(l["ts"]) == day)
    # byTier/byModel are keyed by whatever actually ran that day — no model or tier
    # name is hardcoded, so a new model or a tier switch shows up on its own.
    extra = {"byTier": {}, "byModel": {}}
    for t in T:
        for field, key in (("byTier", t.get("tier") or "unknown"), ("byModel", t.get("model") or "unknown")):
            e = extra[field].setdefault(key, Counter())
            e["tasks"] += 1; e["accepted"] += t.get("verdict") == "accepted"
            e["rejected"] += t.get("verdict") == "rejected"; e["cost"] += t.get("costUSD", 0)
            e["outTokens"] += t.get("usage", {}).get("output_tokens", 0)
    for field in ("byTier", "byModel"):
        extra[field] = {k: {kk: (round(vv, 4) if kk == "cost" else vv) for kk, vv in v.items()} for k, v in extra[field].items()}
    return r, extra


def snapshot(d):
    """Upsert the last RECOMPUTE_DAYS days (and any day present in data but missing from the table)."""
    now = time.time(); c = conn()
    have = {row[0] for row in c.execute("SELECT day FROM days")}
    days = {day_of(now - i * 86400) for i in range(RECOMPUTE_DAYS)}
    days |= {day_of(t.get("acceptedAt", 0)) for t in d.get("tasks", []) if t.get("status") != "no-journal"} - have
    for day in sorted(days):
        r, extra = aggregate(d, day)
        if not r["tasks"] and day not in have and day != day_of(now):
            continue
        c.execute("""INSERT OR REPLACE INTO days VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                  (day, r["tasks"], r["submitted"], r["accepted"], r["rejected"], r["released"], r["limitHits"], round(r["cost"], 4),
                   round(r["costOpus"], 4), round(r["costSonnet"], 4), r["outTokens"], r["freshTokens"], r["cacheRead"], r["turns"],
                   r["sessionsOpus"], r["sessionsSonnet"], r["onchain"], r["guardPauses"], now, json.dumps(extra)))
    # durable copy of notable events (journal rotates, guard log is in memory)
    last = c.execute("SELECT MAX(ts) FROM events").fetchone()[0] or 0
    for e in d.get("events", []):
        if e["ts"] > last and e["type"] in ("rate-limit", "update", "mismatch", "cancelled"):
            c.execute("INSERT INTO events VALUES (?,?,?,?)", (e["ts"], day_of(e["ts"]), e["type"], e["msg"][:300]))
    g = (d.get("guard") or {}).get("state") or {}
    for l in g.get("log", []):
        if l["ts"] > last:
            c.execute("INSERT INTO events VALUES (?,?,?,?)", (l["ts"], day_of(l["ts"]), "guard", l["msg"][:300]))
    c.commit(); c.close()


def read(days=90):
    c = conn(); c.row_factory = sqlite3.Row
    rows = [dict(r) for r in c.execute("SELECT * FROM days ORDER BY day DESC LIMIT ?", (days,))]
    for r in rows:
        r["extra"] = json.loads(r.pop("extra") or "{}")
    ev = [dict(r) for r in c.execute("SELECT * FROM events ORDER BY ts DESC LIMIT 200")]
    c.close()
    return {"days": rows[::-1], "events": ev}
