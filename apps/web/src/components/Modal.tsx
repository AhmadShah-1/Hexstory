import { useEffect, useRef, type ReactNode } from 'react';

/** Thin wrapper over <dialog>: focus trapping, Escape and the backdrop come from the browser. */
export function Modal({ open, onClose, title, children, dismissible = true }: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={(e) => {
        e.preventDefault();
        if (dismissible) onClose();
      }}
      onClick={(e) => {
        if (dismissible && e.target === ref.current) onClose();
      }}
    >
      <div className="modal-body">
        <div className="modal-head">
          <h2>{title}</h2>
          {dismissible && (
            <button className="icon-button" onClick={onClose} aria-label="Close">
              ×
            </button>
          )}
        </div>
        {open && children}
      </div>
    </dialog>
  );
}
