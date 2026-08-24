#!/bin/bash
# Deploy flow for ~/my-nextjs-app -> GitHub -> Vercel (auto-deploy from main)
# Usage: ./deploy.sh "commit message"
# NOTE: Only run AFTER user (KC) explicitly approves the push.
set -euo pipefail
cd "$(dirname "$0")"

MSG="${1:-deploy: update $(date '+%Y-%m-%d %H:%M')}"

echo "== 1/4 Build check =="
npm run build

echo "== 2/4 Commit =="
git add -A
if git diff --cached --quiet; then
  echo "No changes to commit."
else
  git commit -m "$MSG"
fi

echo "== 3/4 Push to GitHub (jnch9513/hermes-agent-testing-repo, main) =="
git push origin main

echo "== 4/4 Done. Vercel auto-deploys from main =="
echo "Prod: https://hermes-agent-testing-repo.vercel.app/"
echo "Verify: curl -s -o /dev/null -w '%{http_code}' https://hermes-agent-testing-repo.vercel.app/"
