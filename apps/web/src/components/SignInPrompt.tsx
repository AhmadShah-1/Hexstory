import { useLocation } from 'react-router';
import { signInUrl, useSession } from '../api/queries';

export function SignInButton({ label = 'Sign in with Google', className = 'button button-primary' }: { label?: string; className?: string }) {
  const location = useLocation();
  const session = useSession();
  if (session.data && !session.data.signInEnabled) {
    return (
      <span className={`${className} is-disabled`} title="Google sign-in has not been configured on this server">
        Sign-in unavailable
      </span>
    );
  }
  return (
    <a className={className} href={signInUrl(location.pathname + location.search)}>
      {label}
    </a>
  );
}

/** Inline call-to-action shown where a signed-out visitor would otherwise see a write action. */
export function SignInPrompt({ reason }: { reason: string }) {
  return (
    <div className="signin-prompt">
      <p>{reason}</p>
      <SignInButton />
    </div>
  );
}
