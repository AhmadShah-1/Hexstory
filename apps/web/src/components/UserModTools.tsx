import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { TRUST, TRUST_NAMES, type CleanupSummary, type UserProfile, type UserStats } from '@hexstory/shared';
import { errorMessage } from '../api/client';
import {
  useBanUser,
  useDeclineBanRequests,
  useDeleteUser,
  useRequestBan,
  useSession,
  useSetTrust,
} from '../api/queries';
import { shortDate, timeAgo } from '../lib/format';
import { Modal } from './Modal';
import { useToast } from './Toast';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const CLEANUP_PARTS: [keyof CleanupSummary, string, string][] = [
  ['storiesHidden', 'story hidden', 'stories hidden'],
  ['storiesRolledBack', 'rolled back', 'rolled back'],
  ['editsRejected', 'waiting edit rejected', 'waiting edits rejected'],
  ['versionsRemoved', 'version removed', 'versions removed'],
  ['messagesHidden', 'message hidden', 'messages hidden'],
  ['reportsClosed', 'report closed', 'reports closed'],
];

/** "3 stories hidden · 2 rolled back": the non-zero parts of a clean-up (also reads audit log details). */
export function describeCleanup(c: Partial<Record<keyof CleanupSummary, unknown>> | null | undefined): string {
  if (!c) return '';
  return CLEANUP_PARTS.flatMap(([key, one, many]) => {
    const n = Number(c[key] ?? 0);
    return n > 0 ? [plural(n, one, many)] : [];
  }).join(' · ');
}

const cleanupToast = (done: string, cleanup: CleanupSummary | null) => {
  if (!cleanup) return done;
  const summary = describeCleanup(cleanup);
  return `${done} ${summary ? `${summary}.` : 'They had nothing left to remove.'}`;
};

