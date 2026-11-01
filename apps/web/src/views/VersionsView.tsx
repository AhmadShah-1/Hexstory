import { errorMessage } from '../api/client';
import { Link, useParams } from 'react-router';
import { useRevisions, useStory } from '../api/queries';
import { Panel } from '../components/Panel';
import { shortDate } from '../lib/format';

const STATUS_LABEL = { pending: 'Waiting for review', accepted: '', rejected: 'Not accepted' } as const;

/** Versions: the full, append-only edit history of a story. */
export function VersionsView() {
  const { id = '' } = useParams();
  const story = useStory(id);
  const revisions = useRevisions(id);

  return (
    <Panel
      title="Versions"
      subtitle={story.data?.revision.title}
      back={{ label: 'Back to story', to: `/s/${id}` }}
    >
      <p className="muted small pad-x">Every change is kept. Nothing is ever overwritten.</p>
      {revisions.isLoading && <p className="muted pad">Loading…</p>}
      {revisions.error && <p className="error-text pad">{errorMessage(revisions.error)}</p>}
      {revisions.data?.length === 0 && <p className="muted pad">No versions you can see yet.</p>}
      <ul className="version-list">
        {revisions.data?.map((r) => (
          <li key={r.id}>
            {/* The whole row opens the version; the author's name is its own link above it. */}
            <div className="version-row stretch">
              <div>
                <Link to={`/v/${r.id}`} className="stretch-link"><strong>{shortDate(r.createdAt)}</strong></Link> ·{' '}
                <Link to={`/u/${r.author.id}`} className="above">{r.author.displayName}</Link>
                {r.isCurrent && <span className="chip chip-current">Current</span>}
                {r.removed && <span className="chip chip-rejected">Removed</span>}
                {STATUS_LABEL[r.status] && <span className={`chip chip-${r.status}`}>{STATUS_LABEL[r.status]}</span>}
                {r.flags.map((f) => (
                  <span key={f} className="chip chip-flag">{f.replace('-', ' ')}</span>
                ))}
              </div>
              {r.editSummary && <div className="muted small">{r.editSummary}</div>}
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
