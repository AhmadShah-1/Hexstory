import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import {
  REPUTATION,
  RULES,
  TRUST,
  TRUST_NAMES,
  displayNameSchema,
  type Me,
  type ReputationBreakdown,
  type TrustLevel,
  type UserProfile,
} from '@hexstory/shared';
import { errorMessage } from '../api/client';
import { keys, useDeleteAccount, useSession, useSignOut, useUpdateProfile, useUserProfile } from '../api/queries';
import { EditsList, StatsGrid, StoriesList } from '../components/Contributions';
import { Panel } from '../components/Panel';
import { SignInPrompt } from '../components/SignInPrompt';
import { useToast } from '../components/Toast';
import { initials, shortDate } from '../lib/format';

type Tab = 'overview' | 'stories' | 'edits';
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'stories', label: 'Your stories' },
  { id: 'edits', label: 'Your edits' },
];

/** Your account (/me): role, progress, today's limits, settings, and everything you contributed. */
export function AccountPage() {
  const session = useSession();
  const user = session.data?.user;
  const profile = useUserProfile(user?.id);
  const qc = useQueryClient();
  // Loading your page re-checks promotion, so the profile can be ahead of the session: trust it, and
  // refresh the session so the top bar (Watchtower button) follows.
  const profileLevel = profile.data?.trustLevel;
  useEffect(() => {
    if (user && profileLevel !== undefined && profileLevel !== user.trustLevel) qc.invalidateQueries({ queryKey: keys.session });
  }, [user, profileLevel, qc]);
  const [params, setParams] = useSearchParams();
  const tab = TABS.find((t) => t.id === params.get('tab'))?.id ?? 'overview';

  if (session.isLoading) return <Panel title="Your account"><p className="muted pad">Loading…</p></Panel>;
  if (!user) {
    return (
      <Panel title="Your account">
        <SignInPrompt reason="Sign in to see your account, your role and everything you've contributed." />
      </Panel>
    );
  }

  const level = (profileLevel ?? user.trustLevel) as TrustLevel;
  return (
    <Panel title="Your account" subtitle={`${TRUST_NAMES[level]} · joined ${shortDate(user.createdAt)}`}>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setParams(t.id === 'overview' ? {} : { tab: t.id }, { replace: true })}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'stories' && <StoriesList userId={user.id} />}
      {tab === 'edits' && (
        <>
          <p className="muted small pad-x">{WHY_WAITING[level]}</p>
          <EditsList userId={user.id} />
        </>
      )}
      {tab === 'overview' && (
        <div className="pad">
          <div className="profile-head">
            <div className="avatar avatar-lg" aria-hidden="true">{initials(user.displayName)}</div>
            <div>
              <div className="profile-name">{user.displayName}</div>
              <div className="muted small">{TRUST_NAMES[level]} · joined {shortDate(user.createdAt)}</div>
            </div>
          </div>
          {profile.isLoading && <p className="muted">Loading…</p>}
          {profile.error && <p className="error-text">{errorMessage(profile.error)}</p>}
          {profile.data?.details && <Overview level={level} details={profile.data.details} />}
          <Settings user={user} />
        </div>
      )}
    </Panel>
  );
}

/** One line for the Edits tab: why one of your edits might be waiting, at your level. */
const WHY_WAITING: Record<TrustLevel, string> = {
  0: `As a newcomer, your edits wait for a reviewer. The exception is your own new story: while it waits for approval, your changes to it are saved straight away, unless the story would then have more than ${RULES.newcomerMaxLinks} links or the change removes more than ${RULES.largeRemovalPercent}% of the text.`,
  1: `Your edits go live straight away, unless they remove more than ${RULES.largeRemovalPercent}% of a story or a moderator has protected the story. Those wait for a reviewer.`,
  2: 'Your edits go live straight away, unless a moderator has protected the story.',
  3: 'Your edits go live straight away.',
};

