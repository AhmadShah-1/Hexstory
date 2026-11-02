import { useState } from 'react';
import { Link } from 'react-router';
import { displayNameSchema, type Me } from '@hexstory/shared';
import { errorMessage } from '../api/client';
import { useSession, useSignOut, useUpdateProfile } from '../api/queries';
import { Modal } from '../components/Modal';

/**
 * Shown once after the first sign-in: pick a public name and accept the terms. Someone who doesn't want to
 * can sign out instead and keep reading signed out.
 */
export function Welcome() {
  const user = useSession().data?.user;
  if (!user || user.termsAccepted) return null;
  return <WelcomeForm user={user} />;
}

function WelcomeForm({ user }: { user: Me }) {
  const update = useUpdateProfile();
  const signOut = useSignOut();
  // Starts as the suggested name; after that the field is entirely the user's (it may be emptied).
  const [name, setName] = useState(user.displayName);
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = displayNameSchema.safeParse(name);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Invalid name');
    setError(null);
    update.mutate({ displayName: parsed.data === user.displayName ? undefined : parsed.data, acceptTerms: true });
  };

  return (
    <Modal open title="Welcome to Hexstory" onClose={() => {}} dismissible={false}>
      <form onSubmit={submit} className="welcome">
        <label className="field">
          <span>Your public name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} autoFocus />
          <span className="muted small">Shown next to everything you write. It doesn't have to be your real name.</span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span>
            I agree to the <Link to="/terms" target="_blank">Terms</Link> and{' '}
            <Link to="/privacy" target="_blank">Privacy Policy</Link>, and I license what I write under CC BY-SA 4.0.
          </span>
        </label>
        {(error ?? update.error) && <p className="error-text">{error ?? errorMessage(update.error)}</p>}
        <button className="button button-primary button-block" disabled={!agreed || update.isPending}>
          Start exploring
        </button>
        <button type="button" className="link-button small" disabled={signOut.isPending} onClick={() => signOut.mutate()}>
          Not now: sign out and keep reading
        </button>
        {signOut.error && <p className="error-text">{errorMessage(signOut.error)}</p>}
      </form>
    </Modal>
  );
}
