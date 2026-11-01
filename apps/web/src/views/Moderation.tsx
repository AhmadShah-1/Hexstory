import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { TRUST, TRUST_NAMES, type AuditEntry, type BanRequestGroup, type ModUserRow, type TrustLevel } from '@hexstory/shared';
import { errorMessage } from '../api/client';
import { useAuditLog, useBanRequests, useModUsers, useSession, type AuditFilters, type ModUserFilters } from '../api/queries';
import { Panel } from '../components/Panel';
import { BanDialog, DeclineRequestsButton, describeCleanup } from '../components/UserModTools';
import { shortDate, timeAgo } from '../lib/format';

const TABS = { requests: 'Ban requests', users: 'Users', log: 'Audit log' } as const;
type Tab = keyof typeof TABS;

/** Moderators: ban requests, all users, the audit log. Tab and filters live in the URL. */
export function Moderation() {
  const session = useSession();
  const isModerator = (session.data?.user?.trustLevel ?? 0) >= TRUST.MODERATOR;
  const requests = useBanRequests(isModerator);
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const tab: Tab = tabParam === 'users' || tabParam === 'log' ? tabParam : 'requests';

  if (session.isLoading) return <Panel title="Moderation"><p className="muted pad">Loading…</p></Panel>;
  if (!isModerator) {
    return <Panel title="Moderation"><p className="pad">This page is for moderators.</p></Panel>;
  }

  const requestCount = requests.data?.length ?? 0;
  return (
    <Panel title="Moderation" subtitle={<Link to="/watchtower">Review queue</Link>} wide>
      <div className="tabs" role="tablist">
        {(Object.keys(TABS) as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setParams({ tab: t })}>
            {TABS[t]}
            {t === 'requests' && requestCount > 0 && <span className="count">{requestCount}</span>}
          </button>
        ))}
      </div>
      <div className="pad">
        {tab === 'requests' && (
          <>
            {requests.isLoading && <p className="muted">Loading…</p>}
            {requests.error && <p className="error-text">{errorMessage(requests.error)}</p>}
            {requests.data &&
              (requests.data.length ? requests.data.map((g) => <BanRequestCard key={g.user.id} group={g} />) : <p className="muted">No ban requests.</p>)}
          </>
        )}
        {tab === 'users' && <UsersTab />}
        {tab === 'log' && <LogTab />}
      </div>
    </Panel>
  );
}

const counts = (u: ModUserRow) => `${u.stories} ${u.stories === 1 ? 'story' : 'stories'} · ${u.edits} ${u.edits === 1 ? 'edit' : 'edits'}`;

function BanRequestCard({ group: { user, requests } }: { group: BanRequestGroup }) {
  const [banning, setBanning] = useState(false);
  return (
    <div className="card">
      <div className="card-head">
        <Link to={`/u/${user.id}`}><strong>{user.displayName}</strong></Link>
        <span className="muted small">
          {TRUST_NAMES[user.trustLevel]} · joined {shortDate(user.createdAt)} · {counts(user)}
          {user.openReports > 0 && ` · ${user.openReports} open ${user.openReports === 1 ? 'report' : 'reports'}`}
        </span>
      </div>
      <ul className="mod-requests">
        {requests.map((r) => (
          <li key={r.id}>
            <Link to={`/u/${r.requestedBy.id}`}>{r.requestedBy.displayName}</Link>: “{r.reason}”{' '}
            <span className="muted">· {timeAgo(r.createdAt)}</span>
          </li>
        ))}
      </ul>
      <div className="action-row">
        <button className="button button-danger" onClick={() => setBanning(true)}>Ban…</button>
        <DeclineRequestsButton userId={user.id} />
      </div>
      {banning && (
        <BanDialog
          user={user}
          stats={{ storiesStarted: user.stories, edits: user.edits }}
          open
          onClose={() => setBanning(false)}
        />
      )}
    </div>
  );
}

// ---- Users ----

const USER_FILTERS = { all: 'All', banned: 'Banned', requested: 'Ban requested', reported: 'Reported' } as const;

