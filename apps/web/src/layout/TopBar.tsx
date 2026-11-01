import { Link } from 'react-router';
import { TRUST } from '@hexstory/shared';
import { useSession } from '../api/queries';
import { PlaceSearch } from '../components/PlaceSearch';
import { SignInButton } from '../components/SignInPrompt';
import { initials } from '../lib/format';

export function TopBar() {
  const session = useSession();
  const user = session.data?.user;

  return (
    <>
      <Link to="/about" className="brand" aria-label="About Hexstory">
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <path d="M16 2 28.1 9v14L16 30 3.9 23V9z" fill="#c2410c" />
          <path d="M16 9.5 21.6 12.75v6.5L16 22.5l-5.6-3.25v-6.5z" fill="#fff7ed" />
        </svg>
        <span>Hexstory</span>
      </Link>
      <PlaceSearch />
      <div className="account">
        {user ? (
          <>
            {user.trustLevel >= TRUST.MODERATOR && (
              <Link to="/moderation" className="button button-floating">Moderation</Link>
            )}
            {user.trustLevel >= TRUST.REVIEWER && (
              <Link to="/watchtower" className="button button-floating">Watchtower</Link>
            )}
            <Link to="/me" className="avatar avatar-button" aria-label="Your account" title={user.displayName}>
              {initials(user.displayName)}
            </Link>
          </>
        ) : (
          session.data && <SignInButton label="Sign in" className="button button-floating" />
        )}
      </div>
    </>
  );
}
