import { useState } from 'react';
import { REPORT_REASONS, type ReportReason, type ReportTarget } from '@hexstory/shared';
import { errorMessage } from '../api/client';
import { useReport } from '../api/queries';
import { Modal } from './Modal';
import { useToast } from './Toast';

const REASON_LABELS: Record<ReportReason, string> = {
  vandalism: 'Vandalism or deliberately false',
  harassment: 'Harassment or hate',
  'personal-info': "Reveals someone's personal information",
  spam: 'Spam or advertising',
  copyright: 'Copyright problem',
  other: 'Something else',
};

const TITLES: Record<ReportTarget, string> = {
  story: 'Report this story',
  revision: 'Report this version',
  comment: 'Report this message',
  user: 'Report this person',
};

export function ReportDialog({ open, onClose, targetType, targetId }: {
  open: boolean;
  onClose: () => void;
  targetType: ReportTarget;
  targetId: string;
}) {
  // Start from the likeliest reason for what is being reported.
  const [reason, setReason] = useState<ReportReason>(targetType === 'story' || targetType === 'revision' ? 'vandalism' : 'harassment');
  const [details, setDetails] = useState('');
  const report = useReport();
  const toast = useToast();

  const submit = () =>
    report.mutate(
      { targetType, targetId, reason, details: details.trim() || undefined },
      {
        onSuccess: () => {
          toast('Thanks. A reviewer will take a look.');
          onClose();
        },
      },
    );

  return (
    <Modal open={open} onClose={onClose} title={TITLES[targetType]}>
      <fieldset className="radio-list">
        <legend className="field-label">What's wrong?</legend>
        {REPORT_REASONS.map((r) => (
          <label key={r}>
            <input type="radio" name="reason" checked={reason === r} onChange={() => setReason(r)} />
            {REASON_LABELS[r]}
          </label>
        ))}
      </fieldset>
      <label className="field">
        <span>Anything reviewers should know? (optional)</span>
        <textarea rows={3} maxLength={1000} value={details} onChange={(e) => setDetails(e.target.value)} />
      </label>
      {report.error && <p className="error-text">{errorMessage(report.error)}</p>}
      <div className="row-end">
        <button className="button" onClick={onClose}>Cancel</button>
        <button className="button button-primary" onClick={submit} disabled={report.isPending}>
          Send report
        </button>
      </div>
    </Modal>
  );
}