function UsersTab() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const levelParam = params.get('level');
  const filterParam = params.get('filter');
  const filters: ModUserFilters = {
    q: params.get('q')?.trim() || undefined,
    level: levelParam && /^[0-3]$/.test(levelParam) ? (Number(levelParam) as 0 | 1 | 2 | 3) : undefined,
    filter: filterParam && filterParam in USER_FILTERS ? (filterParam as ModUserFilters['filter']) : 'all',
  };
  const users = useModUsers(filters);

  const setParam = (key: string, value: string) =>
    setParams(
      (p) => {
        if (value) p.set(key, value);
        else p.delete(key);
        return p;
      },
      { replace: true },
    );

  // Search as they type, without a request per keystroke.
  const q = params.get('q') ?? '';
  useEffect(() => {
    const next = search.trim();
    if (next === q) return;
    const timer = setTimeout(() => setParam('q', next), 300);
    return () => clearTimeout(timer);
  }, [search, q]);

  const rows = users.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <div className="mod-filters">
        <input type="search" placeholder="Search by name" aria-label="Search by name" value={search} maxLength={64} onChange={(e) => setSearch(e.target.value)} />
        <select aria-label="Level" value={filters.level ?? ''} onChange={(e) => setParam('level', e.target.value)}>
          <option value="">All levels</option>
          {([0, 1, 2, 3] as TrustLevel[]).map((l) => <option key={l} value={l}>{TRUST_NAMES[l]}</option>)}
        </select>
        <select aria-label="Show" value={filters.filter} onChange={(e) => setParam('filter', e.target.value === 'all' ? '' : e.target.value)}>
          {Object.entries(USER_FILTERS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      {users.isLoading && <p className="muted">Loading…</p>}
      {users.error && <p className="error-text">{errorMessage(users.error)}</p>}
      {users.data && !rows.length && <p className="muted">No one matches.</p>}
      <ul className="mod-list">
        {rows.map((u) => (
          <li key={u.id}>
            <Link to={`/u/${u.id}`} className="mod-row">
              <strong>{u.displayName}</strong>
              {u.bannedAt && <span className="chip chip-rejected">Banned</span>}
              {u.openReports > 0 && <span className="chip chip-pending">{u.openReports} {u.openReports === 1 ? 'report' : 'reports'}</span>}
              {u.openBanRequests > 0 && (
                <span className="chip chip-rejected">{u.openBanRequests} ban {u.openBanRequests === 1 ? 'request' : 'requests'}</span>
              )}
              <span className="mod-row-meta">
                {TRUST_NAMES[u.trustLevel]}
                {u.trustLocked && <span className="chip chip-quiet" title="Automatic promotion is paused">set by a moderator</span>}
                {' · '}joined {shortDate(u.createdAt)} · {counts(u)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <LoadMore query={users} />
    </>
  );
}

function LoadMore({ query }: { query: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown } }) {
  if (!query.hasNextPage) return null;
  return (
    <div className="load-more">
      <button className="button" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>
        {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
      </button>
    </div>
  );
}

// ---- Audit log ----

const ACTION_FILTERS: [string, string][] = [
  ['', 'All actions'],
  ['approve', 'Approvals'],
  ['accept', 'Accepted edits'],
  ['reject', 'Rejected edits'],
  ['restore', 'Restores'],
  ['restore-version', 'Versions put back'],
  ['rollback', 'Rollbacks'],
  ['hide', 'Hidden'],
  ['unhide', 'Unhidden'],
  ['remove-version', 'Removed versions'],
  ['protect', 'Protection'],
  ['report', 'Reports'],
  ['ban-request', 'Ban requests'],
  ['ban', 'Bans'],
  ['unban', 'Unbans'],
  ['trust', 'Level changes'],
  ['delete-user', 'Account deletions'],
];

const PROTECTION_NAMES: Record<string, string> = { 0: 'Members', 1: 'Members', 2: 'Reviewers only', 3: 'Moderators only' };

/** A plain sentence for an action code, read after the actor's name. Unknown codes are shown as they are. */
function describeAction(e: AuditEntry): string {
  const [code, arg] = e.action.split(':') as [string, string | undefined];
  const removed = e.details?.removeContent ? ' and removed their posts' : '';
  switch (code) {
    case 'accept': return 'accepted an edit';
    case 'reject': return 'rejected an edit';
    case 'approve': return 'approved and published a story';
    case 'hide': return e.targetType === 'comment' ? 'hid a chat message' : 'hid a story';
    case 'unhide': return 'brought back a hidden story';
    case 'restore': return 'restored an earlier version';
    case 'rollback': return 'rolled back a story';
    case 'remove-version': return 'removed a version from the history';
    case 'restore-version': return 'put back a removed version';
    case 'protect':
      if (arg && arg in PROTECTION_NAMES) return `set who can edit without review to ${PROTECTION_NAMES[arg]}`;
      break;
    case 'report':
      if (arg === 'dismissed') return 'dismissed a report';
      if (arg === 'actioned') return 'marked a report as handled';
      break;
    case 'ban':
      if (!arg) return `banned an account${removed}`;
      if (arg === 'clean-up') return 'removed the posts of a banned account';
      break;
    case 'unban': return 'unbanned an account';
    case 'ban-request':
      if (!arg) return 'asked moderators to ban an account';
      if (arg === 'declined') return 'declined the ban requests for an account';
      break;
    case 'trust':
      if (arg === 'auto') return 'returned their level to automatic';
      if (arg === '0' || arg === '1' || arg === '2') return `set their level to ${TRUST_NAMES[Number(arg) as TrustLevel]}`;
      break;
    case 'delete-user': return `deleted an account${removed}`;
  }
  return e.action;
}

function targetLink(e: AuditEntry): string | null {
  switch (e.targetType) {
    case 'story': return e.target.storyId ? `/s/${e.target.storyId}` : null;
    case 'revision': return `/v/${e.targetId}`;
    case 'user': return `/u/${e.target.userId ?? e.targetId}`;
    case 'comment': return e.target.cell ? `/h/${e.target.cell}?tab=square` : null;
    default: return null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function LogTab() {
  const [params, setParams] = useSearchParams();
  const targetType = params.get('targetType');
  const filters: AuditFilters = {
    action: params.get('action') || undefined,
    actorId: params.get('actorId') || undefined,
    targetType: targetType && ['story', 'revision', 'comment', 'user', 'report'].includes(targetType)
      ? (targetType as AuditFilters['targetType'])
      : undefined,
    targetId: params.get('targetId') || undefined,
  };
  const log = useAuditLog(filters);
  const entries = log.data?.pages.flatMap((p) => p.items) ?? [];

  const update = (change: (p: URLSearchParams) => void) =>
    setParams((p) => {
      change(p);
      return p;
    }, { replace: true });
  const clearScope = () => update((p) => ['actorId', 'targetType', 'targetId'].forEach((k) => p.delete(k)));

  // Name the person or item the log is narrowed to, from the entries themselves.
  const first = entries[0];
  const scope = [
    filters.actorId && `actions by ${first?.actor.displayName ?? 'one person'}`,
    filters.targetId && `actions about ${first?.target.label ?? `this ${filters.targetType ?? 'item'}`}`,
    !filters.targetId && filters.targetType && `actions on ${filters.targetType}s`,
  ].filter(Boolean);

  return (
    <>
      <div className="mod-filters">
        <select
          aria-label="Action"
          value={filters.action ?? ''}
          onChange={(e) => update((p) => (e.target.value ? p.set('action', e.target.value) : p.delete('action')))}
        >
          {ACTION_FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      {scope.length > 0 && (
        <p className="filter-note">
          <span>Filtered to {scope.join(' and ')}.</span>
          <button className="link-button" onClick={clearScope}>Show everything</button>
        </p>
      )}
      {log.isLoading && <p className="muted">Loading…</p>}
      {log.error && <p className="error-text">{errorMessage(log.error)}</p>}
      {log.data && !entries.length && <p className="muted">Nothing here yet.</p>}
      <ul className="mod-list">
        {entries.map((e) => <LogEntry key={e.id} entry={e} />)}
      </ul>
      <LoadMore query={log} />
    </>
  );
}

function LogEntry({ entry: e }: { entry: AuditEntry }) {
  const link = targetLink(e);
  const label = e.target.label ?? '(deleted)';
  const isCleanup = e.action === 'ban' || e.action === 'ban:clean-up' || e.action === 'delete-user';
  const summary = isCleanup ? describeCleanup(e.details) : '';
  // Newer entries keep the restored version in details; older ones put its id in the reason.
  const fromDetails = typeof e.details?.revisionId === 'string' ? e.details.revisionId : null;
  const restoredVersion = e.action === 'restore' ? (fromDetails ?? (e.reason && UUID.test(e.reason) ? e.reason : null)) : null;
  return (
    <li className="log-entry">
      <div>
        <Link to={`/u/${e.actor.id}`}>{e.actor.displayName}</Link> {describeAction(e)}
      </div>
      <div className="log-target">{link ? <Link to={link}>{label}</Link> : label}</div>
      {restoredVersion ? (
        <p className="small"><Link to={`/v/${restoredVersion}`}>The version they restored</Link></p>
      ) : (
        e.reason && <p className="small">“{e.reason}”</p>
      )}
      {summary && <p className="small muted">{summary}</p>}
      <time className="small muted" dateTime={e.createdAt} title={new Date(e.createdAt).toLocaleString()}>
        {timeAgo(e.createdAt)}
      </time>
    </li>
  );
}
