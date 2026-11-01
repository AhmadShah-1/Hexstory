import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { chatMessageSchema, isDisplayCell, type ClientToServerEvents, type ServerToClientEvents } from '@hexstory/shared';
import { SESSION_COOKIE, getSessionUser } from '../auth/sessions.js';
import type { Sql } from '../db.js';
import { POLICY } from '../policy.js';
import { chatBlockReason, postMessage } from '../services/square.js';

interface SocketData {
  token: string | undefined;
  cell: string | null;
}

export interface Square {
  /** Tell everyone in a room that a message was removed by a moderator. */
  messageHidden(cell: string, id: string): void;
  close(): Promise<void>;
}

const room = (cell: string) => `cell:${cell}`;

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
 */
export function attachSquare(server: HttpServer, deps: { sql: Sql; appOrigin: string }): Square {
  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(server, {
    path: '/socket.io',
    serveClient: false,
    maxHttpBufferSize: 4_096,
    // Reject cross-site connections so the session cookie can't be used from another origin.
    // Browsers always send Origin cross-site (and on WebSocket upgrades); same-origin polling GETs omit it.
    allowRequest: (req, callback) => callback(null, !req.headers.origin || req.headers.origin === deps.appOrigin),
  });
  const lastSentAt = new Map<string, number>();

  const emitPresence = (cell: string) => {
    const count = io.sockets.adapter.rooms.get(room(cell))?.size ?? 0;
    io.to(room(cell)).emit('presence', { cell, count });
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
      emitPresence(previous);
    };

    socket.on('join', (cell) => {
      if (typeof cell !== 'string' || !isDisplayCell(cell) || cell === socket.data.cell) return;
      leaveCurrent();
      socket.join(room(cell));
      socket.data.cell = cell;
      emitPresence(cell);
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
        const blocked = chatBlockReason(user, user ? lastSentAt.get(user.id) : undefined);
        if (blocked || !user) return ack({ ok: false, error: blocked ?? 'Sign in first.' });

        lastSentAt.set(user.id, Date.now());
        const message = await postMessage(deps.sql, user, parsed.data.cell, parsed.data.body);
        io.to(room(parsed.data.cell)).emit('message', message);
        ack({ ok: true });
      } catch (err) {
        console.error('square send failed', err);
        ack({ ok: false, error: 'Something went wrong. Try again.' });
      }
    });

    socket.on('disconnect', () => {
      if (socket.data.cell) emitPresence(socket.data.cell);
    });
  });

  // Forget rate-limit timestamps that no longer matter.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - 60_000;
    for (const [id, at] of lastSentAt) if (at < cutoff) lastSentAt.delete(id);
  }, 60_000);
  sweep.unref();

  return {
    messageHidden: (cell, id) => {
      io.to(room(cell)).emit('hidden', { id });
    },
    close: async () => {
      clearInterval(sweep);
      await io.close();
    },
  };
}
