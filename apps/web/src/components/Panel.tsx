import { useEffect, useRef, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

/**
 * The single floating panel that holds every view beside the map
 * (right-hand card on desktop, bottom sheet on phones).
 */
export function Panel({ title, subtitle, back, children, footer, wide = false, onClose }: {
  title: ReactNode;
  subtitle?: ReactNode;
  back?: { label: string; to: string | number };
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** Replaces the default close action (back to the map) on × and Escape. */
  onClose?: () => void;
}) {
  const navigate = useNavigate();
  const close = onClose ?? (() => navigate('/'));
  // The key handler is registered once and reads the latest close action.
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]')) return;
      // Escape inside a field belongs to that field (closing a link box, leaving a menu), not the panel.
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <aside className={`panel ${wide ? 'panel-wide' : ''}`} aria-label="Details">
      <header className="panel-head">
        <div className="panel-head-text">
          {back && (
            <button className="link-button back-link" onClick={() => navigate(back.to as string)}>
              ← {back.label}
            </button>
          )}
          <h1 className="panel-title">{title}</h1>
          {subtitle && <div className="panel-subtitle">{subtitle}</div>}
        </div>
        <button className="icon-button" onClick={close} aria-label="Close panel">
          ×
        </button>
      </header>
      <div className="panel-body">{children}</div>
      {footer && <footer className="panel-foot">{footer}</footer>}
    </aside>
  );
}
