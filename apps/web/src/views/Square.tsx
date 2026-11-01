import { useEffect, useRef, useState } from 'react';
import { TRUST, type ChatMessage } from '@hexstory/shared';
import { errorMessage } from '../api/client';
import { useHideMessage, useSession } from '../api/queries';
import { ReportDialog } from '../components/ReportDialog';
import { SignInPrompt } from '../components/SignInPrompt';
import { initials, timeAgo } from '../lib/format';
import { useSquare } from '../realtime/useSquare';

/** The Square: live, public conversation among everyone looking at this hex right now. */
export function Square({ cell }: { cell: string }) {
  const { messages, presence, send, isLoading, markHidden } = useSquare(cell);
  const session = useSession();
  const user = session.data?.user;
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    setError(null);
    setNotice(null);
    try {
      const { delayed } = await send(body);
      setDraft('');
      if (delayed) setNotice('Sent, but it may take a moment to reach everyone.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="square">
      <div className="presence">
        <span className="presence-dot" aria-hidden="true" />
        {presence <= 1 ? 'Just you here right now' : `${presence} people here now`}
      </div>

      <div className="square-messages">
        {isLoading && <p className="muted">Loading conversation…</p>}
        {!isLoading && messages.length === 0 && (
          <p className="muted square-empty">It's quiet here. Say hello, or ask what people know about this place.</p>
        )}
        {messages.map((m) => (
          <Message key={m.id} message={m} canModerate={(user?.trustLevel ?? 0) >= TRUST.REVIEWER} canReport={!!user} onHidden={markHidden} />
        ))}
        <div ref={bottom} />
      </div>

      {user ? (
        <form className="square-input" onSubmit={submit}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={500}
            placeholder="Messages are public. Be kind."
            aria-label="Message"
          />
          <button className="button button-primary" disabled={sending || !draft.trim()}>
            Send
          </button>
          {error && <p className="error-text square-error">{error}</p>}
          {notice && <p className="muted square-error">{notice}</p>}
        </form>
      ) : (
        <SignInPrompt reason="Sign in to join the conversation." />
      )}
    </div>
  );
}

function Message({ message, canModerate, canReport, onHidden }: {
  message: ChatMessage;
  canModerate: boolean;
  canReport: boolean;
  onHidden: (id: string) => void;
}) {
  const [reporting, setReporting] = useState(false);
  const hide = useHideMessage();
  return (
    <div className="message">
      <div className="avatar" aria-hidden="true">{initials(message.author.displayName)}</div>
      <div className="message-main">
        <div className="message-head">
          <strong>{message.author.displayName}</strong>
          <time className="muted" dateTime={message.createdAt}>{timeAgo(message.createdAt)}</time>
          <span className="message-actions">
            {canReport && <button className="link-button" onClick={() => setReporting(true)}>Report</button>}
            {canModerate && (
              <button className="link-button" onClick={() => hide.mutate(message.id, { onSuccess: () => onHidden(message.id) })}>
                Hide
              </button>
            )}
          </span>
        </div>
        <p className="message-body">{message.body}</p>
      </div>
      {reporting && (
        <ReportDialog open onClose={() => setReporting(false)} targetType="comment" targetId={message.id} />
      )}
    </div>
  );
}
