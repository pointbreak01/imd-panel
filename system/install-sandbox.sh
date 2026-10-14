#!/bin/sh
# User part of the Claude Code sandbox setup for an identity.md worker machine. Run as the worker's user, after an admin
# ran system/install-sandbox-deps.sh (bubblewrap, socat, AppArmor):
#
#     sh ~/imd-panel/system/install-sandbox.sh            # write the settings, then probe them
#     sh ~/imd-panel/system/install-sandbox.sh --probe    # probe only
#     sh ~/imd-panel/system/install-sandbox.sh --no-probe # settings only
#
# What the settings do (sandbox section of ~/.claude/settings.json; the worker starts every task's Claude with
# --setting-sources user, so they apply to every task):
#   - every Bash command of every task runs under bubblewrap: the home directory is read-only except the task's
#     own directory, /tmp (tasks keep scratch there; the sandbox's own temp dir is private) and the build caches (npm, forge, solc, playwright); ~/.identitymd (except work/),
#     ~/.claude credentials, ~/.ssh, ~/.config and ~/.local/state cannot even be read — by any process, forge tests with
#     ffi, npm scripts and node one-liners included, which the imd-task-guard hook alone cannot see
#   - the network is a separate namespace: only the hosts in allowedDomains are reachable (public RPC providers, the
#     imd.fun hosts, GitHub, npm, the block explorers tasks really use — the list came from 1,390 task transcripts),
#     everything else fails at once (strictAllowlist); a sandboxed command cannot be retried outside the sandbox
#   - failIfUnavailable: if bubblewrap is missing, Claude exits instead of silently running unsandboxed
# Everything the file already has (permissions.deny, hooks, model) is kept. Backup: settings.json.bak-<date>.
set -eu
SETTINGS="$HOME/.claude/settings.json"
STAMP="$(date +%Y%m%d)"
export PATH="$HOME/.local/bin:$PATH"

if [ "${1:-}" != "--probe" ]; then
  command -v bwrap >/dev/null || { echo "bubblewrap is not installed: an admin runs system/install-sandbox-deps.sh first"; exit 1; }
  echo "1/2 ~/.claude/settings.json: sandbox section"
  [ -f "$SETTINGS" ] && cp -p "$SETTINGS" "$SETTINGS.bak-$STAMP" || true
  SETTINGS="$SETTINGS" python3 - <<'EOF'
import json, os
p = os.environ["SETTINGS"]
try:
    s = json.load(open(p))
except (OSError, ValueError):
    s = {}
RPC_HOSTS = [  # public RPC and data hosts seen in this machine's task transcripts, plus their provider families
    "*.publicnode.com", "rpc.ordofi.network", "rpc.mevblocker.io", "mainnet.base.org", "rpc.flashbots.net", "rpc-robinhood.blockmachine.io",
    "*.robinhood.com", "rpc.mainnet.chain.robinhood.com", "*.blockmachine.io", "robinhood.rpc.blxrbdn.com", "*.blxrbdn.com", "robinhood.api.pocket.network",
    "*.pocket.network", "api.mainnet-beta.solana.com", "*.solana.com", "*.solana.fm", "*.solscan.io", "*.solanabeach.io", "*.projectserum.com",
    "*.rpcpool.com", "*.helius-rpc.com", "*.extrnode.com", "solana.public-rpc.com", "public.1rpc.io", "*.1rpc.io", "*.meowrpc.com", "*.ankr.com",
    "*.thirdweb.com", "*.sentio.xyz", "*.drpc.org", "*.nodies.app", "*.blastapi.io", "*.swiftnodes.io", "*.zan.top", "*.fastnode.io",
    "*.alchemy.com", "*.alchemyapi.io", "*.infura.io", "*.quiknode.pro", "*.quicknode.com", "*.llamarpc.com", "*.chainstack.com", "*.gateway.tenderly.co",
    "*.tenderly.co", "rpc.sepolia.org", "*.sepolia.org", "one.valve.city", "*.valve.city", "*.bnbchain.org", "*.binance.org", "*.polygon-rpc.com",
    "*.arbitrum.io", "*.optimism.io", "*.base.org", "*.gnosischain.com", "*.avax.network", "*.celo.org", "*.linea.build", "*.scroll.io", "*.zksync.io",
    "*.mantle.xyz", "*.blast.io", "*.mode.network", "*.unichain.org", "*.worldchain.org", "*.ink.xyz", "*.soneium.org", "*.sonic.game", "*.berachain.com",
]
DATA_HOSTS = ["*.etherscan.io", "*.basescan.org", "*.bscscan.com", "*.arbiscan.io", "*.polygonscan.com", "*.blockscout.com", "*.sourcify.dev",
              "*.coingecko.com", "*.coinmarketcap.com", "*.opensea.io", "*.8004scan.io", "*.dexscreener.com", "*.defillama.com", "*.llama.fi",
              "*.geckoterminal.com", "*.uniswap.org", "*.thegraph.com", "*.ipfs.io", "*.dweb.link", "*.pinata.cloud", "*.arweave.net"]
