import { NextResponse } from "next/server";
import { snapshot, touch } from "@/lib/presence";

export const dynamic = "force-dynamic";

// GET /api/presence -> who's online + which room they're in
export async function GET() {
  return NextResponse.json({ users: snapshot() }, { headers: { "Cache-Control": "no-store" } });
}

// POST /api/presence  body: { userId, name, room | null }
export async function POST(req: Request) {
  const { userId, name, room } = await req.json();
  if (!userId || !name) {
    return NextResponse.json({ error: "userId and name required" }, { status: 400 });
  }
  // room === null means "in lobby, online". Only explicit leave=true removes the user.
  if (room) touch(userId, name, room);
  else touch(userId, name, "lobby");
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
