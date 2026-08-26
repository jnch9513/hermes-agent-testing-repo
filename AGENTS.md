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

## Lucky13 多 instance 一致性（2026-08-26 修復）

- **分散式鎖**：所有 game mutation（place/discard/ready/start/join/create/markOffline/read-path expiry）必須行 `withLock()`（`src/lib/game13/redis-state.ts`），入鎖後一律由 Redis 重讀 state，唔可以信 instance cache。Vercel WS 每條連線可落唔同 instance，無鎖會雙重派牌 →「not enough cards」。
- **過期回合結算**：任何 message 入鎖後第一步檢查 `isExpired()` 並結算過期回合（`game-hub.ts` handleMessage pre-step）。Client 端 UI 見到 deadline 過咗會每 2 秒送 `game:nudge`（serverless 無 timer，靠 client 觸發 lazy expiry）。
- **Hello 順序**：presence-hub 收到 hello 必須先同步 register/bind gameHub，先至好 await 任何 Redis 操作 — 否則 client 即刻射嘅 `game:join` 會用 undefined clientId 整成幽靈座位。
- **測試工具**：
  - `scripts/game13-sim.ts` — 單 process 引擎模擬，驗證牌數守恆
  - `scripts/game13-race.ts` — 兩個獨立 process 各自 GameHub 打同一 Redis，驗證鎖
  - `~/.hermes/scripts/game13-e2e.js` — Playwright 4 人完整局 E2E（BASE_URL 切換環境；bot 揀 lane 要 fallback 尾→中→頭，因為 lane 有容量上限）
