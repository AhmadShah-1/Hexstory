import { useState } from 'react';
import { Navigate, useParams, useSearchParams } from 'react-router';
import { TRUST_NAMES } from '@hexstory/shared';
import { useSession, useUserProfile } from '../api/queries';
import { EditsList, StatsGrid, StoriesList } from '../components/Contributions';
import { Panel } from '../components/Panel';
import { ReportDialog } from '../components/ReportDialog';
import { UserModTools } from '../components/UserModTools';
import { initials, shortDate } from '../lib/format';
import { LoadFailed, NotFound } from './NotFound';

/** Someone's page (/u/:id): the basics for everyone; contributions for reviewers. */
export function UserPage() {
  const { id = '' } = useParams();
  const session = useSession();
  const me = session.data?.user;
  const profile = useUserProfile(id);
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'edits' ? 'edits' : 'stories';
  const [reporting, setReporting] = useState(false);

  if (me?.id === id) return <Navigate to="/me" replace />;
  if (profile.isLoading) return <Panel title="Loading…"><p className="muted pad">Loading…</p></Panel>;
  if (!profile.data) return profile.error ? <LoadFailed error={profile.error} what="person" retry={() => profile.refetch()} /> : <NotFound what="person" />;
  const p = profile.data;
  const role = `${TRUST_NAMES[p.trustLevel]} · joined ${shortDate(p.createdAt)}`;

  return (
    <Panel title={p.displayName} subtitle={role}>
      <div className="pad">
        <div className="profile-head">
          <div className="avatar avatar-lg" aria-hidden="true">{initials(p.displayName)}</div>
          <div>
            <div className="profile-name">{p.displayName}</div>
            <div className="muted small">{role}</div>
          </div>
          {me && !p.deleted && (
            <button className="button button-quiet profile-report" onClick={() => setReporting(true)}>Report</button>
          )}
        </div>
        {p.deleted && <p className="notice">This account was deleted.</p>}
        {p.moderation && <UserModTools profile={p} />}
        {p.details ? (
          <StatsGrid stats={p.details.stats} />
        ) : (
          <p className="muted small">Lists of someone's contributions are visible to reviewers only.</p>
        )}
      </div>

      {p.details && (
        <>
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'stories'} onClick={() => setParams({}, { replace: true })}>Stories</button>
            <button role="tab" aria-selected={tab === 'edits'} onClick={() => setParams({ tab: 'edits' }, { replace: true })}>Edits</button>
          </div>
          {tab === 'stories' ? <StoriesList userId={p.id} /> : <EditsList userId={p.id} />}
        </>
      )}
      {reporting && <ReportDialog open onClose={() => setReporting(false)} targetType="user" targetId={p.id} />}
    </Panel>
  );
}