const ROLE_TEXT: Record<TrustLevel, string> = {
  0: "You're new here. Stories you start stay private (only you and reviewers can see them) until a reviewer approves them, and you can keep editing them until then. Other edits, including edits to stories that are already published, wait for a reviewer before they appear.",
  1: `Your stories, edits and timeline developments go live straight away, and you can start collections. A few edits still wait for a reviewer: ones that remove more than ${RULES.largeRemovalPercent}% of a story, and edits to stories a moderator has protected.`,
  2: 'Your stories and edits go live straight away. You also look after Hexstory in the Watchtower: approving new stories, accepting or turning down held edits and developments, deciding corrections, removing harmful versions and handling reports.',
  3: 'You can do everything reviewers can, and also ban people, change levels, protect stories and read the audit log.',
};

function Overview({ level, details }: { level: TrustLevel; details: NonNullable<UserProfile['details']> }) {
  const { progress, today, stats, trustLocked } = details;
  const next = progress.next;
  return (
    <>
      <section className="role-box">
        <h3 className="section-label">Your role: {TRUST_NAMES[level]}</h3>
        <p className="small">{ROLE_TEXT[level]}</p>
        {trustLocked && <p className="small muted">A moderator set your level, so automatic promotion is paused.</p>}
        <p className="small">
          {level >= TRUST.MODERATOR ? <Link to="/moderation">Moderation</Link> : level >= TRUST.REVIEWER ? <Link to="/watchtower">Open the Watchtower</Link> : null}
          {level >= TRUST.REVIEWER && ' · '}
          <Link to="/about">How roles work</Link>
        </p>
      </section>

      <section className="account-section">
        <h3 className="section-label">Your reputation: {progress.reputation}</h3>
        <p className="muted small">
          Reputation grows when your work is accepted and holds up: published stories with linked sources, improvements
          to other people's stories, accepted corrections and steady participation. Work that is turned down,
          corrected or removed costs points. Editing the same story again and again earns nothing extra. Only you and
          reviewers can see it; there are no public rankings.
        </p>
        <ReputationBreakdownList breakdown={progress.breakdown} />
      </section>

      {next ? (
        <section className="account-section">
          <h3 className="section-label">Becoming a {TRUST_NAMES[next.level]}</h3>
          {next.minReputation > 0 && <Progress label="Reputation" value={progress.reputation} max={next.minReputation} />}
          {next.minAgeDays > 0 && <Progress label="Days since you joined" value={progress.ageDays} max={next.minAgeDays} />}
          {next.minOthers > 0 && (
            <Progress label="Other people's published stories you improved or corrected" value={progress.others} max={next.minOthers} />
          )}
          {next.minActiveWeeks > 0 && (
            <Progress label="Weeks in which something of yours was accepted" value={progress.activeWeeks} max={next.minActiveWeeks} />
          )}
          <p className="muted small">You're promoted automatically once everything is complete.</p>
        </section>
      ) : (
        !trustLocked &&
        level < TRUST.MODERATOR && (
          <p className="muted small account-section">Reviewer is the highest level you can earn by contributing. Moderators are appointed.</p>
        )
      )}

      <section className="account-section">
        <h3 className="section-label">Today</h3>
        <Progress label="Stories today" value={today.stories} max={today.storiesLimit} />
        <Progress label="Edits today" value={today.edits} max={today.editsLimit} />
        <Progress label="Photo uploads today" value={today.uploads} max={today.uploadsLimit} />
        <Progress label="Photo megabytes today" value={today.uploadMegabytes} max={today.uploadMegabytesLimit} />
        <p className="muted small">Counted over the last 24 hours. Limits grow with your level.</p>
      </section>

      <section className="account-section">
        <h3 className="section-label">Your contributions</h3>
        <StatsGrid stats={stats} />
      </section>
    </>
  );
}

