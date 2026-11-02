import { useState } from 'react';
import { Link } from 'react-router';
import { CORRECTION_PROBLEM_LABELS, LIMITS, TRUST, type Correction, type StoryDetail } from '@hexstory/shared';
import { errorMessage } from '../api/client';
import { useCorrections, useModerateCorrection } from '../api/queries';
import { shortDate } from '../lib/format';
import { ConfirmAction } from './ConfirmAction';
import { useToast } from './Toast';

const STATUS: Record<Correction['status'], { label: string; chip: string }> = {
  open: { label: 'Open', chip: 'chip-pending' },
  accepted: { label: 'Accepted', chip: 'chip-current' },
  rejected: { label: 'Not accepted', chip: 'chip-rejected' },
};

/**
 * Disputed statements and their outcomes. Corrections never change the story by themselves: a fix is a
 * normal edit, so the history keeps both the disputed version and the corrected one, and every decision
 * is explained in public.
 */
export function Corrections({ story, viewer, onDispute }: {
  story: StoryDetail;
  viewer: { id: string; trustLevel: number } | undefined;
  onDispute: (() => void) | null;
}) {
  const corrections = useCorrections(story.id);
  const items = corrections.data ?? [];
  if (!items.length && !onDispute) return null;
  return (
    <section className="corrections-section" id="corrections" aria-labelledby="corrections-heading">
      <h3 className="section-label" id="corrections-heading">Corrections{items.length > 0 && <span className="section-count"> · {items.length}</span>}</h3>
      {corrections.isLoading && <p className="muted small">Loading…</p>}
      {!corrections.isLoading && items.length === 0 && (
        <p className="muted small">Nobody has disputed anything in this story. Spotted an error? Quote it and show your evidence.</p>
      )}
      {items.map((c) => <CorrectionCard key={c.id} correction={c} story={story} viewer={viewer} />)}
      {onDispute && <button type="button" className="button" onClick={onDispute}>Dispute a statement</button>}
    </section>
  );
}

function CorrectionCard({ correction: c, story, viewer }: {
  correction: Correction;
  story: StoryDetail;
  viewer: { id: string; trustLevel: number } | undefined;
}) {
  const status = STATUS[c.status];
  // Nobody decides their own correction; only moderators decide those about a story they started.
  const canDecide = story.can.review && c.status === 'open' && !c.removed && !!viewer && c.author.id !== viewer.id
    && (story.createdBy.id !== viewer.id || viewer.trustLevel >= TRUST.MODERATOR);
  return (
    <article className={`correction ${c.removed ? 'correction-removed' : ''}`}>
      <div className="correction-head">
        <span className={`chip ${status.chip}`}>{status.label}</span>
        {c.removed && <span className="chip chip-rejected">Removed</span>}
        <span className="small muted">{CORRECTION_PROBLEM_LABELS[c.problem]}</span>
      </div>
      <blockquote className="correction-quote">{c.quote}</blockquote>
      <p className="small muted">
        {c.stillInStory ? 'Still in the current text.' : 'No longer in the current text.'}{' '}
        <Link to={`/v/${c.revisionId}`}>Version disputed</Link>
      </p>
      <p className="correction-proposal">{c.proposal}</p>
      <ul className="correction-evidence">
        {c.evidence.map((s, i) => (
          <li key={i}>{s.url ? <a href={s.url} target="_blank" rel="nofollow ugc noopener noreferrer">{s.title}</a> : s.title}</li>
        ))}
      </ul>
      <p className="small muted">
        Proposed by <Link to={`/u/${c.author.id}`}>{c.author.displayName}</Link> · {shortDate(c.createdAt)}
      </p>
      {c.resolution && (
        <div className="correction-outcome">
          <p><strong>Outcome:</strong> {c.resolution.note}</p>
          <p className="small muted">
            Decided by <Link to={`/u/${c.resolution.by.id}`}>{c.resolution.by.displayName}</Link> · {shortDate(c.resolution.at)}
            {c.resolution.fixedRevisionId && <> · <Link to={`/v/${c.resolution.fixedRevisionId}`}>See the corrected version</Link></>}
          </p>
        </div>
      )}
      {canDecide && <DecideCorrection correction={c} story={story} />}
      {story.can.review && !c.removed && <RemoveCorrection correction={c} storyId={story.id} />}
    </article>
  );
}

function DecideCorrection({ correction, story }: { correction: Correction; story: StoryDetail }) {
  const moderate = useModerateCorrection(story.id);
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  // Accepting usually follows an edit that fixed it: linking that version lets readers check the fix.
  const fixedByCurrent = story.revision.id !== correction.revisionId;
  const [linkFix, setLinkFix] = useState(fixedByCurrent);
  if (!open) return <button type="button" className="button" onClick={() => setOpen(true)}>Decide…</button>;
  const decide = (decision: 'accepted' | 'rejected') =>
    moderate.mutate(
      { id: correction.id, action: 'resolve', decision, note: note.trim(), fixedRevisionId: decision === 'accepted' && linkFix ? story.revision.id : null },
      { onSuccess: () => { toast(decision === 'accepted' ? 'Correction accepted' : 'Correction not accepted'); setOpen(false); } },
    );
  return (
    <div className="remove-confirm" role="group" aria-label="Decide this correction">
      <label className="field">
        <span>Public note explaining the decision</span>
        <textarea rows={2} maxLength={LIMITS.correctionNoteMax} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <label className="toggle">
        <input type="checkbox" checked={linkFix} onChange={(e) => setLinkFix(e.target.checked)} />
        The current version fixes it (link it as the correction)
      </label>
      <div className="row">
        <button type="button" className="button button-primary" disabled={!note.trim() || moderate.isPending} onClick={() => decide('accepted')}>Accept</button>
        <button type="button" className="button button-danger" disabled={!note.trim() || moderate.isPending} onClick={() => decide('rejected')}>Don't accept</button>
        <button type="button" className="button" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {!note.trim() && <p className="small muted">A note is required: readers see why.</p>}
      {moderate.error && <p className="error-text">{errorMessage(moderate.error)}</p>}
    </div>
  );
}

function RemoveCorrection({ correction, storyId }: { correction: Correction; storyId: string }) {
  const moderate = useModerateCorrection(storyId);
  const toast = useToast();
  return (
    <div className="row">
      <ConfirmAction
        label="Remove"
        explain="For abuse only: removed corrections are visible to reviewers only. Open reports about it are closed."
        busy={moderate.isPending}
        onConfirm={(reason, done) => moderate.mutate({ id: correction.id, action: 'remove', reason }, { onSuccess: () => { toast('Correction removed'); done(); } })}
      />
      {moderate.error && <p className="error-text">{errorMessage(moderate.error)}</p>}
    </div>
  );
}
