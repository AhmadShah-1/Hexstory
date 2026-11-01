import { Link } from 'react-router';
import { TRUST, type ContributionEdit, type ContributionStory, type UserStats } from '@hexstory/shared';
import { errorMessage } from '../api/client';
import { useSession, useUserRevisions, useUserStories } from '../api/queries';
import { shortDate } from '../lib/format';
import { StoryRow } from './StoryRow';

const STORY_STATE: Record<ContributionStory['state'], { label: string; chip: string }> = {
  live: { label: 'Live', chip: 'chip-current' },
  waiting: { label: 'Waiting for review', chip: 'chip-pending' },
  hidden: { label: 'Hidden by a reviewer', chip: 'chip-rejected' },
  rejected: { label: 'Not accepted', chip: 'chip-rejected' },
};

/** Stories someone started, including ones that aren't public. For the person themself and reviewers. */
export function StoriesList({ userId }: { userId: string }) {
  const query = useUserStories(userId);
  const isReviewer = (useSession().data?.user?.trustLevel ?? 0) >= TRUST.REVIEWER;
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  if (query.isLoading) return <p className="muted pad">Loading stories…</p>;
  if (query.error) return <p className="error-text pad">{errorMessage(query.error)}</p>;
  if (items.length === 0) {
    return (
      <div className="empty">
        <p className="empty-title">No stories yet.</p>
        <p className="muted">Stories started here will show up in this list.</p>
      </div>
    );
  }

  return (
    <div className="story-list">
      {items.map(({ story, state, createdAt }) => (
        <StoryRow
          key={story.id}
          story={story}
          // Hidden stories are for reviewers only; their author sees the row but can't open it.
          linked={story.status !== 'hidden' || isReviewer}
          note={
            <>
              <span className={`chip ${STORY_STATE[state].chip}`}>{STORY_STATE[state].label}</span>
              <span>Started {shortDate(createdAt)}</span>
            </>
          }
        />
      ))}
      <LoadMore query={query} />
    </div>
  );
}

/** Every version someone wrote, newest first. For the person themself and reviewers. */
export function EditsList({ userId }: { userId: string }) {
  const query = useUserRevisions(userId);
  const isReviewer = (useSession().data?.user?.trustLevel ?? 0) >= TRUST.REVIEWER;
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  if (query.isLoading) return <p className="muted pad">Loading edits…</p>;
  if (query.error) return <p className="error-text pad">{errorMessage(query.error)}</p>;
  if (items.length === 0) {
    return (
      <div className="empty">
        <p className="empty-title">No edits yet.</p>
        <p className="muted">Every version written, including the first one of a new story, shows up here.</p>
      </div>
    );
  }

  return (
    <>
      <ul className="version-list">
        {items.map((e) => (
          <li key={e.id}>
            {/* Removed versions, and anything in a hidden story, can only be opened by reviewers. */}
            {(e.removed || e.storyStatus === 'hidden') && !isReviewer ? (
              <div className="version-row"><EditSummary edit={e} /></div>
            ) : (
              <Link to={`/v/${e.id}`} className="version-row"><EditSummary edit={e} /></Link>
            )}
          </li>
        ))}
      </ul>
      <div className="pad-x contrib-more"><LoadMore query={query} /></div>
    </>
  );
}

function EditSummary({ edit: e }: { edit: ContributionEdit }) {
  return (
    <>
      <div className="contrib-title">{e.storyTitle}</div>
      <div className="small">
        <span className="muted">{shortDate(e.createdAt)}{e.isFirst && ' · Started this story'}</span>
        {e.removed ? (
          <span className="chip chip-rejected">Removed</span>
        ) : e.storyStatus === 'hidden' ? (
          <span className="chip chip-rejected">Story hidden</span>
        ) : e.storyStatus === 'unreviewed' && e.status === 'accepted' ? (
          <span className="chip chip-pending">{e.isCurrent ? 'Current · ' : ''}Story waiting for approval</span>
        ) : e.isCurrent ? (
          <span className="chip chip-current">Current</span>
        ) : e.status === 'accepted' ? (
          <span className="chip chip-quiet chip-gap">Accepted</span>
        ) : e.status === 'pending' ? (
          <span className="chip chip-pending">Waiting for review</span>
        ) : (
          <span className="chip chip-rejected">Not accepted</span>
        )}
      </div>
      {e.flags.length > 0 && (
        <div className="contrib-flags">
          {e.flags.map((f) => <span key={f} className="chip chip-flag">{f.replace('-', ' ')}</span>)}
        </div>
      )}
      {e.editSummary && <div className="muted small">“{e.editSummary}”</div>}
    </>
  );
}

function LoadMore({ query }: { query: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown } }) {
  if (!query.hasNextPage) return null;
  return (
    <button className="button button-block" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>
      {query.isFetchingNextPage ? 'Loading…' : 'Show more'}
    </button>
  );
}

/** Contribution counts, shown on your account and (to reviewers) on someone's page. */
export function StatsGrid({ stats }: { stats: UserStats }) {
  return (
    <dl className="stat-grid">
      <div>
        <dt>Stories started</dt>
        <dd>{stats.storiesStarted}</dd>
        <dd className="muted small">{stats.storiesLive} live</dd>
      </div>
      <div>
        <dt>Versions written</dt>
        <dd>{stats.edits}</dd>
        <dd className="muted small">
          {stats.editsAccepted} accepted · {stats.editsWaiting} waiting · {stats.editsRejected} not accepted
          {stats.editsRemoved > 0 && ` · ${stats.editsRemoved} removed`}
        </dd>
      </div>
      <div>
        <dt>Chat messages</dt>
        <dd>{stats.messages}</dd>
      </div>
    </dl>
  );
}
