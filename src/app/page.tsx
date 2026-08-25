"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  useReconnectingSocket,
  type ConnectionState,
} from "@/lib/use-reconnecting-socket";
import type { ClientFrame, PresenceUser, ServerFrame } from "@/lib/protocol";

const ROOMS = [
  { id: "poker-a", label: "房A · 撲克牌", emoji: "🃏" },
  { id: "chess-b", label: "房B · 象棋", emoji: "♟️" },
] as const;

const KEY = "hw_user";

export default function Home() {
  const router = useRouter();
  const [me, setMe] = useState<{ userId: string; name: string } | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [users, setUsers] = useState<PresenceUser[]>([]);
  const [room, setRoom] = useState<string | null>(null);
  const [conn, setConn] = useState<ConnectionState>("connecting");
  const helloSent = useRef(false);

  const onMessage = (data: string) => {
    try {
      const frame = JSON.parse(data) as ServerFrame;
      if (frame.type === "presence") setUsers(frame.users);
    } catch {}
  };
  const { connectionState, send } = useReconnectingSocket(
    () => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`,
    onMessage
  );
  useEffect(() => setConn(connectionState), [connectionState]);

  // login
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

  // send hello once socket is open + we know who we are
  useEffect(() => {
    if (!me || conn !== "connected") return;
    send(
      JSON.stringify({
        type: "hello",
        clientId: me.userId,
        name: me.name,
      } satisfies ClientFrame)
    );
  }, [me, conn, send]);

  // re-announce room after reconnect (hello resets room to lobby server-side)
  useEffect(() => {
    if (!me || conn !== "connected") return;
    if (helloSent.current) {
      send(JSON.stringify({ type: "join room", room }));
    } else {
      helloSent.current = true;
    }
  }, [me, conn, room, send]);

  const joinRoom = (id: string | null) => {
    setRoom(id);
    send(JSON.stringify({ type: "join room", room: id } satisfies ClientFrame));
    router.push(id ? `/?room=${id}` : "/");
  };

  if (!me) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Card className="w-80">
          <CardHeader>
            <CardTitle className="text-xl">🎮 入嚟玩</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Input
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && login()}
              placeholder="你個名"
            />
            <Button onClick={login}>進入大廳</Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  const inLobbyCount = users.filter((u) => !u.room || u.room === "lobby").length;

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-5 p-6 bg-background text-foreground">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-bold tracking-tight whitespace-nowrap">🎮 遊戲大廳</h1>
        <div className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
          <span
            className={`h-2 w-2 rounded-full ${
              conn === "connected"
                ? "bg-emerald-500"
                : conn === "connecting"
                  ? "animate-pulse bg-amber-500"
                  : "bg-red-500"
            }`}
            title={conn}
          />
          {me.name}
        </div>
      </header>
      <Separator />

      {/* Online list */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 whitespace-nowrap text-sm font-medium text-muted-foreground">
            緊上線
            <Badge variant="secondary">{users.length}</Badge>
            <span className="text-xs">· 大廳 {inLobbyCount}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2 pt-0">
          {users.map((u) => {
            const roomLabel =
              u.room && u.room !== "lobby"
                ? ROOMS.find((r) => r.id === u.room)?.label
                : null;
            return (
              <Badge
                key={u.clientId}
                variant="outline"
                className="max-w-full gap-1.5 px-3 py-1.5 text-sm"
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    roomLabel ? "bg-amber-500" : "animate-pulse bg-emerald-500"
                  }`}
                />
                <span className="truncate">{u.name}</span>
                {u.clientId === me.userId && <span className="text-muted-foreground">(你)</span>}
                {roomLabel && (
                  <span className="whitespace-nowrap font-medium text-amber-600 dark:text-amber-400">
                    · {roomLabel}
                  </span>
                )}
              </Badge>
            );
          })}
          {users.length === 0 && <p className="text-sm text-muted-foreground">冇人喺線…</p>}
        </CardContent>
      </Card>

      {/* Rooms */}
      <div className="grid gap-4 grid-cols-1 xs:grid-cols-2 sm:grid-cols-2">
        {ROOMS.map((r) => {
          const members = users.filter((u) => u.room === r.id);
          const inside = room === r.id;
          return (
            <Card
              key={r.id}
              className={`min-w-0 ${inside ? "border-emerald-500 ring-1 ring-emerald-500/40" : ""}`}
            >
              <CardHeader className="pb-2">
                <CardTitle className="whitespace-nowrap text-base">
                  {r.emoji} {r.label}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                {members.length > 0 && (
                  <div className="mb-3 flex flex-wrap gap-x-2">
                    {members.map((m) => (
                      <span key={m.clientId} className="text-xs text-muted-foreground">
                        {m.name}
                        {m.clientId === me.userId && "(你)"}
                      </span>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-3">
                  {inside ? (
                    <Button variant="outline" size="sm" onClick={() => joinRoom(null)}>
                      離開房
                    </Button>
                  ) : (
                    <Button size="sm" className="whitespace-nowrap" onClick={() => joinRoom(r.id)}>
                      入房
                    </Button>
                  )}
                  <Badge variant="secondary" className="shrink-0">
                    {members.length} 人
                  </Badge>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </main>
  );
}
