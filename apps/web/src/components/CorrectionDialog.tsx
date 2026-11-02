import { useState } from 'react';
import { CORRECTION_PROBLEMS, CORRECTION_PROBLEM_LABELS, LIMITS, createCorrectionSchema, type CorrectionProblem } from '@hexstory/shared';
import { ApiError, errorMessage } from '../api/client';
import { useCreateCorrection } from '../api/queries';
import { Field, SourcesInput, fieldErrors, sourcesFromDrafts, type SourceDraft } from './DateInput';
import { Modal } from './Modal';
import { useToast } from './Toast';

/**
 * Dispute one statement of the version on screen: quote it (prefilled from a text selection), say what's
 * wrong and what it should say, and give counter-evidence. Reviewers decide; the outcome is public.
 */
export function CorrectionDialog({ open, onClose, storyId, revisionId, initialQuote }: {
  open: boolean;
  onClose: () => void;
  storyId: string;
  revisionId: string;
  initialQuote: string;
}) {
  const [quote, setQuote] = useState(initialQuote);
  const [problem, setProblem] = useState<CorrectionProblem>('inaccurate');
  const [proposal, setProposal] = useState('');
  const [evidence, setEvidence] = useState<SourceDraft[]>([{ title: '', url: '' }]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const create = useCreateCorrection(storyId);
  const toast = useToast();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = createCorrectionSchema.safeParse({ revisionId, quote, problem, proposal, evidence: sourcesFromDrafts(evidence) });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    create.mutate(parsed.data, {
      onSuccess: () => {
        toast('Thanks. Reviewers will look at your correction; the outcome is shown on the story.');
        onClose();
      },
      onError: (err) => {
        if (err instanceof ApiError && err.code === 'quote-not-found') {
          setErrors({ quote: 'That exact text isn’t in this version. Copy the statement from the story, or select it before pressing “Dispute a statement”.' });
        }
      },
    });
  };
  const quoteError = errors.quote;

  return (
    <Modal open={open} onClose={onClose} title="Dispute a statement">
      <form className="correction-form" onSubmit={submit} noValidate>
        <Field label="The statement you dispute" error={quoteError} hint="Quote it exactly as it appears in the story.">
          <textarea rows={3} maxLength={LIMITS.correctionQuoteMax} value={quote} onChange={(e) => setQuote(e.target.value)} />
        </Field>
        <fieldset className="radio-list">
          <legend className="field-label">What's wrong with it?</legend>
          {CORRECTION_PROBLEMS.map((p) => (
            <label key={p}>
              <input type="radio" name="problem" checked={problem === p} onChange={() => setProblem(p)} />
              {CORRECTION_PROBLEM_LABELS[p]}
            </label>
          ))}
        </fieldset>
        <Field label="What should it say, and why?" error={errors.proposal}>
          <textarea rows={4} maxLength={LIMITS.correctionProposalMax} value={proposal} onChange={(e) => setProposal(e.target.value)} />
        </Field>
        <fieldset className="field">
          <legend>Your evidence</legend>
          <p className="muted small">At least one source that supports your correction.</p>
          <SourcesInput value={evidence} onChange={setEvidence} />
          {errors.evidence && <p className="error-text">{errors.evidence}</p>}
        </fieldset>
        {create.error && !(create.error instanceof ApiError && create.error.code === 'quote-not-found') && (
          <p className="error-text">{errorMessage(create.error)}</p>
        )}
        <div className="row-end">
          <button type="button" className="button" onClick={onClose}>Cancel</button>
          <button className="button button-primary" disabled={create.isPending}>Send correction</button>
        </div>
      </form>
    </Modal>
  );
}
