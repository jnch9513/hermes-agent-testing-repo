// Wire protocol for the presence/game socket.
// Every frame is JSON: { type, ...payload }.

export const MAX_NAME_LENGTH = 32
export const MAX_CLIENT_ID_LENGTH = 64

/** One entry in the presence list. */
export interface PresenceUser {
  clientId: string
  name: string
  /** null = lobby; otherwise a room id ("poker-a" | "chess-b"). */
  room: string | null
}

// ---- Client → server ------------------------------------------------------

export type ClientFrame =
  | { type: 'hello'; clientId: string; name: string }
  | { type: 'join room'; room: string | null }

// ---- Server → client ------------------------------------------------------

export type ServerFrame =
  | { type: 'presence'; users: PresenceUser[] }
  | { type: 'user joined'; name: string }
  | { type: 'user left'; name: string }

export function parseClientFrame(raw: unknown): ClientFrame | null {
  if (typeof raw !== 'string') return null
  try {
    const f = JSON.parse(raw) as Record<string, unknown>
    switch (f.type) {
      case 'hello': {
        const clientId = String(f.clientId ?? '')
        const name = String(f.name ?? '')
        if (!clientId || !name) return null
        return {
          type: 'hello',
          clientId: clientId.slice(0, MAX_CLIENT_ID_LENGTH),
          name: name.slice(0, MAX_NAME_LENGTH),
        }
      }
      case 'join room': {
        const room = f.room === null || f.room === undefined ? null : String(f.room)
        return { type: 'join room', room }
      }
      default:
        return null
    }
  } catch {
    return null
  }
}
