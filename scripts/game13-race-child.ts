// Child process: one GameHub instance in THIS process. Both roles drive the SAME
// shared rooms (env RACE_ROOM / RACE_ROOM-exp) concurrently. Verifies the
// distributed lock keeps mutations serialized across instances:
//   A) full 5-round game with same-player double-fires → completes, 52 cards conserved
//   B) forced timer-expiry race → exactly one round advance
import Redis from "ioredis";
import { getGameHub } from "../src/lib/game13/game-hub";

const ROLE = process.argv[2] as "a" | "b";
const ROOM = process.env.RACE_ROOM!;
const ROOM2 = ROOM + "-exp";
const REDIS_URL =
  process.env.REDIS_URL ||
  "redis://default:A78wB4h4ZzTdxXohNcUxXp0xmIunjkgu@candescent-dock-malt-79129.db.redis.io:14261";

const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
const hub = getGameHub(redis);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeSocket(): any {
  return {
    readyState: 1,
    OPEN: 1,
    send: (s: string) => {
      try {
        const m = JSON.parse(s);
        // Lock-contention rejections are expected & retried by callers.
        if (m.type === "game:error" && !/room busy/.test(m.message)) {
          console.log(`[${ROLE}] game:error: ${m.message}`);
        }
      } catch {}
    },
  };
}
const sockets = new Map<string, any>();

/** Bind socket under an EXACT key so send(key,...) finds it. */
function bind(key: string, room: string): void {
  const ws = fakeSocket();
  sockets.set(key, ws);
  hub.registerSocket(room, ws);
  hub.bindClient(room, ws, key);
}

async function send(key: string, msg: object, room: string): Promise<void> {
  await hub.handleMessage(room, sockets.get(key), JSON.stringify(msg));
}

async function stateOf(room: string): Promise<any> {
  const raw = await redis.get(`game13:${room}`);
  return raw ? JSON.parse(raw) : null;
}

async function waitForState(room: string, timeoutMs = 12000): Promise<any> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = await stateOf(room);
    if (s) return s;
    await sleep(100);
  }
  return null;
}

function cardsTotal(s: any): number {
  return (
    s.players.reduce((n: number, p: any) => n + p.placed.length + p.hand.length, 0) +
    s.drawPile.length +
    s.discardPile.length
  );
}

async function playRoundFor(key: string, room: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const s = await stateOf(room);
    if (!s?.round || s.phase !== "picking") return;
    const p = s.players.find((x: any) => x.clientId === key);
    if (!p) return;
    if (p.placedThisRound < s.round.mustPlace && p.hand.length > 0) {
      const caps = { top: 3, middle: 5, bottom: 5 } as const;
      const lane = (["bottom", "middle", "top"] as const).find(
        (l) => p.placed.filter((pl: any) => pl.lane === l).length < caps[l]
      );
      if (!lane) return;
      await send(key, { type: "game:place", card: p.hand[0], lane }, room);
      await sleep(8);
      continue;
    }
    if (s.round.mustDiscard && p.hand.length > 0) {
      await send(key, { type: "game:discard", card: p.hand[0] }, room);
      await sleep(8);
      continue;
    }
    await send(key, { type: "game:ready" }, room);
    return;
  }
}

let scenarioAok = false;
let leakSeen = false;

