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
type Placed = { lane: string; card: Card | null; round?: number };
type PlayerView = {
  clientId: string;
  name: string;
  handCount: number;
  placedThisRound: number;
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
  revealUntilMs?: number | null;
  players: PlayerView[];
  myHand: Card[];
  allHands: Record<string, { top: string[]; middle: string[]; bottom: string[] }> | null;
  scores: Record<string, number> | null;
};

const KEY = "hw_user";
const SUIT_ORDER: Record<string, number> = { "♠": 0, "♥": 1, "♦": 2, "♣": 3 };
const RANK_LABEL: Record<number, string> = { 11: "J", 12: "Q", 13: "K", 14: "A" };
const IS_RED = (suit: string) => suit === "♥" || suit === "♦";

function rankLabel(rank: number): string {
  return RANK_LABEL[rank] ?? String(rank);
}

/** Real playing-card look: corner index + big centre pip. */
function PlayingCard({
  card,
  size = "md",
  className = "",
}: {
  card: Card | null; // null = face-down back
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  if (!card) {
    // Card back
    return (
      <div
        className={`relative shrink-0 rounded-md border border-slate-700 bg-gradient-to-br from-blue-900 to-slate-900 shadow-sm ${sizeClass(size)} ${className}`}
      >
        <div className="absolute inset-[3px] rounded-[4px] border border-white/20" />
        <div className="flex h-full items-center justify-center text-white/40">
          <span className={size === "lg" ? "text-lg" : "text-xs"}>🎴</span>
        </div>
      </div>
    );
  }
  const red = IS_RED(card.suit);
  return (
    <div
      className={`relative shrink-0 rounded-md border border-zinc-300 bg-white shadow-sm dark:border-zinc-500 ${sizeClass(size)} ${className}`}
    >
      {/* corner index */}
      <div
        className={`absolute left-0.5 top-0 leading-none font-semibold ${
          red ? "text-red-600" : "text-zinc-900"
        } ${size === "sm" ? "text-[8px]" : size === "md" ? "text-[10px]" : "text-xs"}`}
      >
        {rankLabel(card.rank)}
        <br />
        {card.suit}
      </div>
      {/* centre pip */}
      <div className="flex h-full items-center justify-center">
        <span
          className={`${red ? "text-red-600" : "text-zinc-900"} ${
            size === "sm" ? "text-base" : size === "md" ? "text-xl" : "text-3xl"
          }`}
        >
          {card.suit}
        </span>
      </div>
    </div>
  );
}

function sizeClass(size: "sm" | "md" | "lg"): string {
  return size === "sm"
    ? "h-10 w-7"
    : size === "md"
      ? "h-14 w-10"
      : "h-20 w-14";
}

export default function GameRoom() {
  const router = useRouter();
  const [me, setMe] = useState<{ userId: string; name: string } | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [conn, setConn] = useState<ConnectionState>("connecting");
  const [game, setGame] = useState<GameStateView | null>(null);
  const [selected, setSelected] = useState<Card[]>([]);
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
          revealUntilMs: msg.revealUntilMs ?? null,
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

  // tick for countdown / reveal countdown / nudge checks
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  // Nudge server while a phase deadline has passed but nothing advanced yet
  // (serverless has no timers — clients drive lazy expiry).
  useEffect(() => {
    if (!game) return;
    const deadline =
      game.phase === "picking" ? game.deadlineMs :
      game.phase === "revealing" ? game.revealUntilMs ?? null : null;
    if (!deadline) return;
    const t = setInterval(() => {
      if (Date.now() >= deadline) send(JSON.stringify({ type: "game:nudge" }));
    }, 2000);
    return () => clearInterval(t);
  }, [game?.phase, game?.deadlineMs, game?.revealUntilMs, send]);

  const login = () => {
    const name = nameInput.trim();
    if (!name) return;
    const id = crypto.randomUUID();
    localStorage.setItem(KEY, JSON.stringify({ userId: id, name }));
    setMe({ userId: id, name });
  };

  useEffect(() => {
    const saved = localStorage.getItem(KEY);
    if (saved) setMe(JSON.parse(saved));
  }, []);

  // hello → binds clientId to game socket
  useEffect(() => {
    if (!me || conn !== "connected") return;
    if (!sentHello.current || true) {
      send(JSON.stringify({ type: "hello", clientId: me.userId, name: me.name }));
      sentHello.current = true;
    }
  }, [me, conn, send]);

  // auto-join game on connect
  useEffect(() => {
    if (!me || conn !== "connected") return;
    send(JSON.stringify({ type: "game:join", name: me.name }));
  }, [me, conn, send]);

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
      const mine = game.players.find((p) => p.clientId === me?.userId);
      const placedThisRound = mine?.placedThisRound ?? 0;
      const canPlaceMore = Math.max(0, game.mustPlace - placedThisRound);
      if (canPlaceMore <= prev.length) return prev;
      return [...prev, card];
    });
  };

  const placeSelected = (lane: string) => {
    if (selected.length !== 1 || !me) return;
    act({ type: "game:place", card: selected[0], lane });
    setSelected([]);
  };

  const pullBack = (pl: Placed) => {
    if (!pl.card) return;
    act({ type: "game:unplace", card: pl.card, lane: pl.lane });
  };

  // ---- derived
  const secondsLeft = game?.deadlineMs ? Math.max(0, Math.ceil((game.deadlineMs - now) / 1000)) : null;
  const revealLeft = game?.revealUntilMs && game.phase === "revealing" ? Math.max(0, Math.ceil((game.revealUntilMs - now) / 1000)) : null;
  const meInGame = game?.players.find((p) => p.clientId === me?.userId);
  const pickingRound = game?.round ?? null;
  const myPlacedThisRound = meInGame?.placedThisRound ?? 0;
  const canPlaceMore = game ? Math.max(0, game.mustPlace - myPlacedThisRound) : 0;
  const readyEnabled = !!game && game.phase === "picking" && myPlacedThisRound >= game.mustPlace;
  // R2-4: after placing enough, leftover hand cards are locked (✕) — implicit discard.
  const lockHand = !!game && game.phase === "picking" && readyEnabled;

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
    revealing: `第 ${game?.round} 回完成 · 全桌翻開`,
    scored: "結算",
  };

  // Display order: 上(top×3) → 中(middle×5) → 下(bottom×5)
  const LANES = [
    { key: "top", label: "上 ×3" },
    { key: "middle", label: "中 ×5" },
    { key: "bottom", label: "下 ×5" },
  ] as const;

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
          <span className={`font-mono font-bold ${secondsLeft <= 10 ? "text-red-500" : ""}`}>
            ⏱ {secondsLeft}s
          </span>
        )}
        {revealLeft !== null && (
          <span className="font-mono font-bold text-amber-500">翻開中 · {revealLeft}s</span>
        )}
        {game?.phase === "picking" && (
          <span className="text-xs text-muted-foreground">要擺 {game.mustPlace} 張（已擺 {myPlacedThisRound}）</span>
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
                  {/* their lanes mini-view — fresh picks show as face-down backs */}
                  <div className="mt-2 flex gap-1 px-4 pb-1">
                    {LANES.map(({ key }) => {
                      const cards = p.placed.filter((pl) => pl.lane === key);
                      return (
                        <div
                          key={key}
                          className="min-h-8 flex-1 rounded border border-dashed border-border/60 p-0.5"
                        >
                          <div className="flex flex-wrap gap-px">
                            {cards.map((pl, i) =>
                              pl.card ? (
                                <PlayingCard key={i} card={pl.card} size="sm" className="scale-[0.8] origin-left" />
                              ) : (
                                <PlayingCard key={i} card={null} size="sm" className="scale-[0.8] origin-left" />
                              )
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </Card>
              ))}
          </div>

          {/* my board: 上 → 中 → 下 */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                我嘅十三張（上3 · 中5 · 下5）
                {game.phase === "picking" && canPlaceMore > 0 && selected.length === 1 && (
                  <span className="ml-2 text-emerald-600">— 撳條 lane 放落去</span>
                )}
                {game.phase === "picking" && myPlacedThisRound > 0 && (
                  <span className="ml-2 text-muted-foreground">（綠框 = 本回合，可以撳返上手）</span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {LANES.map(({ key, label }) => {
                const cards = meInGame?.placed.filter((pl) => pl.lane === key) ?? [];
                const isTarget = selected.length === 1 && game.phase === "picking";
                return (
                  <button
                    key={key}
                    disabled={!isTarget}
                    onClick={() => isTarget && placeSelected(key)}
                    className={`flex min-h-16 items-center gap-2 rounded-lg border p-2 text-left transition-colors ${
                      isTarget
                        ? "border-emerald-500 bg-emerald-500/10 ring-1 ring-emerald-500/40"
                        : "border-border"
                    }`}
                  >
                    <span className="mr-1 w-12 shrink-0 text-xs text-muted-foreground">{label}</span>
                    <span className="flex flex-wrap gap-1">
                      {cards.map((pl, i) => {
                        const adjustable =
                          game.phase === "picking" && pl.round === pickingRound;
                        return (
                          <span
                            key={i}
                            role={adjustable ? "button" : undefined}
                            title={adjustable ? "撳一下收返上手" : undefined}
                            onClick={(e) => {
                              if (!adjustable) return;
                              e.stopPropagation();
                              pullBack(pl);
                            }}
                            className={`relative inline-block ${adjustable ? "-translate-y-0.5 cursor-pointer ring-2 ring-emerald-500 rounded-md" : ""}`}
                          >
                            <PlayingCard card={pl.card} size="sm" />
                          </span>
                        );
                      })}
                      {cards.length === 0 && (
                        <span className="text-xs text-muted-foreground/50">— 空 —</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </CardContent>
          </Card>

          {/* my hand */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                手牌（{game.myHand.length}）
                {lockHand && (
                  <span className="ml-2 text-amber-600">
                    剩低嗰張會喺回合結束自動棄走 — 撳「準備好」開牌
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex min-h-24 flex-wrap content-start gap-2">
              {[...game.myHand]
                .sort((x, y) => y.rank - x.rank || SUIT_ORDER[x.suit] - SUIT_ORDER[y.suit])
                .map((c, idx) => {
                  const sel = selected.some((s) => s.rank === c.rank && s.suit === c.suit);
                  const isLockedLast = lockHand && game.myHand.length - idx === 1; // rightmost leftover
                  const disabled = lockHand || game.phase !== "picking" || canPlaceMore === 0;
                  return (
                    <button
                      key={`${c.rank}${c.suit}`}
                      onClick={() => toggleSelect(c)}
                      disabled={disabled}
                      className={`relative rounded-md transition-all ${
                        sel ? "-translate-y-1.5" : ""
                      } ${disabled ? "cursor-not-allowed opacity-90" : "hover:-translate-y-0.5"}`}
                    >
                      <PlayingCard
                        card={c}
                        size="lg"
                        className={
                          sel
                            ? "!border-emerald-500 ring-2 ring-emerald-500/60"
                            : disabled
                              ? "grayscale-[35%]"
                              : ""
                        }
                      />
                      {isLockedLast && (
                        <span className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-[11px] font-bold text-white shadow">
                          ✕
                        </span>
                      )}
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
                disabled={!readyEnabled}
                onClick={() => act({ type: "game:ready" })}
                className="bg-background shadow-lg"
              >
                ✓ 準備好{readyEnabled ? "" : `（仲擺 ${canPlaceMore} 張）`}
              </Button>
            </div>
          )}
        </>
      )}
    </main>
  );
}
