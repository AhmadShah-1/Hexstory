import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

type Toast = (message: string) => void;
const ToastContext = createContext<Toast>(() => {});

export const useToast = () => useContext(ToastContext);

/** One quiet message at a time, bottom-centre, gone after a few seconds. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<{ text: string; id: number } | null>(null);
  const show = useCallback((text: string) => setMessage({ text, id: Date.now() }), []);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 4_500);
    return () => clearTimeout(timer);
  }, [message]);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {message && <div key={message.id} className="toast">{message.text}</div>}
      </div>
    </ToastContext.Provider>
  );
}
