import type { Response } from 'express';
import { logger } from './logger';

// ---------------------------------------------------------------------------
// Server-Sent Events hub for live token-balance updates (Phase 1, GT economy).
//
// Frontends open a single EventSource to GET /api/users/me/balance/stream and
// receive a `balance` event every time a ledger transaction commits for that
// user (award / spend / penalty / tax / adjust). Because EventSource cannot
// set an Authorization header, the stream endpoint authenticates the user via
// a ?token= query parameter (the JWT travels in the URL for SS events only;
// it is short-lived and scoped to the balance endpoint).
//
// The hub is process-local: every worker/instance holds its own Map. If the
// app ever scales horizontally, this can be upgraded to a Redis Pub/Sub bus
// with no change to the calling contract. A 30s comment heartbeat keeps
// intermediaries from dropping idle connections.
// ---------------------------------------------------------------------------

type SseClient = { res: Response; alive: boolean };

const clientsByUser = new Map<string, Set<SseClient>>();

const HEARTBEAT_MS = 30 * 1000;

const MAX_CLIENTS_PER_USER = 10;

const encodeSse = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export interface BalanceUpdate {
  balance: number;
  delta: number;
  type: string;
  reason: string;
  timestamp: string;
}

/**
 * Register an SSE response for a user. Returns a cleanup function that the
 * route must call when the connection closes. If the user already hit the
 * client cap, the oldest connection is dropped first.
 */
export function registerBalanceClient(userId: string, res: Response): () => void {
  let set = clientsByUser.get(userId);
  if (!set) {
    set = new Set();
    clientsByUser.set(userId, set);
  }

  const client: SseClient = { res, alive: true };

  if (set.size >= MAX_CLIENTS_PER_USER) {
    const [stale] = set;
    if (stale) {
      set.delete(stale);
      stale.alive = false;
      stale.res.end();
    }
  }

  set.add(client);

  res.write(encodeSse('connected', { heartbeat: HEARTBEAT_MS }));

  const heartbeat = setInterval(() => {
    if (!client.alive) {
      clearInterval(heartbeat);
      return;
    }
    res.write(`: ping ${Date.now()}\n\n`);
  }, HEARTBEAT_MS);

  return () => {
    clearInterval(heartbeat);
    client.alive = false;
    set.delete(client);
    if (set.size === 0) {
      clientsByUser.delete(userId);
    }
  };
}

/**
 * Broadcast a balance change to all open streams for the user. Fire-and-forget
 * on purpose: a slow/hung client must never block the reward transaction that
 * produced the change.
 */
export function sendBalanceUpdate(userId: string, update: BalanceUpdate): void {
  const set = clientsByUser.get(userId);
  if (!set || set.size === 0) return;

  const payload = encodeSse('balance', update);

  for (const client of set) {
    if (!client.alive) continue;
    try {
      client.res.write(payload);
    } catch (err) {
      logger.error({ err, userId }, 'SSE write failed; dropping client');
      client.alive = false;
      try {
        client.res.end();
      } catch {
        // ignored
      }
      set.delete(client);
    }
  }

  if (set.size === 0) {
    clientsByUser.delete(userId);
  }
}

export const balanceStreamStats = (): { totalClients: number } => {
  let total = 0;
  for (const set of clientsByUser.values()) total += set.size;
  return { totalClients: total };
};