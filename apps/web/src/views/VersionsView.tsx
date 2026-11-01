import { Link, useParams } from 'react-router';
import { useRevisions, useStory } from '../api/queries';
import { Panel } from '../components/Panel';
import { shortDate } from '../lib/format';

const STATUS_LABEL = { pending: 'Waiting for review', accepted: '', rejected: 'Rejected' } as const;

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
      <ul className="version-list">
        {revisions.data?.map((r) => (
          <li key={r.id}>
            <Link to={`/v/${r.id}`} className="version-row">
              <div>
                <strong>{shortDate(r.createdAt)}</strong> · {r.author.displayName}
                {r.isCurrent && <span className="chip chip-current">Current</span>}
                {STATUS_LABEL[r.status] && <span className={`chip chip-${r.status}`}>{STATUS_LABEL[r.status]}</span>}
                {r.flags.map((f) => (
                  <span key={f} className="chip chip-flag">{f.replace('-', ' ')}</span>
                ))}
              </div>
              {r.editSummary && <div className="muted small">{r.editSummary}</div>}
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
