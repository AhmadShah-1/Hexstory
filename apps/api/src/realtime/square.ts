import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { chatMessageSchema, isDisplayCell, type ClientToServerEvents, type ServerToClientEvents } from '@hexstory/shared';
import { SESSION_COOKIE, getSessionUser } from '../auth/sessions.js';
import type { Coordinator, RoomEvent } from '../coordination.js';
import type { Sql } from '../db.js';
import { POLICY } from '../policy.js';
import { getRules } from '../services/settings.js';
import { chatBlockReason, postMessage } from '../services/square.js';

interface SocketData {
  token: string | undefined;
  cell: string | null;
}
type SquareSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export interface Square {
  /** Tell everyone in a room that a message was removed by a moderator. Rejects if it could not be relayed. */
  messageHidden(cell: string, id: string): Promise<void>;
  /** Disconnects every client; call before the HTTP server closes (Fastify preClose). */
  close(): Promise<void>;
}

export interface SquareDeps {
  sql: Sql;
  appOrigin: string;
  coordinator: Coordinator;
  log: { error(obj: unknown, msg?: string): void };
  /** How often this instance refreshes its sockets' presence; tests shorten it. */
  heartbeatMs?: number;
}

const room = (cell: string) => `cell:${cell}`;
const UNAVAILABLE = 'The Square is having trouble right now. Please try again in a moment.';

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return undefined;
}

/**
 * The Square: one Socket.IO room per hex. Anyone can listen; posting requires a session.
 * Each socket is in at most one room at a time (the hex the panel is showing).
 *
 * Several instances may run at once (Vercel). Each WebSocket stays on the instance that accepted
 * it; every broadcast goes through the coordinator, and each instance relays it to its own
 * sockets. Messages are saved to PostgreSQL before they are broadcast, so clients that missed
 * something (reconnects, a Redis hiccup announced via `resync`) recover by refetching history.
 */
