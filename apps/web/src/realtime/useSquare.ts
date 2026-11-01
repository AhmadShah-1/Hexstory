import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { mergeMessages, type ChatMessage, type ClientToServerEvents, type ServerToClientEvents } from '@hexstory/shared';
import { useMessages } from '../api/queries';

type SquareSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
let socket: SquareSocket | null = null;

/**
 * One shared connection for the whole tab, opened the first time someone looks at a Square.
 * WebSocket only: on Vercel, long-polling requests would hit different server instances.
 */
function getSocket(): SquareSocket {
  socket ??= io({ path: '/socket.io', withCredentials: true, transports: ['websocket'] });
  return socket;
}

/** Live messages, tagged with the order they arrived in. */
type Live = { message: ChatMessage; seq: number };
let arrivals = 0;

/**
 * Chat history comes from the API (PostgreSQL); live events only add to it. Whenever the socket
 * (re)joins a room, or the server says it may have missed events (`resync`), history is refetched
 * *after* the join is acknowledged, so nothing posted in between can fall through the gap. Live
 * messages from before that point are then dropped: the fresh history is authoritative (it also
 * leaves out anything a moderator hid while we were away). Overlap is removed by id.
 */
export function useSquare(cell: string) {
  const history = useMessages(cell);
  // Read through a ref so a new `refetch` identity never re-runs the join effect.
  const refetch = useRef(history.refetch);
  refetch.current = history.refetch;
  const [live, setLive] = useState<Live[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [presence, setPresence] = useState(0);

  useEffect(() => {
    const s = getSocket();
    let disposed = false;
    setLive([]);
    setPresence(0);

    const resync = () => {
      const cutoff = arrivals;
      void refetch.current().then((result) => {
        if (!disposed && result.isSuccess) setLive((prev) => prev.filter((l) => l.seq > cutoff));
      });
    };
    const join = () => s.emit('join', cell, resync);
    const onMessage = (m: ChatMessage) => m.cell === cell && setLive((prev) => [...prev, { message: m, seq: ++arrivals }]);
    const onPresence = (p: { cell: string; count: number }) => p.cell === cell && setPresence(p.count);
    const onHidden = ({ id }: { id: string }) => setHidden((prev) => new Set(prev).add(id));

    if (s.connected) join();
    s.on('connect', join); // first connection and every reconnect
    s.on('resync', resync);
    s.on('message', onMessage);
    s.on('presence', onPresence);
    s.on('hidden', onHidden);
    return () => {
      disposed = true;
      s.emit('leave', cell);
      s.off('connect', join);
      s.off('resync', resync);
      s.off('message', onMessage);
      s.off('presence', onPresence);
      s.off('hidden', onHidden);
    };
  }, [cell]);

  /** `delayed`: the message was saved but may reach others only when they next reconnect or reopen the hex. */
  const send = useCallback(
    (body: string) =>
      new Promise<{ delayed: boolean }>((resolve, reject) => {
        getSocket()
          .timeout(8_000)
          .emit('send', { cell, body }, (err, res) => {
            if (err) reject(new Error('The message could not be sent. Check your connection.'));
            else if (!res.ok) reject(new Error(res.error));
            else resolve({ delayed: !!res.delayed });
          });
      }),
    [cell],
  );

  const messages = mergeMessages(
    history.data ?? [],
    live.map((l) => l.message),
    hidden,
  );

  return { messages, presence, send, isLoading: history.isLoading, markHidden: (id: string) => setHidden((p) => new Set(p).add(id)) };
}
