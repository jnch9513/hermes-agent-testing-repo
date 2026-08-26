// Parent: spawn TWO separate processes, each running its own GameHub against
// the SAME Redis — replicating Vercel horizontal scaling. Both hammer the same
// game rooms concurrently. Parent then verifies final Redis truth:
//   A) game reached scored/revealing with all 52 cards conserved
//   B) expiry race advanced exactly once (round=2)
import { spawn } from "node:child_process";
import Redis from "ioredis";

const REDIS_URL =
  process.env.REDIS_URL ||
  "redis://default:A78wB4h4ZzTdxXohNcUxXp0xmIunjkgu@candescent-dock-malt-79129.db.redis.io:14261";

async function main() {
  const here = process.cwd();
  const ROOM = `race-${Date.now().toString(36)}`;
  const ROOM2 = ROOM + "-exp";

  const procs = ["a", "b"].map((role) => {
    const p = spawn(
      process.execPath,
      ["--import", "tsx", "scripts/game13-race-child.ts", role],
      {
        cwd: here,
        env: { ...process.env, RACE_ROOM: ROOM },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    return { role, p, getOut: () => out };
  });

  const codes = await Promise.all(
    procs.map(({ p }) => new Promise<number>((res) => p.on("close", (c) => res(c ?? 1))))
  );
  for (const { role, getOut } of procs) {
    console.log(`\n===== role ${role} =====`);
    console.log(getOut().trim());
  }

  // ---- verify from Redis truth
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
  const rawA = await redis.get(`game13:${ROOM}`);
  const rawB = await redis.get(`game13:${ROOM2}`);
  await redis.del(`game13:${ROOM}`, `game13:${ROOM2}`);
  redis.disconnect();

  let ok = codes.every((c) => c === 0);
  if (!rawA) {
    console.log("\n[verify] room A state missing ✗");
    ok = false;
  } else {
    const a = JSON.parse(rawA);
    const total =
      a.players.reduce((n: number, p: any) => n + p.placed.length + p.hand.length, 0) +
      a.drawPile.length +
      a.discardPile.length;
    const aOk =
      (a.phase === "scored" || a.phase === "revealing") &&
      total === 52 &&
      !!a.scores;
    console.log(`[verify] A: phase=${a.phase} totalCards=${total} scores=${a.scores ? "yes" : "no"} → ${aOk ? "PASS ✓" : "FAIL ✗"}`);
    ok = ok && aOk;
  }
  if (!rawB) {
    console.log("[verify] room B already cleaned or missing ✗");
    ok = false;
  } else {
    const b = JSON.parse(rawB);
    const totalB =
      b.players.reduce((n: number, p: any) => n + p.placed.length + p.hand.length, 0) +
      b.drawPile.length +
      b.discardPile.length;
    const bOk = b.round?.round === 2 && totalB === 52;
    console.log(`[verify] B: round=${b.round?.round} phase=${b.phase} totalCards=${totalB} → ${bOk ? "PASS ✓" : "FAIL ✗"}`);
    ok = ok && bOk;
  }

  console.log(ok ? "\nRACE TEST PASS ✓" : "\nRACE TEST FAIL ✗");
  process.exit(ok ? 0 : 1);
}

main();