export async function attachSquare(server: HttpServer, deps: SquareDeps): Promise<Square> {
  const { coordinator, log } = deps;
  const heartbeatMs = deps.heartbeatMs ?? 20_000;
  // Presence entries outlive a few missed heartbeats, then expire: a crashed instance's sockets
  // stop counting within this window even though their disconnect handlers never ran.
  const presenceTtlMs = heartbeatMs * 3;
  const instanceId = randomUUID();

  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(server, {
    path: '/socket.io',
    serveClient: false,
    // Vercel has no sticky sessions, so long-polling requests would land on different instances.
    transports: ['websocket'],
    maxHttpBufferSize: 4_096,
    // Reject cross-site connections so the session cookie can't be used from another origin.
    // Browsers always send Origin on WebSocket upgrades; non-browser clients may omit it.
    allowRequest: (req, callback) => callback(null, !req.headers.origin || req.headers.origin === deps.appOrigin),
  });

  const member = (socket: SquareSocket) => `${instanceId}:${socket.id}`;
  const safely = (what: string, work: Promise<unknown>) => work.catch((err) => log.error({ err }, `square: ${what} failed`));

  const relay = (event: RoomEvent) => {
    const to = io.to(room(event.cell));
    if (event.type === 'message') to.emit('message', event.message);
    else if (event.type === 'hidden') to.emit('hidden', { id: event.id });
    else to.emit('presence', { cell: event.cell, count: event.count });
  };
  await coordinator.subscribe(relay, () => io.emit('resync'));

  const announcePresence = async (cell: string) => {
    await coordinator.publish({ type: 'presence', cell, count: await coordinator.countPresence(cell) });
  };

  io.on('connection', (socket) => {
    socket.data.token = readCookie(socket.handshake.headers.cookie, SESSION_COOKIE);
    socket.data.cell = null;

    // Per-connection flood control: too many events in a window drops the connection.
    let windowStart = Date.now();
    let events = 0;
    socket.use((_packet, next) => {
      if (Date.now() - windowStart > 10_000) {
        windowStart = Date.now();
        events = 0;
      }
      if (++events > POLICY.socketEventsPer10s) return socket.disconnect(true);
      next();
    });

    const leaveCurrent = () => {
      const previous = socket.data.cell;
      if (!previous) return;
      socket.leave(room(previous));
      socket.data.cell = null;
      safely('presence leave', coordinator.removePresence(previous, member(socket)).then(() => announcePresence(previous)));
    };

    socket.on('join', (cell, ack) => {
      if (typeof cell !== 'string' || !isDisplayCell(cell)) return;
      if (cell !== socket.data.cell) {
        leaveCurrent();
        socket.join(room(cell));
        socket.data.cell = cell;
        safely('presence join', coordinator.touchPresence(cell, [member(socket)], presenceTtlMs).then(() => announcePresence(cell)));
      }
      if (typeof ack === 'function') ack();
    });

    socket.on('leave', (cell) => {
      if (cell === socket.data.cell) leaveCurrent();
    });

    socket.on('send', async (data, ack) => {
      if (typeof ack !== 'function') return;
      try {
        const parsed = chatMessageSchema.safeParse(data);
        if (!parsed.success) return ack({ ok: false, error: 'Messages must be 1–500 characters.' });
        // Re-read the session on every message so bans and sign-outs apply immediately.
        const user = await getSessionUser(deps.sql, socket.data.token);
        const blocked = chatBlockReason(user, (await getRules(deps.sql)).chatMinAccountMinutes);
        if (blocked || !user) return ack({ ok: false, error: blocked ?? 'Sign in first.' });

        let free: boolean;
        try {
          // Shared across instances, so a user can't dodge the cooldown by opening more tabs.
          free = await coordinator.claim(`chat-cooldown:${user.id}`, POLICY.chatIntervalMs);
        } catch (err) {
          log.error({ err }, 'square: cooldown check failed');
          return ack({ ok: false, error: UNAVAILABLE });
        }
        if (!free) return ack({ ok: false, error: 'Slow down a little.' });

        const message = await postMessage(deps.sql, user, parsed.data.cell, parsed.data.body);
        try {
          await coordinator.publish({ type: 'message', cell: message.cell, message });
          ack({ ok: true });
        } catch (err) {
          // Saved, but other instances never heard of it. Show it here and say so; everyone
          // else gets it from history when they next reconnect or reopen the hex.
          log.error({ err }, 'square: publish failed');
          relay({ type: 'message', cell: message.cell, message });
          ack({ ok: true, delayed: true });
        }
      } catch (err) {
        log.error({ err }, 'square: send failed');
        ack({ ok: false, error: 'Something went wrong. Try again.' });
      }
    });

    socket.on('disconnect', () => {
      const cell = socket.data.cell;
      if (cell) safely('presence disconnect', coordinator.removePresence(cell, member(socket)).then(() => announcePresence(cell)));
    });
  });

  /**
   * Keeps this instance's presence entries alive and corrects counts its rooms see (entries of a
   * vanished instance expire). Runs once per instance, and only does work while sockets are open.
   */
  const refreshPresence = async () => {
    const byCell = new Map<string, string[]>();
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.cell) byCell.set(socket.data.cell, [...(byCell.get(socket.data.cell) ?? []), member(socket)]);
    }
    for (const [cell, members] of byCell) {
      await coordinator.touchPresence(cell, members, presenceTtlMs);
      io.to(room(cell)).emit('presence', { cell, count: await coordinator.countPresence(cell) });
    }
  };
  const heartbeat = setInterval(() => safely('presence heartbeat', refreshPresence()), heartbeatMs);
  heartbeat.unref();

  return {
    messageHidden: (cell, id) => coordinator.publish({ type: 'hidden', cell, id }),
    close: async () => {
      clearInterval(heartbeat);
      // Close every connection at the transport level, which clients treat as "reconnect" (a
      // Socket.IO-level disconnect would tell them to stay away). Open WebSockets would otherwise
      // keep the HTTP server from ever finishing its close.
      io.engine.close();
    },
  };
}
