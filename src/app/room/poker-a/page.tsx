"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { ThemeToggle } from "@/components/theme-toggle";

type Card = { rank: number; suit: string };
type Placed = { lane: string; card: Card };
type PlayerView = {
  clientId: string;
  name: string;
  handCount: number;
  placed: Placed[];
  ready: boolean;
  online: boolean;
};
type GameStateView = {
  phase: "waiting" | "dealing" | "picking" | "revealing" | "scored" | string;
  round: number | null;
  mustPlace: number;
  mustDiscard: boolean;
  deadlineMs: number | null;
  players: PlayerView[];
  myHand: Card[];
  allHands: Record<string, { top: string[]; middle: string[]; bottom: string[] }> | null;
  scores: Record<string, number> | null;
};

const KEY = "hw_user";
const SUIT_ORDER: Record<string, number> = { "♠": 0, "♥": 1, "♦": 2, "♣": 3 };

function cardLabel(c: Card): string {
  const labels: Record<number, string> = {
    11: "J", 12: "Q", 13: "K", 14: "A",
  };
  return `${labels[c.rank] ?? c.rank}${c.suit}`;
}

export default function GameRoom() {
  const router = useRouter();
  const [me, setMe] = useState<{ userId: string; name: string } | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [conn, setConn] = useState<ConnectionState>("connecting");
  const [game, setGame] = useState<GameStateView | null>(null);
  const [selected, setSelected] = useState<Card[]>([]);
  const [targetLane, setTargetLane] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const sentHello = useRef(false);

  const onMessage = useCallback((data: string) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === "game:state") {
        setGame({
          phase: msg.phase,
          round: msg.round,
          mustPlace: msg.mustPlace,
          mustDiscard: msg.mustDiscard,
          deadlineMs: msg.deadlineMs,
          players: msg.players,
          myHand: msg.myHand ?? [],
          allHands: msg.allHands ?? null,
          scores: msg.scores ?? null,
        });
        setError(null);
      } else if (msg.type === "game:error") {
        setError(msg.message);
        setTimeout(() => setError(null), 3000);
      }
    } catch {}
  }, []);

  const { connectionState, send } = useReconnectingSocket(
    () => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`,
    onMessage
  );
  useEffect(() => setConn(connectionState), [connectionState]);

  // tick for countdown
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  // Nudge: when the timer hits 0 but nobody has acted since, keep pinging the
  // server so the lazy expiry settles the round (serverless has no timers).
  useEffect(() => {
    if (game?.phase !== "picking" || !game.deadlineMs) return;
    const deadline = game.deadlineMs;
    const t = setInterval(() => {
      if (Date.now() >= deadline) {
        send(JSON.stringify({ type: "game:nudge" }));
      }
    }, 2000);
    return () => clearInterval(t);
  }, [game?.phase, game?.deadlineMs, send]);

  const login = () => {
    const name = nameInput.trim();
    if (!name) return;
    localStorage.setItem(KEY, JSON.stringify({ userId: crypto.randomUUID(), name }));
    setMe({ userId: crypto.randomUUID(), name });
  };

  useEffect(() => {
    const saved = localStorage.getItem(KEY);
    if (saved) setMe(JSON.parse(saved));
  }, []);

  // hello → binds clientId to game socket
  useEffect(() => {
    if (!me || conn !== "connected") return;
    if (!sentHello.current || true) {
      send(
        JSON.stringify({ type: "hello", clientId: me.userId, name: me.name })
      );
      sentHello.current = true;
    }
  }, [me, conn, send]);

  // auto-join game on connect
  useEffect(() => {
    if (!me || conn !== "connected") return;
    send(JSON.stringify({ type: "game:join", name: me.name }));
  }, [me, conn, game?.phase === undefined, send]);

  const act = useCallback(
    (obj: object) => {
      send(JSON.stringify(obj));
    },
    [send]
  );

  // ---- card interactions
  const toggleSelect = (card: Card) => {
    if (game?.phase !== "picking") return;
    setSelected((prev) => {
      const exists = prev.find((c) => c.rank === card.rank && c.suit === card.suit);
      if (exists) return prev.filter((c) => !(c.rank === card.rank && c.suit === card.suit));
      // limit selection: remaining placements this round
      const mine = game.players.find((p) => p.clientId === me?.userId);
      const alreadyPlaced = mine ? countMyPlacedThisRound(mine) : 0;
      const canPlaceMore =
        mine && game.mustPlace > 0
          ? game.mustPlace - Math.min(alreadyPlaced, game.mustPlace)
          : 0;
      const needDiscard = game.mustDiscard && alreadyPlaced >= game.mustPlace;
      if (!needDiscard && canPlaceMore <= prev.length) return prev;
      return [...prev, card];
    });
  };

  const placeSelected = (lane: string) => {
    if (selected.length !== 1 || !me) return;
    act({ type: "game:place", card: selected[0], lane });
    setSelected([]);
    setTargetLane(null);
  };

  const discardSelected = () => {
    if (selected.length !== 1) return;
    act({ type: "game:discard", card: selected[0] });
    setSelected([]);
  };

  const countMyPlacedThisRound = (p: PlayerView): number => {
    // Server tracks this; approximate from UI by total placed vs known rounds.
    // For simplicity show server-provided state; the engine enforces limits.
    return p.placed.length % 100; // placeholder — server enforces real limit
  };

  // ---- derived
  const secondsLeft = game?.deadlineMs ? Math.max(0, Math.ceil((game.deadlineMs - now) / 1000)) : null;
  const meInGame = game?.players.find((p) => p.clientId === me?.userId);

  // login gate
  if (!me) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Card className="w-80">
          <CardHeader>
            <CardTitle className="text-xl">🎴 幸運十三張</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Input
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && login()}
              placeholder="你個名"
            />
            <Button onClick={login}>進入</Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  const phaseLabel: Record<string, string> = {
    waiting: "等緊人",
    dealing: "派牌中",
    picking: `第 ${game?.round} 回 · 揀牌`,
    revealing: "開牌！",
    scored: "結算",
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-4 p-4 bg-background text-foreground">
      {/* header */}
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 whitespace-nowrap">
          <Button variant="ghost" size="sm" onClick={() => router.push("/")}>
            ← 大廳
          </Button>
          <h1 className="text-lg font-bold">🎴 幸運十三張</h1>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
          <span
            className={`h-2 w-2 rounded-full ${
              conn === "connected"
                ? "bg-emerald-500"
                : conn === "connecting"
                  ? "animate-pulse bg-amber-500"
                  : "bg-red-500"
            }`}
          />
          {me.name}
          <ThemeToggle />
        </div>
      </header>

      {/* status bar */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border px-4 py-2.5 text-sm">
        <Badge variant={game?.phase === "picking" ? "default" : "secondary"}>
          {phaseLabel[game?.phase ?? "waiting"] ?? game?.phase}
        </Badge>
        {secondsLeft !== null && game?.phase === "picking" && (
          <span className={`font-mono font-bold ${secondsLeft <= 5 ? "text-red-500" : ""}`}>
            ⏱ {secondsLeft}s
          </span>
        )}
        {game?.mustDiscard && game.phase === "picking" && (
          <span className="text-xs text-muted-foreground">要揀 {game.mustPlace} 張擺 + 棄 1 張</span>
        )}
        {!game?.mustDiscard && game?.phase === "picking" && (
          <span className="text-xs text-muted-foreground">要擺 {game.mustPlace} 張</span>
        )}
        {error && <span className="text-xs font-medium text-red-500">{error}</span>}
      </div>

      {/* waiting / start */}
      {(!game || game.phase === "waiting") && (
        <Card>
          <CardContent className="flex flex-col items-start gap-4 pt-6">
            <div>
              <p className="mb-2 text-sm text-muted-foreground">
                玩家 ({(game?.players.length ?? 0)}/4)
              </p>
              <div className="flex flex-wrap gap-2">
                {(game?.players ?? []).map((p) => (
                  <Badge key={p.clientId} variant="outline" className="px-3 py-1.5">
                    {p.name}
                    {p.clientId === me.userId && (
                      <span className="ml-1 text-muted-foreground">(你)</span>
                    )}
                  </Badge>
                ))}
              </div>
            </div>
            <Button
              onClick={() =>
                act(
                  (game?.players.length ?? 0) === 0
                    ? { type: "game:join", name: me.name }
                    : { type: "game:start" }
                )
              }
              disabled={(game?.players.length ?? 0) < 2 && (game?.players.length ?? 0) > 0}
            >
              {(game?.players.length ?? 0) === 0 ? "開枱" : "開始遊戲"}
            </Button>
            <p className="text-xs text-muted-foreground">最少 2 人，最多 4 人</p>
          </CardContent>
        </Card>
      )}

      {/* game table */}
      {game && game.phase !== "waiting" && (
        <>
          {/* opponents */}
          <div className="grid grid-cols-2 gap-2 min-[600px]:grid-cols-3">
            {game.players
              .filter((p) => p.clientId !== me.userId)
              .map((p) => (
                <Card key={p.clientId} className="py-3">
                  <CardContent className="flex items-center justify-between px-4 py-0">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          p.online ? "bg-emerald-500" : "bg-zinc-500"
                        }`}
                      />
                      {p.name}
                      {p.ready && game.phase === "picking" && <span title="準備好">✓</span>}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">🂠 {p.handCount}</span>
                      {game.scores && (
                        <Badge variant={Number(game.scores[p.clientId]) > 0 ? "default" : "secondary"}>
                          {game.scores[p.clientId]}
                        </Badge>
                      )}
                    </div>
                  </CardContent>
                  {/* their lanes mini-view */}
                  <div className="mt-2 flex gap-1 px-4 pb-1">
                    {(["top", "middle", "bottom"] as const).map((lane) => {
                      const cards = p.placed.filter((pl) => pl.lane === lane);
                      return (
                        <div
                          key={lane}
                          className="min-h-8 flex-1 rounded border border-dashed border-border/60 p-0.5 text-[10px]"
                        >
                          {cards.map((pl, i) => (
                            <span key={i} className="mx-px inline-block rounded bg-accent px-0.5">
                              {cardLabel(pl.card)}
                            </span>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </Card>
              ))}
          </div>

          {/* reveal overlay info */}
          {game.phase === "revealing" && game.allHands && (
            <Card className="border-amber-500/50">
              <CardContent className="pt-4 text-sm">全部開牌…</CardContent>
            </Card>
          )}

          {/* my board: three lanes */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                我嘅十三張（頭3 · 中5 · 尾5）
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {(["bottom", "middle", "top"] as const).map((lane) => {
                const laneName = lane === "top" ? "頭道 ×3" : lane === "middle" ? "中道 ×5" : "尾道 ×5";
                const cards = meInGame?.placed.filter((pl) => pl.lane === lane) ?? [];
                const isTarget = targetLane === lane;
                return (
                  <button
                    key={lane}
                    disabled={!isTarget && targetLane !== null}
                    onClick={() => isTarget && placeSelected(lane)}
                    className={`flex min-h-12 items-center gap-1.5 rounded-lg border p-2 text-left transition-colors ${
                      isTarget
                        ? "border-emerald-500 bg-emerald-500/10 ring-1 ring-emerald-500/40"
                        : "border-border"
                    } ${targetLane !== null && !isTarget ? "opacity-40" : ""}`}
                  >
                    <span className="mr-1 w-14 shrink-0 text-xs text-muted-foreground">{laneName}</span>
                    {cards.map((pl, i) => (
                      <span key={i} className="rounded bg-accent px-1.5 py-0.5 font-mono text-sm">
                        {cardLabel(pl.card)}
                      </span>
                    ))}
                    {cards.length === 0 && (
                      <span className="text-xs text-muted-foreground/50">— 空 —</span>
                    )}
                  </button>
                );
              })}
            </CardContent>
          </Card>

          {/* my hand */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between text-sm font-medium text-muted-foreground">
                <span>
                  手牌（{game.myHand.length}）
                  {game.phase === "picking" && (
                    selected.length === 1 ? (
                      game.mustDiscard && meInGame && myPlacedThisRound(game, me.userId) >= game.mustPlace
                        ? " — 揀好咗，撳「棄呢張」"
                        : " — 揀條 lane 放落去"
                    ) : (
                      ""
                    )
                  )}
                </span>
                {selected.length === 1 && game.phase === "picking" && (
                  <div className="flex gap-2">
                    {myPlacedThisRound(game, me.userId) >= game.mustPlace && game.mustDiscard ? (
                      <Button size="sm" variant="destructive" onClick={discardSelected}>
                        棄呢張
                      </Button>
                    ) : (
                      <>
                        {(["top", "middle", "bottom"] as const).map((l) => (
                          <Button key={l} size="sm" variant="outline" onClick={() => placeSelected(l)}>
                            放{["頭", "中", "尾"][["top","middle","bottom"].indexOf(l)]}道
                          </Button>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex min-h-16 flex-wrap content-start gap-1.5">
              {[...game.myHand]
                .sort((x, y) => y.rank - x.rank || SUIT_ORDER[x.suit] - SUIT_ORDER[y.suit])
                .map((c) => {
                  const sel = selected.some((s) => s.rank === c.rank && s.suit === c.suit);
                  return (
                    <button
                      key={`${c.rank}${c.suit}`}
                      onClick={() => toggleSelect(c)}
                      className={`rounded-md border px-2.5 py-1.5 font-mono text-sm transition-all ${
                        sel
                          ? "-translate-y-1 border-emerald-500 bg-emerald-500/15 ring-1 ring-emerald-500/50"
                          : "border-border hover:border-foreground/30"
                      }`}
                    >
                      {cardLabel(c)}
                    </button>
                  );
                })}
              {game.myHand.length === 0 && (
                <span className="text-sm text-muted-foreground">
                  {game.phase === "picking" ? "冇牌剩 — 等其他人 ✓" : "—"}
                </span>
              )}
            </CardContent>
          </Card>

          {/* scores */}
          {game.phase === "scored" && game.scores && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">🏁 結算</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col gap-1.5">
                  {[...game.players]
                    .sort((x, y) => (game.scores![y.clientId] ?? 0) - (game.scores![x.clientId] ?? 0))
                    .map((p) => (
                      <div key={p.clientId} className="flex items-center justify-between text-sm">
                        <span>
                          {p.name}
                          {p.clientId === me.userId && (
                            <span className="text-muted-foreground"> (你)</span>
                          )}
                        </span>
                        <Badge variant={(game.scores![p.clientId] ?? 0) > 0 ? "default" : "secondary"}>
                          {(game.scores![p.clientId] ?? 0) > 0 ? "+" : ""}
                          {game.scores![p.clientId]}
                        </Badge>
                      </div>
                    ))}
                  <Button
                    className="mt-2 self-start"
                    onClick={() => act({ type: "game:create" })}
                  >
                    再嚟一鋪
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          <Separator />

          {/* ready button during picking */}
          {game.phase === "picking" && meInGame && !meInGame.ready && (
            <div className="fixed bottom-4 left-1/2 -translate-x-1/2">
              <Button
                size="lg"
                variant="outline"
                onClick={() => act({ type: "game:ready" })}
                className="bg-background shadow-lg"
              >
                ✓ 準備好
              </Button>
            </div>
          )}
        </>
      )}
    </main>
  );
}

function myPlacedThisRound(game: GameStateView, clientId: string): number {
  // The engine enforces real limits; this is a rough UI estimate based on hand size.
  // R1: started with 5; R2-4: 3; R5: 2.
  const me = game.players.find((p) => p.clientId === clientId);
  if (!me) return 0;
  const startSize = game.round === 1 ? 5 : game.round === 5 ? game.players.length > 0 ? 2 : 2 : 3;
  return Math.max(0, startSize - game.myHand.length);
}