WEB_HOSTS = ["*.imd.fun", "imd.fun", "*.github.com", "github.com", "*.githubusercontent.com", "registry.npmjs.org", "*.npmjs.org", "*.npmjs.com",
             "*.yarnpkg.com", "*.pypi.org", "pypi.org", "*.pythonhosted.org", "*.wikipedia.org", "*.wikimedia.org", "archive.org", "*.archive.org",
             "*.nasa.gov", "*.britannica.com", "*.vercel.app", "*.aviationweather.gov", "*.cloudflare.com", "*.jsdelivr.net", "*.unpkg.com",
             "fonts.googleapis.com", "fonts.gstatic.com", "*.google.com", "cdn.syndication.twimg.com", "*.twimg.com", "*.x.com", "x.com", "*.twitter.com",
             "*.foundry.paradigm.xyz", "*.paradigm.xyz", "binaries.soliditylang.org", "*.soliditylang.org", "*.openzeppelin.com", "*.playwright.dev",
             "playwright.azureedge.net", "*.azureedge.net", "*.microsoft.com", "*.googleapis.com", "*.gstatic.com"]
LOCAL = ["127.0.0.1:8546"]  # this machine's keyed RPC relay (imd-rpc); the sandbox resolves loopback only for listed ip:port
sb = s.setdefault("sandbox", {})
sb.update({"enabled": True, "failIfUnavailable": True, "autoAllowBashIfSandboxed": True, "allowUnsandboxedCommands": False})
fs = sb.setdefault("filesystem", {})
fs["denyRead"] = sorted(set(fs.get("denyRead") or []) | {"~/.identitymd", "~/.claude/.credentials.json", "~/.claude.json", "~/.claude/settings.json",
                        "~/.claude/settings.json.*", "~/.ssh", "~/.config", "~/.local/state", "~/.bash_history", "~/.npmrc", "~/.gnupg",
                        "~/imd-panel", "~/imd-tools", "~/imd-rpc", "~/imd-dashboard", "~/backups"})
fs["allowRead"] = sorted(set(fs.get("allowRead") or []) | {"~/.identitymd/work"})
fs["allowWrite"] = sorted(set(fs.get("allowWrite") or []) | {"/tmp", "/var/tmp", "~/.npm", "~/.cache", "~/.foundry/cache", "~/.local/share/svm", "~/.local/share/vitest", "~/.local/share/pnpm"})
fs["denyWrite"] = sorted(set(fs.get("denyWrite") or []) | {"~/.cache/claude", "~/.cache/claude-cli-nodejs"})
net = sb.setdefault("network", {})
net["strictAllowlist"] = True
net["allowedDomains"] = sorted(set(net.get("allowedDomains") or []) | set(RPC_HOSTS) | set(DATA_HOSTS) | set(WEB_HOSTS) | set(LOCAL))
tmp = p + ".tmp"
with open(tmp, "w") as fh:
    json.dump(s, fh, indent=2); fh.write("\n")
os.replace(tmp, p)
print("   denyRead %d · allowRead %d · allowWrite %d · allowedDomains %d" % (len(fs["denyRead"]), len(fs["allowRead"]), len(fs["allowWrite"]), len(net["allowedDomains"])))
EOF
fi
[ "${1:-}" = "--no-probe" ] && exit 0

echo "2/2 probes: a small Claude session runs each command; the sandbox, not the model, decides what happens"
command -v claude >/dev/null || { echo "claude is not on PATH"; exit 1; }
D=$(mktemp -d /tmp/sandbox-probe-XXXX); cd "$D"
probe() {  # $1 label, $2 expectation, $3 command
  out=$(printf 'Use the Bash tool to run exactly this command, once, and reply with only its raw output (stdout and stderr), nothing else:\n%s\n' "$3" \
        | timeout 180 claude -p --model claude-haiku-5-5 --setting-sources user --permission-mode acceptEdits --max-turns 3 --allowedTools Bash --output-format json 2>/dev/null \
        | python3 -c 'import json,sys
try: print((json.load(sys.stdin).get("result") or "").strip().replace("\n"," | ")[:200])
except Exception as e: print("(no result)")')
  printf '   %-28s expect: %-34s got: %s\n' "$1" "$2" "$out"
}
probe "write to home" "denied (read-only)" "touch ~/sandbox-probe && echo WROTE || echo DENIED"
probe "write to cwd + /tmp" "ok" "echo ok > p.txt && cat p.txt && echo t > /tmp/sandbox-probe-t && cat /tmp/sandbox-probe-t"
probe "read ~/imd-rpc (denyRead)" "denied / no such file" "ls /home/$(id -un)/imd-rpc 2>&1 | head -2"
probe "read config by hex path" "error, not a number" "python3 -c \"p=bytes.fromhex('$(printf '%s' "$HOME/.identitymd/config.json" | od -An -tx1 | tr -d ' \n')').decode();print(len(open(p).read()))\""
probe "read own workspace" "ok" "ls -d /home/$(id -un)/.identitymd/work 2>&1"
probe "allowed RPC host" "200" "curl -s -m 15 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_blockNumber\",\"params\":[]}' https://ethereum-rpc.publicnode.com"
probe "wildcard RPC host" "200" "curl -s -m 15 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_blockNumber\",\"params\":[]}' https://base-rpc.publicnode.com"
probe "unlisted host" "denied / could not resolve" "curl -s -m 10 -o /dev/null -w '%{http_code}' https://example.com; echo \" rc=\$?\""
probe "local RPC relay 8546" "200 or 404 (reachable)" "curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:8546/; echo \" rc=\$?\""
probe "forge + node present" "versions" "forge --version 2>&1 | head -1; node --version"
rm -rf "$D" /tmp/sandbox-probe-t
echo "done. If a probe that should pass failed, add the host to sandbox.network.allowedDomains or the path to filesystem.allowWrite in $SETTINGS."