async function main() {
  console.log(`[${ROLE}] rooms=${ROOM} (+ -exp), role=${ROLE}`);

  for (const k of ["a1", "a2", "b1", "b2"]) bind(k, ROOM);

  if (ROLE === "a") {
    await send("a1", { type: "game:create" }, ROOM);
    await send("a1", { type: "game:join", name: "KC" }, ROOM);
    await send("a2", { type: "game:join", name: "阿明" }, ROOM);
    await send("b1", { type: "game:join", name: "John" }, ROOM);
    await send("b2", { type: "game:join", name: "Susan" }, ROOM);
    await send("a1", { type: "game:start" }, ROOM);
  }

  // ---- Scenario A: concurrent play from two instances
  await waitForState(ROOM);
  await sleep(500);

  for (let expectRound = 1; expectRound <= 5; expectRound++) {
    const s0 = await stateOf(ROOM);
    if (!s0?.round || s0.phase !== "picking") break;
    const cur = s0.round.round;
    if (cur !== expectRound) break;

    await Promise.all([
      playRoundFor("a1", ROOM),
      playRoundFor("a2", ROOM),
      playRoundFor("b1", ROOM),
      playRoundFor("b2", ROOM),
      ROLE === "b" ? playRoundFor("a1", ROOM) : playRoundFor("b1", ROOM), // double-fire
    ]);

    let s: any = null;
    for (let i = 0; i < 200; i++) {
      s = await stateOf(ROOM);
      if (!s) break;
      if (s.phase !== "picking" || !s.round || s.round.round !== cur) break;
      await sleep(40);
    }
    if (!s) break;
    const total = cardsTotal(s);
    if (total !== 52) leakSeen = true;
    console.log(
      `[${ROLE}] R${cur} done → phase=${s.phase} next=${s.round?.round ?? "-"} totalCards=${total}${total !== 52 ? " ⚠️ LEAK" : ""}`
    );
    if (s.phase === "scored" || s.phase === "revealing") break;
  }

  const finalS = await stateOf(ROOM);
  scenarioAok =
    !!finalS && !leakSeen && (finalS.phase === "scored" || finalS.phase === "revealing");
  console.log(
    `[${ROLE}] scenario A ${scenarioAok ? "PASS ✓ (" + finalS.phase + ", 52 conserved)" : "FAIL ✗"}`
  );

  // ---- Scenario B: forced timer-expiry race
  if (ROLE === "a") {
    bind("e1", ROOM2);
    bind("e2", ROOM2);
    await send("e1", { type: "game:create" }, ROOM2);
    await send("e1", { type: "game:join", name: "KC" }, ROOM2);
    await send("e2", { type: "game:join", name: "阿明" }, ROOM2);
    await send("e1", { type: "game:start" }, ROOM2);
    const st = await waitForState(ROOM2);
    if (st?.round) {
      st.round.deadlineMs = Date.now() - 1000; // force expiry
      await redis.set(`game13:${ROOM2}`, JSON.stringify(st));
    }
  } else {
    await waitForState(ROOM2);
  }
  await sleep(600);

  await Promise.all([
    (async () => {
      // mutation path: place triggers expireIfDue inside the lock
      const st = await stateOf(ROOM2);
      if (!st || st.phase !== "picking") return;
      const key = "racer-" + ROLE;
      bind(key, ROOM2);
      hub.bindClient(ROOM2, sockets.get(key), st.players[0].clientId);
      await send(key, { type: "game:place", card: st.players[0].hand[0], lane: "bottom" }, ROOM2);
    })(),
    (async () => {
      // read path: pushSnapshot's locked lazy-expiry
      await hub.pushSnapshot(ROOM2);
    })(),
  ]);
  await sleep(700);

  const after = await stateOf(ROOM2);
  const singleAdvance =
    !!after &&
    after.round?.round === 2 &&
    cardsTotal(after) === 52 &&
    after.players.every((p: any) => p.hand.length <= 6);
  console.log(
    `[${ROLE}] expiry race → round=${after?.round?.round} hands=[${after?.players.map((p: any) => p.hand.length)}] draw=${after?.drawPile.length} discard=${after?.discardPile.length} → ${singleAdvance ? "PASS ✓ (one advance)" : "FAIL ✗"}`
  );

  // Parent verifies + cleans up; child exits 0 if it ran without crashing.
  redis.disconnect();
  console.log(`[${ROLE}] RESULT: done`);
  process.exit(0);
}

main().catch((e) => {
  console.error(`[${ROLE}] FATAL`, e);
  process.exit(1);
});
