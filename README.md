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
