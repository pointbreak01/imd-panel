# imd-panel

A local control panel for an [IdentityMD](https://imd.fun) contributor worker. One HTML page, one
Python process, no dependencies beyond the standard library. It runs **on the machine that runs the
worker**, listens on `127.0.0.1` only, and you reach it through an SSH tunnel or a Tailscale tailnet.
The page works on a phone too.

![now tab](docs/now.png)

![swarm tab](docs/swarm.png)

It shows what your seat is doing and what it costs you, what the network is doing, and lets you
operate the worker from the browser: tiers, concurrency, skills, restart, updates and rollbacks, a
budget guard for your Claude plan, and Telegram notifications.

## Made for Claude

This panel is **built for workers that run on the Claude Code runtime** (`imd start --runtime claude`).
Task tokens, costs, turns, the transcript viewer and the plan-usage meter all come from Claude Code's
own session files and OAuth credentials on the same machine, and the whole thing was built and is
maintained with Claude Code. With the Codex runtime it still starts — journal, swarm, network data,
settings, updates — but every per-task cost and transcript view stays empty.

**Personal project, shared as is.** Updates follow one operator's needs and may be irregular; the
IdentityMD API and worker change often and things will break now and then. Fork it and bend it.

### Let your AI assistant install it

Open a terminal on the machine that runs your worker, start Claude Code (or any coding agent) and paste:

```text
Install imd-panel from https://github.com/pointbreak01/imd-panel on this machine. It is a local control panel
for the IdentityMD worker: read its README.md first. Check the requirements (Linux, user systemd
session with lingering, the worker installed as a user service with the claude runtime, python3 >= 3.9,
pipx), install it with `pipx install git+https://github.com/pointbreak01/imd-panel` and `imd-panel install`,
confirm imd-panel.service is active, and tell me the exact SSH tunnel command to open it from my
computer. If anything in my setup differs from the defaults (worker unit name, paths), write
~/.config/imd-panel/panel.json based on panel.example.json instead of editing the code.
```

If something breaks later, the same assistant with `README.md` and the failing file is the support line.

## What you get

| tab | what is on it |
|---|---|
| **Now** | The room: a wall of modules, one per task in range (working / accepted / rejected / pending), a live monitor of the journal, Pepe. Below it the instrument panel: Claude 5-hour window gauge, verdict lamps, top consumers, host meters, eight counters, tokens and tasks per hour, ERC-8004 registry, your seat's server-side record, network standing (breaker, queue, presence), network health (the three services and their builds, the control-plane commit, your rank among every seat, a benchmark against the fleet), launch earnings. |
| **Swarm** | A radar scope of the fleet: every connected seat as a blip (ring = working / delivered < 24 h / idle, colour = runtime, size = accepted, wires to the seats you share jobs with, sweep, joins ping). Fleet counters, a day of online/working, fleet composition, jobs and oracle questions in flight, and a searchable catalogue of everything the network published (sites, contract launches, research). |
| **Tasks** | Every task the journal knows, joined with its transcript: model, effort, tier, turns, tokens, cost, duration, status, verdict with the server's reason, on-chain review state, how many seats competed. Click a row for the ask (what the swarm asked, acceptance criteria, the pinned oracle request, the workflow the task is a stage of), the timeline with network calls flagged `rpc` / `api` / `web`, the network calls alone, and what was produced — including what the network kept: delivered repository or PR, IPFS cid, site under ENS, named output files. Research panels and fuzz campaigns get their verdict from the panel / campaign record. CSV export. |
| **History** | Daily cost and verdicts, kept in SQLite so they survive transcript pruning. Rate-limit episodes. Oracle questions grouped by shape, with how often each shape pays and how often it ends without quorum. |
| **Settings** | Tiers (which Claude model answers economy / standard; premium is fixed by the worker), concurrency, restart / stop, worker updates (installed build, latest GitHub release, auto-update toggle, update now, roll back to any release), budget guard, notifications (incl. "work lost" and "API changed"), skills, what is in force, an API sentinel that diffs imd.fun/docs daily, tier history. |
| **Logs** | The worker journal in the selected range, and CSV exports of every table. |

Two things cost money when you click them: **imd doctor** (the doctor Pepe) pings Claude once on the
premium model, and every worker task is what it is. Everything else reads local files and public APIs.

## Every feature

**The room (top of every tab)**
- A wall of instrument modules, one per task in the selected range, seeded by the task id so a module always looks the same: working = big, moving, green ring; accepted = lit face; rejected / failed = red ring; pending = amber lamp; released, no quorum and blocked = unlit. Hover for the task, click to open it. Idle modules drift now and then.
- A phosphor monitor with the live journal feed (node, queue, the last events).
- Pepe on the desk: poke him for a trick; the doctor Pepe runs `imd doctor` and shows the report.
- A remote with three keys: reload the data, restart the worker, stop / start it (two-step press for the dangerous ones), plus a LED with the service state.
- The top bar: state and heartbeat, fleet online / enrolled, Claude plan usage (5 h and week), clock, seat record with a link to the explorer, registry link, light / dark theme.
- On a phone the wall keeps only the newest tasks that fit the screen, the bar and the tabs stretch across the width.

**Now**
- Claude 5-hour window gauge from Claude Code's own usage endpoint, with the reset time; the week bar projects the current burn to the reset ("100 % by … at this pace").
- Verdict lamps for every submitted task in range, with accepted / rejected counts and how many are still open or closed without a verdict.
- Top consumers: the eight most expensive tasks, bar = cost, colour = model, click to open.
- Host meters: memory, worker memory against its limit, disk, load.
- Eight counters: accepted, submitted, released (with the turns and cost that went with the released ones), Claude limit errors and episodes, output tokens and thinking, fresh input and cache reads, API-equivalent cost, turns.
- Tokens per hour by model and tasks per hour (submitted / accepted / released), with rate-limit hits marked.
- ERC-8004 registry: feedback batches sent / queued / failed, feedbacks and positive share, tasks on chain, work records.
- The seat's server-side record: attempts, accepted, rejected, failed, pending, reviews on chain, roles, collaborators, daemon and runtime, last accepted.
- Standing: connected / accepting / breaker / fresh lamps, heartbeat, breaker state and cooldown, queue (ready, eligible for you, fleet online, blocked reasons), running on the server side, last failure recorded by the network.
- The network: daemons online, enrolled, working, accepted last day; the three services (verifier, publisher, deployer) with their builds; the control plane commit next to your worker build; pending queues and payments; your rank among every seat by accepted, with acceptance against the fleet and the median; tokens, turns and minutes per accepted task against the fleet median.
- Earnings: launch token allocations to the seat's wallet, by launch, chain and status.
- On a phone the panel becomes a list with the same readings.

**Swarm**
- Radar scope of the fleet: one blip per connected seat, ring = working / delivered in 24 h / idle, colour = runtime, size = accepted, wires to the seats you share jobs with, a sweep that lights blips, joins that ping. Hover for the seat, click for its explorer page.
- Counters: agents online, working now (server side vs seat flags), accepted in 24 h, executing, launches live, network tokens, runtimes, events kept.
- Online and working over the last 24 h, sampled every minute into SQLite.
- Fleet composition: runtime, premium model, system, daemon build, concurrency, and every seat's outcomes (accepted / rejected / failed / pending) from the network's records.
- Jobs on the network and oracle questions in flight.
- Published: everything the network shipped — sites named under ENS (with a sketched CRT per site), contract launches (token, chain, status, launch number, repo), research reports; type pills, status and chain filters, search over title, ENS, symbol, address and launch number.

**Tasks**
- Every task the journal knows, joined with its transcript: time, id with explorer link, kind (oracle, build contract project, manifest, adversarial review, research panel, fuzz campaign, …), tier, model and effort, turns, output and fresh tokens (cache reads on hover), cost, duration, outcome, network field, the ask.
- Outcome = the network's verdict (accepted, rejected, failed, no quorum, blocked) or, until it arrives, the worker's status (sent, released, cancelled); the rejection reason inline; for a released step, which seat delivered it afterwards.
- Net = seats on the job and accepted, on-chain marker, workflow marker. A coloured bar on the left of each row: green accepted, red rejected, amber pending, grey closed or released.
- Filters by model, status, verdict, tier and free text; sortable columns; a summary strip (shown, accepted, rejected, pending, no quorum, blocked, released, cost, output tokens, wall time).
- Click a row: outputs, sessions, thinking tokens, job, submission, tools used, limit errors, last message, the network's attempt record (verifier verdict and checks, oracle result, review, summary), workflow (stage, status, chain, every stage's state, site, repos), research panel or fuzz campaign record, delivery (repository and commit, PR, IPFS cid, site), named result files, accepted bundles.
- "open" on a row: the ask (Task section, acceptance criteria, allowed paths, the pinned reads such as the oracle request, the full prompt), the timeline (every turn and tool call with `rpc` / `api` / `web` badges), the network calls alone with their hosts, and what was produced (files written by the model, artifacts still on disk, git status, and what the network kept).
- Workflow stage jobs link to the explorer's workflow page, since the explorer has no page for a stage.
- CSV export of the filtered or the whole table, with every column.

**History**
- Cost per day by model and verdicts per day, drawn on the wall; one row per UTC day with tasks, submitted, accepted, rejected, acceptance, released, limit errors, guard pauses, cost by model, cost per task, output tokens, turns per task. Kept in SQLite so it survives transcript pruning.
- Rate-limit episodes: when, how long, how many hits, what Claude said, what ran the hour before.
- By model: sessions, turns, tokens, cache hit, average duration, API-equivalent cost.
- Oracle questions: every oracle answer grouped by the shape of its question, with accepted / rejected / no quorum / open, how often the shape pays, cost, cost per accepted answer, average turns and time.

**Settings**
- Tiers: which Claude model and effort answer the economy and standard tiers (premium is fixed by the worker); what is in force vs what config.json says; restart reminder.
- The service: state, restarts, concurrency (config.json and unit), versions, restart / start / stop, clean old work dirs.
- Worker updates: installed build, latest GitHub release, auto-update toggle, update now, release notes and a roll back button per release (archive downloaded and verified against SHA256SUMS, installed with npm, auto-update turned off), update history including releases the daemon refused.
- Budget guard: stops the worker when the plan's 5 h or week utilisation passes a threshold (or a local token / dollar estimate), waits for running tasks, resumes at the reset, manual override.
- Notifications: Telegram bot and / or HTTPS webhook; events: Claude limit hit, tasks released, work lost, guard paused / resumed, no heartbeat, service not active, task rejected, network standing, low disk, daily digest, API changed.
- Skills the machine accepts, toggled with `imd skills add/remove`.
- In force: the resolved tier table, concurrency, opt-outs, guard and notifier summary. Service & versions: worker, Claude Code, node, server, token id, cleanup timer, config path, unit, ExecStart. API sentinel: documented routes on imd.fun/docs and the ones added since the last visit.
- Tier history: an append-only log of which model answered which tier when, so a task never changes tier after the fact; copy or download as JSON.

**Logs**
- The worker journal for the selected range, filtered by type.
- Exports: CSV of tasks, events, rate-limit episodes, daily history, by model, tokens per hour; raw journal and panel log as text.

**Under the hood**
- One Python process, standard library only; every response gzipped; a light feed every 30 s and the full feed every 5 min; API calls memoised with per-cycle budgets; transcripts parsed once and cached by mtime.
- Data joined from the worker journal, Claude Code transcripts and the public api.imd.fun (seat, submissions, standing, health, services, contributors, seat records, earnings, swarm, publications, workflows, panels, fuzz, results, oracle requests, feedback batches, work records).
- Write actions only from loopback with a custom header; nothing runs with elevated privileges.

## Requirements

- Linux with a **user** systemd session (`loginctl enable-linger $USER` so the panel survives logout).
- The IdentityMD worker installed as a user service (`imd service install --auto-update`), runtime
  `claude`. The panel reads its journal with `journalctl --user`.
- Python 3.9+ and [pipx](https://pipx.pypa.io) (`sudo apt install pipx` on Debian/Ubuntu, which also
  brings `python3-venv`). No other dependency: the panel is standard library only.
- Optional: Foundry's `forge` on PATH for `imd doctor`; `npm` (comes with the worker's node) for rollbacks.

## Install

```sh
pipx install git+https://github.com/pointbreak01/imd-panel
imd-panel install            # user unit imd-panel.service on 127.0.0.1:8787
```

Then, from your own computer:

```sh
ssh -N -L 8787:127.0.0.1:8787 <user>@<your host>
# open http://localhost:8787
```

`imd-panel install --port 8790` picks another port. `imd-panel uninstall` removes the service and keeps
your settings. Logs: `journalctl --user -u imd-panel -f`. Settings, notifications, history and the
worker release archives live in `~/.config/imd-panel/` (or `$IMD_PANEL_HOME`), never inside the package.

From a source checkout instead of pipx: `git clone … ~/imd-panel && ~/imd-panel/install.sh`, which runs
the package in place.

### Away from home: Tailscale

To open the panel from your phone or another network without exposing a port, put the host on a
[Tailscale](https://tailscale.com) tailnet and let `tailscale serve` front the local port:

```sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
sudo tailscale serve --bg http://127.0.0.1:8787
# prints https://<host>.<tailnet>.ts.net — open it from any device logged into the same tailnet
```

Nothing listens on the public IP: the HTTPS listener sits on the tailnet address only, the certificate
is issued by Tailscale, and the panel keeps seeing requests from `127.0.0.1`. Your Tailscale login is
the only gate, so keep two-factor on that account. `tailscale serve --https=443 off` undoes it.

## Updating

The panel does not update itself. When you want the latest version:

```sh
pipx upgrade imd-panel && systemctl --user restart imd-panel
```

(`pipx reinstall imd-panel` if pipx refuses to upgrade a git install.) This restarts the panel only; the
worker is never touched. From a source checkout: `git -C ~/imd-panel pull && systemctl --user restart imd-panel`.

### Configuration (optional)

Copy `panel.example.json` to `~/.config/imd-panel/panel.json` if your setup differs from the defaults:

| key | default | meaning |
|---|---|---|
| `workerUnit` | `identitymd-worker.service` | the worker's user unit (`imd service install` names it so) |
| `cleanUnit` | `null` | a systemd unit of your own that prunes old work dirs; with `null` the panel prunes by itself once a day |
| `proxyPorts` | `[]` | local ports of a keyed RPC/API proxy you run: calls to `127.0.0.1:<port>/<chainId>` are counted as `rpc`, other paths as `api` in the task timeline |
| `pruneWorkDays` / `pruneTranscriptDays` | `3` / `14` | ages for the built-in prune |
| `identitymdHome` | `~/.identitymd` | where the worker keeps `config.json` and `work/` |

Notifications (Telegram bot or HTTPS webhook) and the budget guard are configured from the Settings tab;
they live in `notify.json` and `guard.json` in `~/.config/imd-panel/`.

## How it works

- `imd_panel/collect.py` joins three sources: the worker's journal (accepted / submitted / released / cancelled,
  heartbeats, updates), Claude Code transcripts in `~/.claude/projects/*identitymd-work*/` (model, effort,
  turns, tokens, cost, tools, session-limit errors), and the public control plane `api.imd.fun`
  (seat record, submissions and verdicts, standing, health, services and build, contributors, every seat's
  record, earnings, swarm, publications, workflows, research panels, fuzz campaigns, delivered results, the
  pinned inputs of a task). Tiers are resolved against an append-only log of your inference config,
  so a task keeps the tier it actually ran under.
- `imd_panel/server.py` is a stdlib HTTP server: `/` is the page, `/api/data` the JSON (gzipped, ~200 KB),
  `/api/lite` the 30-second refresh (state, heartbeat, usage, guard, events — ~40 KB; the full feed is fetched every
  5 minutes), `/api/transcript?id=` one task, `/api/history` the daily rows. The page's scripts are in
  `imd_panel/assets/js/`, served with ETags. POST actions (config, worker, skills, doctor, guard, notify, update)
  require the `X-Dashboard: 1` header and a loopback client; they run `systemctl --user`, edit
  `~/.identitymd/config.json` and the worker unit, run `imd doctor` / `imd update`, or `npm install -g`
  a verified release archive for a rollback.
- The Claude plan meter calls Claude Code's usage endpoint with the OAuth token from
  `~/.claude/.credentials.json`. The token never leaves the machine and is never shown.
- `imd_panel/history.py` snapshots daily aggregates into `history.sqlite`; the swarm tab samples `/swarm` into
  `swarm.sqlite` once a minute. Both live in `~/.config/imd-panel/`, next to `api-routes.json` (the API sentinel's
  baseline: imd.fun/docs is read every 6 h and new routes are listed in Settings and sent by the notifier).
- The page script is split into `imd_panel/assets/js/01-core.js … 07-swarm.js`; responses are gzipped, the page polls a
  light `/api/lite` every 30 s and the full feed every 5 min. Released tasks that had already worked are summed as work
  lost; History groups oracle answers by question shape; the week bar projects the plan's burn to the reset; on a phone the
  Now panel becomes a list.

## Security notes

The panel binds `127.0.0.1` and has no authentication of its own: anyone who can reach that port on the
machine can operate your worker. Use the SSH tunnel or a Tailscale tailnet, do not expose the port or put
it behind a plain reverse proxy (the localhost check on write actions would then pass for everyone). Actions are limited to the
worker unit and its config; nothing is run with elevated privileges (`NoNewPrivileges` in the unit).

## Support

There is no support channel. Ask your AI assistant: open this folder in Claude Code (or any coding
agent), point it at `README.md` and the file you are stuck on, and describe what you see — that is how
this panel was built and how it is maintained.
