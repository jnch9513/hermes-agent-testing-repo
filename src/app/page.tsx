"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Entry = { userId: string; name: string; room: string | null };

const ROOMS = [
  { id: "poker-a", label: "房A · 撲克牌 🃏" },
  { id: "chess-b", label: "房B · 象棋 ♟️" },
] as const;

const KEY = "hw_user";

export default function Home() {
  const router = useRouter();
  const [me, setMe] = useState<{ userId: string; name: string } | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [users, setUsers] = useState<Entry[]>([]);
  const [room, setRoom] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const beat = useCallback(async (userId: string, name: string, room: string | null) => {
    try {
      await fetch("/api/presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, name, room }),
      });
      const res = await fetch("/api/presence", { cache: "no-store" });
      const data = await res.json();
      setUsers(data.users ?? []);
    } catch {}
  }, []);

  const login = () => {
    const name = nameInput.trim();
    if (!name) return;
    const userId = crypto.randomUUID();
    localStorage.setItem(KEY, JSON.stringify({ userId, name }));
    setMe({ userId, name });
  };

  useEffect(() => {
    const saved = localStorage.getItem(KEY);
    if (saved) setMe(JSON.parse(saved));
  }, []);

  // heartbeat + poll every 3s
  useEffect(() => {
    if (!me) return;
    beat(me.userId, me.name, room);
    timer.current = setInterval(() => beat(me.userId, me.name, room), 3000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [me, room, beat]);

  const joinRoom = (id: string) => {
    setRoom(id);
    router.push(`/?room=${id}`);
  };
  const leaveRoom = () => {
    setRoom(null);
    router.push("/");
  };

  if (!me) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-950">
        <div className="flex w-80 flex-col gap-4 rounded-2xl bg-zinc-900 p-8">
          <h1 className="text-2xl font-bold text-white">入嚟玩 🎮</h1>
          <input
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && login()}
            placeholder="你個名"
            className="rounded-lg bg-zinc-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-emerald-500"
          />
          <button
            onClick={login}
            className="rounded-lg bg-emerald-600 py-2 font-semibold text-white hover:bg-emerald-500"
          >
            進入
          </button>
        </div>
      </main>
    );
  }

  const online = users;

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-6 text-white">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-bold">🎮 大廳</h1>
        <span className="text-sm text-zinc-400">
          你: <b className="text-emerald-400">{me.name}</b>
          {room && ` · 在 ${ROOMS.find((r) => r.id === room)?.label ?? room}`}
        </span>
      </header>

      {/* Online list */}
      <section className="rounded-2xl bg-zinc-900 p-5">
        <h2 className="mb-3 text-sm font-semibold tracking-wide text-zinc-400 uppercase">
          緊上線 {online.length} 人
        </h2>
        <ul className="flex flex-wrap gap-2">
          {online.map((u) => {
            const inRoom = u.room && u.room !== "lobby" ? ROOMS.find((r) => r.id === u.room)?.label : null;
            return (
              <li
                key={u.userId}
                className="flex items-center gap-2 rounded-full bg-zinc-800 px-3 py-1.5 text-sm"
              >
                <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
                {u.name}
                {inRoom && <span className="text-xs text-amber-400">· {inRoom}</span>}
                {u.userId === me.userId && <span className="text-xs text-zinc-500">(你)</span>}
              </li>
            );
          })}
          {online.length === 0 && <li className="text-sm text-zinc-500">冇人喺線…</li>}
        </ul>
      </section>

      {/* Rooms */}
      <section className="grid gap-3 sm:grid-cols-2">
        {ROOMS.map((r) => {
          const count = users.filter((u) => u.room === r.id).length;
          const inside = room === r.id;
          return (
            <div
              key={r.id}
              className={`rounded-2xl border p-5 ${
                inside ? "border-emerald-500 bg-zinc-800" : "border-zinc-800 bg-zinc-900"
              }`}
            >
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">{r.label}</h3>
                <span className="text-xs text-zinc-400">{count} 人</span>
              </div>
              {inside ? (
                <>
                  <p className="mt-3 text-sm text-zinc-400">你已經喺呢間房。</p>
                  <button
                    onClick={leaveRoom}
                    className="mt-3 rounded-lg bg-zinc-700 px-4 py-1.5 text-sm hover:bg-zinc-600"
                  >
                    離開房
                  </button>
                </>
                ) : (
                <button
                  onClick={() => joinRoom(r.id)}
                  className="mt-3 rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium hover:bg-emerald-500"
                >
                  入房
                </button>
              )}
            </div>
          );
        })}
      </section>
    </main>
  );
}
