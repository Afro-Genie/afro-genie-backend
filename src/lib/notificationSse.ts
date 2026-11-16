import type { Response } from 'express';
import type { Notification } from '@prisma/client';
import { logger } from './logger';

type NotificationClient = { res: Response; alive: boolean };

const clientsByUser = new Map<string, Set<NotificationClient>>();
const HEARTBEAT_MS = 30 * 1000;
const MAX_CLIENTS_PER_USER = 10;

const encodeNotification = (notification: Notification): string =>
  `event: notification\ndata: ${JSON.stringify(notification)}\n\n`;

export function registerNotificationClient(userId: string, res: Response): () => void {
  let clients = clientsByUser.get(userId);
  if (!clients) {
    clients = new Set();
    clientsByUser.set(userId, clients);
  }

  const client: NotificationClient = { res, alive: true };
  if (clients.size >= MAX_CLIENTS_PER_USER) {
    const [oldest] = clients;
    if (oldest) {
      clients.delete(oldest);
      oldest.alive = false;
      oldest.res.end();
    }
  }
  clients.add(client);

  res.write('retry: 3000\n\n');
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
    clients?.delete(client);
    if (clients?.size === 0) clientsByUser.delete(userId);
  };
}

export function sendNotificationUpdate(notification: Notification): void {
  const clients = clientsByUser.get(notification.userId);
  if (!clients?.size) return;

  const payload = encodeNotification(notification);
  for (const client of clients) {
    if (!client.alive) continue;
    try {
      client.res.write(payload);
    } catch (err) {
      logger.error({ err, userId: notification.userId }, 'Notification SSE write failed');
      client.alive = false;
      try {
        client.res.end();
      } catch {
        // The connection is already unusable.
      }
      clients.delete(client);
    }
  }

  if (clients.size === 0) clientsByUser.delete(notification.userId);
}