/** Each kind of contribution, its count and the points it adds or costs (REPUTATION). */
const BREAKDOWN: { key: keyof ReputationBreakdown; label: string; points: number }[] = [
  { key: 'publishedStories', label: 'Published stories you started', points: REPUTATION.publishedStory },
  { key: 'linkedSources', label: `Linked sources on them (up to ${REPUTATION.sourcesPerStoryMax} per story)`, points: REPUTATION.linkedSource },
  { key: 'improvedStories', label: "Other people's stories you improved (once each)", points: REPUTATION.improvedStory },
  { key: 'developments', label: `Timeline developments accepted (up to ${REPUTATION.developmentsPerStoryMax} per story)`, points: REPUTATION.development },
  { key: 'correctionsAccepted', label: 'Your corrections accepted', points: REPUTATION.correctionAccepted },
  { key: 'activeWeeks', label: 'Weeks with accepted work', points: REPUTATION.activeWeek },
  { key: 'correctionsRejected', label: 'Your corrections rejected', points: REPUTATION.correctionRejected },
  { key: 'editsRejected', label: 'Your stories or edits turned down', points: REPUTATION.editRejected },
  { key: 'correctedStories', label: 'Corrections accepted on your stories', points: REPUTATION.correctedStory },
  { key: 'removed', label: 'Your versions, developments or stories removed', points: REPUTATION.removed },
];

function ReputationBreakdownList({ breakdown }: { breakdown: ReputationBreakdown }) {
  const rows = BREAKDOWN.filter((r) => breakdown[r.key] > 0);
  if (!rows.length) return <p className="small">Nothing yet. Your first published story or accepted correction starts it off.</p>;
  return (
    <table className="reputation-table small">
      <caption className="visually-hidden">How your reputation adds up</caption>
      <tbody>
        {rows.map((r) => {
          // Active weeks count only up to a cap.
          const n = r.key === 'activeWeeks' ? Math.min(breakdown[r.key], REPUTATION.activeWeeksMax) : breakdown[r.key];
          const total = n * r.points;
          return (
            <tr key={r.key}>
              <th scope="row">{r.label}</th>
              <td className="muted">{breakdown[r.key]} × {r.points > 0 ? `+${r.points}` : `−${-r.points}`}</td>
              <td className={total < 0 ? 'reputation-minus' : 'reputation-plus'}>{total > 0 ? `+${total}` : `−${-total}`}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Progress({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 100;
  return (
    <div className="progress-item">
      <div className="progress-label small">
        <span>{label}</span>
        <span className="muted">{value} of {max}</span>
      </div>
      <div className="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.min(value, max)}>
        <div className={`progress-bar ${value >= max ? 'progress-done' : ''}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Public name, sign out and account deletion (formerly the account dialog). */
function Settings({ user }: { user: Me }) {
  const update = useUpdateProfile();
  const signOut = useSignOut();
  const remove = useDeleteAccount();
  const toast = useToast();
  const [name, setName] = useState(user.displayName);
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  const saveName = () => {
    const parsed = displayNameSchema.safeParse(name);
    if (!parsed.success) return toast(parsed.error.issues[0]?.message ?? 'Invalid name');
    update.mutate({ displayName: parsed.data }, { onSuccess: () => toast('Name updated') });
  };

  return (
    <section className="account-section">
      <h3 className="section-label">Settings</h3>
      <label className="field">
        <span>Public name</span>
        <div className="row name-row">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} />
          <button className="button" onClick={saveName} disabled={update.isPending || name === user.displayName}>Save</button>
        </div>
      </label>
      {update.error && <p className="error-text">{errorMessage(update.error)}</p>}

      <div className="row-end">
        <button className="button" onClick={() => signOut.mutate()}>Sign out</button>
      </div>

      <details className="danger-zone">
        <summary>Delete account</summary>
        <p className="small">
          Your name and email are removed and you are signed out everywhere. Stories and edits you made stay on
          Hexstory (they're shared under CC BY-SA 4.0) but will show “Deleted user”.
        </p>
        {confirming ? (
          <div className="row">
            <input placeholder='Type "delete"' value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
            <button className="button button-danger" disabled={confirmText !== 'delete' || remove.isPending} onClick={() => remove.mutate()}>
              Delete forever
            </button>
          </div>
        ) : (
          <button className="button button-danger" onClick={() => setConfirming(true)}>Delete my account</button>
        )}
        {remove.error && <p className="error-text">{errorMessage(remove.error)}</p>}
      </details>
    </section>
  );
}
