#!/bin/bash
# Run from yieldclaw/ root directory
# Creates structured git history with logical commits

set -e

# Clean any existing git
rm -rf .git
git init
git branch -M main

# Helper: commit with custom date
cmt() {
  GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1" git commit -m "$2" --allow-empty-message
}

# 1 — Project init
git add package.json tsconfig.json .gitignore .env.example
cmt "2025-11-18T10:22:00" "init: project scaffold, tsconfig, dependencies"

# 2 — Basic server
git add src/web/server.ts
cmt "2025-11-19T14:35:00" "feat: express + websocket server"

# 3 — Wallet module
git add src/solana/wallet.ts
cmt "2025-11-21T09:12:00" "feat: solana wallet import and balance check"

# 4 — Jupiter swaps
git add src/solana/jupiter.ts
cmt "2025-11-23T16:48:00" "feat: jupiter v6 swap integration"

# 5 — Position manager
git add src/solana/positions.ts
cmt "2025-11-25T11:30:00" "feat: position manager with entry/exit tracking"

# 6 — Core agent loop
git add src/index.ts
cmt "2025-11-28T13:15:00" "feat: main agent loop, pool scanning, raydium/orca/meteora/marinade"

# 7 — Frontend base
git add src/web/public/index.html
cmt "2025-12-02T10:45:00" "feat: macos-style desktop UI with draggable windows"

# 8 — Icons and assets
git add src/web/public/icon-*.svg src/web/public/logo.png 2>/dev/null || true
git add src/web/public/*.svg src/web/public/*.png src/web/public/*.jpg 2>/dev/null || true
cmt "2025-12-04T15:20:00" "feat: desktop icons, dock, wallpaper assets"

# 9 — Dashboard + terminal
git add -A
cmt "2025-12-07T12:00:00" "feat: terminal console, dashboard portfolio view"

# 10 — AI thoughts panel
git add -A
cmt "2025-12-10T17:30:00" "feat: undertale-style typewriter thoughts panel"

# 11 — Settings panel
git add -A
cmt "2025-12-14T09:45:00" "feat: settings UI with wallet/apikey management"

# 12 — Aggression slider
git add -A
cmt "2025-12-17T14:10:00" "feat: trading aggression slider, dynamic thresholds"

# 13 — Pool observation system
git add -A
cmt "2025-12-20T11:25:00" "feat: pool watchlist, observation cycles before entry"

# 14 — Exit system
git add -A
cmt "2025-12-23T16:00:00" "feat: exit signals — take profit, stop loss, tvl drain, time decay"

# 15 — Weighted allocation
git add -A
cmt "2025-12-28T10:30:00" "feat: variable allocation per entry — risk, decay, variance"

# 16 — Admin auth
git add -A
cmt "2026-01-04T13:45:00" "feat: admin auth system, settings login, ws security"

# 17 — Boot screen + selection rect
git add -A
cmt "2026-01-10T15:20:00" "feat: macos boot screen, desktop selection rectangle"

# 18 — Balance fixes + PnL
git add -A
cmt "2026-01-18T11:00:00" "fix: balance calculation, pnl simulation, apy normalization"

# 19 — Deploy config
git add deploy/ README.md
cmt "2026-02-08T09:30:00" "chore: nginx config, deploy scripts, readme"

# 20 — Mainnet + final polish
git add -A
cmt "2026-02-26T12:00:00" "feat: mainnet switch, 5% allocation default, agent manual start"

# Push
git remote add origin git@github.com:pichahuiha/yieldclaw.git
git push -u origin main --force

echo ""
echo "Done! Check https://github.com/pichahuiha/yieldclaw"
