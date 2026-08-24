// In-memory presence store (per serverless instance).
// Fine for a small friends group; swap for Redis/Pusher if we need cross-instance.
export type Entry = { userId: string; name: string; room: string; lastSeen: number };

const g = globalThis as unknown as { __presence?: Map<string, Entry> };
const store: Map<string, Entry> = (g.__presence ??= new Map());

const STALE_MS = 20_000; // prune users not seen for 20s

export function touch(userId: string, name: string, room: string) {
  const now = Date.now();
  const prev = store.get(userId);
  store.set(userId, { userId, name, room, lastSeen: now });
  return { rejoined: !!prev && prev.room !== room };
}

export function leave(userId: string) {
  store.delete(userId);
}

export function snapshot(): Entry[] {
  const now = Date.now();
  for (const [k, v] of store) if (now - v.lastSeen > STALE_MS) store.delete(k);
  return [...store.values()].sort((a, b) => a.name.localeCompare(b.name));
}
