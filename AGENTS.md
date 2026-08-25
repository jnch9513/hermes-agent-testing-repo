<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Deploy Flow（KC 規則）

**規則：行 `./deploy.sh` 之前必須先問 KC。KC 話 OK 先可以 push git + deploy。改 code、build、本地測試唔使問。**

## Project

- Local: `/Users/kc/my-nextjs-app`（Next.js 16 + React 19，App Router，src/ 目錄）
- GitHub: `https://github.com/jnch9513/hermes-agent-testing-repo`（branch: main）
- Prod: https://hermes-agent-testing-repo.vercel.app/
- Vercel project 已連 GitHub repo，push 去 main 即自動 redeploy

## Deploy 步驟

```bash
cd /Users/kc/my-nextjs-app
./deploy.sh "commit message"
```

Script 自動做：`npm run build` 驗證 → commit → push origin main → Vercel 自動 redeploy。

## Deploy 後驗證

```bash
curl -s -o /dev/null -w '%{http_code}' https://hermes-agent-testing-repo.vercel.app/   # 應該 200
curl -sL https://hermes-agent-testing-repo.vercel.app/ | grep -io 'hello world'        # 抽查內容
```

## Pitfalls

- Vercel framework 一定要係 `nextjs`（試過變咗 None 導致 deploy 空 build → 全站 404）。404 就查 project settings。
- Push 前先確認 `npm run build` 過（deploy.sh 內置）。
- Git push 用 remote `origin`；credential 已存 osxkeychain。

## WebSocket 注意

- `/api/ws` 用 `experimental_upgradeWebSocket()`（@vercel/functions）— **本地 `next dev` 行唔到 WS upgrade**（handshake fail 係正常），要 `vercel dev` 或直接測 prod。
- Presence 狀態喺 Redis（REDIS_URL env 已設，ZSET+HASH + pub/sub 跨 instance fan-out）；未設 REDIS_URL 時 fallback in-memory（單 instance 先 work）。
- Headless 測試 script：`~/.hermes/scripts/presence-ws-test.js`（BASE_URL 環境變數切換目標）。
