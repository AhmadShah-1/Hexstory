import { useCallback, useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { ChatMessage, ClientToServerEvents, ServerToClientEvents } from '@hexstory/shared';
import { useMessages } from '../api/queries';

type SquareSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
let socket: SquareSocket | null = null;

/** One shared connection for the whole tab, opened the first time someone looks at a Square. */
function getSocket(): SquareSocket {
  socket ??= io({ path: '/socket.io', withCredentials: true });
  return socket;
}

export function useSquare(cell: string) {
  const history = useMessages(cell);
  const [live, setLive] = useState<ChatMessage[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [presence, setPresence] = useState(0);

  useEffect(() => {
    const s = getSocket();
    setLive([]);
    setPresence(0);
    const join = () => s.emit('join', cell);
    const onMessage = (m: ChatMessage) => m.cell === cell && setLive((prev) => [...prev, m]);
    const onPresence = (p: { cell: string; count: number }) => p.cell === cell && setPresence(p.count);
    const onHidden = ({ id }: { id: string }) => setHidden((prev) => new Set(prev).add(id));

    join();
    s.on('connect', join); // rejoin after reconnects
    s.on('message', onMessage);
    s.on('presence', onPresence);
    s.on('hidden', onHidden);
    return () => {
      s.emit('leave', cell);
      s.off('connect', join);
      s.off('message', onMessage);
      s.off('presence', onPresence);
      s.off('hidden', onHidden);
    };
  }, [cell]);

  const send = useCallback(
    (body: string) =>
      new Promise<void>((resolve, reject) => {
        getSocket()
          .timeout(8_000)
          .emit('send', { cell, body }, (err, res) => {
            if (err) reject(new Error('The message could not be sent. Check your connection.'));
            else if (!res.ok) reject(new Error(res.error));
            else resolve();
          });
      }),
    [cell],
  );

  const seen = new Set<string>();
  const messages = [...(history.data ?? []), ...live].filter((m) => {
    if (seen.has(m.id) || hidden.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  return { messages, presence, send, isLoading: history.isLoading, markHidden: (id: string) => setHidden((p) => new Set(p).add(id)) };
}