/** Reviewer and moderator actions on a user's page. */
export function UserModTools({ profile }: { profile: UserProfile }) {
  const viewer = useSession().data?.user;
  const mod = profile.moderation;
  if (!viewer || !mod || viewer.id === profile.id || profile.deleted) return null;

  if (profile.trustLevel >= TRUST.MODERATOR) {
    return (
      <section className="mod-tools">
        <h2 className="section-label">Moderation</h2>
        <p className="small muted">Moderators can't be banned or changed here: their access comes from the ADMIN_EMAILS setting.</p>
      </section>
    );
  }

  const isModerator = viewer.trustLevel >= TRUST.MODERATOR;
  return (
    <section className="mod-tools">
      <h2 className="section-label">Moderation</h2>
      {mod.banned && (
        <p className="notice notice-danger">
          Banned since {shortDate(mod.banned.at)}
          {mod.banned.reason && <>: “{mod.banned.reason}”</>}
        </p>
      )}
      {mod.openReports > 0 && (
        <p className="small">{plural(mod.openReports, 'open report', 'open reports')} about them or their posts.</p>
      )}
      {mod.banRequests.length > 0 && (
        <>
          <p className="small"><strong>Reviewers asked for a ban</strong></p>
          <ul className="mod-requests">
            {mod.banRequests.map((r) => (
              <li key={r.id}>
                <Link to={`/u/${r.requestedBy.id}`}>{r.requestedBy.displayName}</Link>: “{r.reason}”{' '}
                <span className="muted">· {timeAgo(r.createdAt)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {isModerator ? <ModeratorTools profile={profile} /> : <ReviewerTools profile={profile} viewerId={viewer.id} />}
    </section>
  );
}

function ReviewerTools({ profile, viewerId }: { profile: UserProfile; viewerId: string }) {
  const [asking, setAsking] = useState(false);
  const request = useRequestBan(profile.id);
  const toast = useToast();
  const mod = profile.moderation!;
  if (mod.banned) return null;

  const mine = mod.banRequests.find((r) => r.requestedBy.id === viewerId);
  if (mine) return <p className="small muted">You asked moderators to ban this account on {shortDate(mine.createdAt)}.</p>;

  return (
    <>
      <div className="action-row">
        <button className="button button-danger" onClick={() => { request.reset(); setAsking(true); }}>Request a ban</button>
      </div>
      {asking && (
        <ReasonDialog
          open
          onClose={() => setAsking(false)}
          title="Request a ban"
          reasonLabel="Why should moderators ban this account?"
          minReason={5}
          confirmLabel="Send to moderators"
          pending={request.isPending}
          error={request.error}
          onConfirm={(reason) =>
            request.mutate(reason ?? '', {
              onSuccess: () => {
                toast('Sent to moderators.');
                setAsking(false);
              },
            })
          }
        >
          <p className="small muted">A moderator will look at their posts and decide.</p>
        </ReasonDialog>
      )}
    </>
  );
}

function ModeratorTools({ profile }: { profile: UserProfile }) {
  const [dialog, setDialog] = useState<'ban' | 'unban' | 'clean-up' | null>(null);
  const ban = useBanUser(profile.id);
  const toast = useToast();
  const mod = profile.moderation!;
  const user = { id: profile.id, displayName: profile.displayName };
  const close = () => setDialog(null);
  const show = (d: typeof dialog) => {
    ban.reset();
    setDialog(d);
  };

  return (
    <>
      <LevelControl profile={profile} />

      <div className="action-row">
        {mod.banned ? (
          <>
            <button className="button" onClick={() => show('unban')}>Unban</button>
            <button className="button button-danger" onClick={() => show('clean-up')}>Remove their posts</button>
          </>
        ) : (
          <button className="button button-danger" onClick={() => show('ban')}>Ban…</button>
        )}
        {mod.banRequests.length > 0 && !mod.banned && <DeclineRequestsButton userId={profile.id} />}
      </div>

      {dialog === 'ban' && <BanDialog user={user} stats={profile.details?.stats} open onClose={close} />}
      {dialog === 'unban' && (
        <ReasonDialog
          open
          onClose={close}
          title={`Unban ${profile.displayName}`}
          reasonLabel="Reason (optional)"
          confirmLabel="Unban"
          pending={ban.isPending}
          error={ban.error}
          onConfirm={(reason) => ban.mutate({ banned: false, reason }, { onSuccess: () => { toast('Unbanned.'); close(); } })}
        >
          <p className="small muted">They can write and chat again. Posts that were removed don't come back.</p>
        </ReasonDialog>
      )}
      {dialog === 'clean-up' && (
        <ReasonDialog
          open
          onClose={close}
          title="Remove their posts"
          reasonLabel="Reason (optional)"
          confirmLabel="Remove their posts"
          danger
          pending={ban.isPending}
          error={ban.error}
          onConfirm={(reason) =>
            ban.mutate(
              { banned: true, removeContent: true, reason },
              { onSuccess: (res) => { toast(cleanupToast('Posts removed.', res.cleanup)); close(); } },
            )
          }
        >
          <RemoveContentExplainer />
        </ReasonDialog>
      )}

      <DeleteAccount profile={profile} />

      <p className="small">
        <Link to={`/moderation?tab=log&targetType=user&targetId=${profile.id}`}>Moderation history</Link>
      </p>
    </>
  );
}

type LevelChoice = '0' | '1' | '2' | 'auto';

function LevelControl({ profile }: { profile: UserProfile }) {
  const locked = profile.details?.trustLocked ?? false;
  const current: LevelChoice = locked ? (String(profile.trustLevel) as LevelChoice) : 'auto';
  const [level, setLevel] = useState<LevelChoice>(current);
  const [reason, setReason] = useState('');
  const setTrust = useSetTrust(profile.id);
  const toast = useToast();

  const apply = () =>
    setTrust.mutate(
      { level: level === 'auto' ? 'auto' : (Number(level) as 0 | 1 | 2), reason: reason.trim() || undefined },
      { onSuccess: () => { toast('Level updated.'); setReason(''); } },
    );

  return (
    <div className="mod-level">
      <label className="field">
        <span>Level</span>
        <select value={level} onChange={(e) => setLevel(e.target.value as LevelChoice)}>
          {([0, 1, 2] as const).map((l) => <option key={l} value={String(l)}>{TRUST_NAMES[l]}</option>)}
          <option value="auto">{locked ? 'Automatic' : `Automatic (now ${TRUST_NAMES[profile.trustLevel]})`}</option>
        </select>
        <span className="small muted">
          Setting a level stops automatic promotion. Automatic may promote them again but never demotes.
        </span>
      </label>
      {level !== current && (
        <>
          <label className="field">
            <span>Reason (optional)</span>
            <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="row">
            <button className="button button-primary" disabled={setTrust.isPending} onClick={apply}>Apply</button>
            <button className="button button-quiet" onClick={() => setLevel(current)}>Cancel</button>
          </div>
        </>
      )}
      {setTrust.error && <p className="error-text">{errorMessage(setTrust.error)}</p>}
    </div>
  );
}

/** "Decline requests" with an optional note; used on user pages and in the moderators' queue. */
export function DeclineRequestsButton({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  const decline = useDeclineBanRequests(userId);
  const toast = useToast();
  return (
    <>
      <button className="button" onClick={() => { decline.reset(); setOpen(true); }}>Decline</button>
      {open && (
        <ReasonDialog
          open
          onClose={() => setOpen(false)}
          title="Decline ban requests"
          reasonLabel="Note for the log (optional)"
          confirmLabel="Decline"
          pending={decline.isPending}
          error={decline.error}
          onConfirm={(reason) => decline.mutate(reason, { onSuccess: () => { toast('Requests declined.'); setOpen(false); } })}
        >
          <p className="small muted">The account stays as it is. Reviewers can ask again later.</p>
        </ReasonDialog>
      )}
    </>
  );
}

const RemoveContentExplainer = () => (
  <p className="small muted">
    Hides the stories they started, rolls back stories where their edit is the latest to the last version by
    someone else, rejects their waiting edits, removes all their versions from the history so they can't be
    viewed or restored, and hides their chat messages.
  </p>
);

/** Ban someone, keeping or taking down what they posted. */
export function BanDialog({ user, stats, open, onClose }: {
  user: { id: string; displayName: string };
  stats?: Pick<UserStats, 'storiesStarted' | 'edits'> | null;
  open: boolean;
  onClose: () => void;
}) {
  const [removeContent, setRemoveContent] = useState(false);
  const [reason, setReason] = useState('');
  const ban = useBanUser(user.id);
  const toast = useToast();

  const submit = () =>
    ban.mutate(
      { banned: true, removeContent, reason: reason.trim() || undefined },
      {
        onSuccess: (res) => {
          toast(cleanupToast(`${user.displayName} is banned.`, res.cleanup));
          onClose();
        },
      },
    );

  return (
    <Modal open={open} onClose={onClose} title={`Ban ${user.displayName}`}>
      <p className="small">They are signed out at once and can't write or chat while banned.</p>
      {stats && (
        <p className="small muted">
          They started {plural(stats.storiesStarted, 'story', 'stories')} and wrote {plural(stats.edits, 'version', 'versions')}.
        </p>
      )}
      <fieldset className="radio-list choice-list">
        <label>
          <input type="radio" name="ban-content" checked={!removeContent} onChange={() => setRemoveContent(false)} />
          <span>
            <strong>Ban and keep their posts</strong>
            <span className="small muted">Stories and edits stay up; their chat messages disappear while they're banned.</span>
          </span>
        </label>
        <label>
          <input type="radio" name="ban-content" checked={removeContent} onChange={() => setRemoveContent(true)} />
          <span>
            <strong>Ban and remove their posts</strong>
            <RemoveContentExplainer />
          </span>
        </label>
      </fieldset>
      <label className="field">
        <span>Reason (optional)</span>
        <textarea rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {ban.error && <p className="error-text">{errorMessage(ban.error)}</p>}
      <div className="row-end">
        <button className="button" onClick={onClose}>Cancel</button>
        <button className="button button-destructive" onClick={submit} disabled={ban.isPending}>
          {removeContent ? 'Ban and remove posts' : 'Ban'}
        </button>
      </div>
    </Modal>
  );
}

function DeleteAccount({ profile }: { profile: UserProfile }) {
  const [removeContent, setRemoveContent] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [reason, setReason] = useState('');
  const del = useDeleteUser(profile.id);
  const toast = useToast();
  const navigate = useNavigate();

  const submit = () =>
    del.mutate(
      { removeContent, reason: reason.trim() || undefined },
      {
        onSuccess: (res) => {
          toast(cleanupToast('Account deleted.', res.cleanup));
          navigate('/moderation?tab=users');
        },
      },
    );

  return (
    <details className="danger-zone">
      <summary>Delete this account</summary>
      <p className="small">
        Their name and email are removed and they are signed out. They can sign up again as a new account, so to
        keep someone out, ban them instead.
      </p>
      <fieldset className="radio-list">
        <label>
          <input type="radio" name="delete-content" checked={!removeContent} onChange={() => setRemoveContent(false)} />
          Keep their posts (shown without their name)
        </label>
        <label>
          <input type="radio" name="delete-content" checked={removeContent} onChange={() => setRemoveContent(true)} />
          Remove their posts too
        </label>
      </fieldset>
      <label className="field">
        <span>Reason (optional)</span>
        <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </label>
      <label className="field">
        <span>Type “delete” to confirm</span>
        <input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
      </label>
      {del.error && <p className="error-text">{errorMessage(del.error)}</p>}
      <button
        className="button button-destructive"
        disabled={confirm.trim().toLowerCase() !== 'delete' || del.isPending}
        onClick={submit}
      >
        Delete account
      </button>
    </details>
  );
}

/** A confirm dialog with a reason box: optional unless `minReason` is set. */
function ReasonDialog({ open, onClose, title, reasonLabel, minReason, confirmLabel, danger, pending, error, onConfirm, children }: {
  open: boolean;
  onClose: () => void;
  title: string;
  reasonLabel: string;
  minReason?: number;
  confirmLabel: string;
  danger?: boolean;
  pending: boolean;
  error: unknown;
  onConfirm: (reason: string | undefined) => void;
  children?: ReactNode;
}) {
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  const tooShort = !!minReason && trimmed.length < minReason;
  return (
    <Modal open={open} onClose={onClose} title={title}>
      {children}
      <label className="field">
        <span>{reasonLabel}</span>
        <textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {!!error && <p className="error-text">{errorMessage(error)}</p>}
      <div className="row-end">
        <button className="button" onClick={onClose}>Cancel</button>
        <button
          className={`button ${danger ? 'button-destructive' : 'button-primary'}`}
          disabled={pending || tooShort}
          onClick={() => onConfirm(trimmed || undefined)}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
