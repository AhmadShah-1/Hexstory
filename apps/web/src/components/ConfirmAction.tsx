import { useState } from 'react';

/**
 * A button for an action that is hard to undo: the first click opens an inline confirmation with an
 * explanation and an optional reason (recorded in the audit log), the second does it.
 */
export function ConfirmAction({ label, confirmLabel = label, explain, busy = false, onConfirm, danger = true }: {
  label: string;
  confirmLabel?: string;
  explain: string;
  busy?: boolean;
  onConfirm: (reason: string | undefined, done: () => void) => void;
  danger?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (!open) {
    return (
      <button className={`button ${danger ? 'button-danger' : ''}`} disabled={busy} onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  }
  return (
    <div className="remove-confirm" role="group" aria-label={label}>
      <p className="small">{explain}</p>
      <input placeholder="Reason (optional)" aria-label="Reason (optional)" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="row">
        <button
          className={`button ${danger ? 'button-danger' : 'button-primary'}`}
          disabled={busy}
          onClick={() => onConfirm(reason.trim() || undefined, () => { setOpen(false); setReason(''); })}
        >
          {confirmLabel}
        </button>
        <button className="button" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}
