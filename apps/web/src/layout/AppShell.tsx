import { useEffect } from 'react';
import { Link, Outlet, useLocation, useSearchParams } from 'react-router';
import { useSession } from '../api/queries';
import { ToastProvider, useToast } from '../components/Toast';
import { TourProvider } from '../components/Tour';
import { MapControls } from '../map/MapControls';
import { MapProvider } from '../map/MapContext';
import { WorldMap } from '../map/WorldMap';
import { identifyClarityUser } from '../lib/clarity';
import { Welcome } from '../views/Welcome';
import { TopBar } from './TopBar';

const SIGNIN_MESSAGES: Record<string, string> = {
  failed: 'Sign-in did not complete. Please try again.',
  banned: 'This account has been suspended.',
  unavailable: "Sign-in isn't available yet.",
};

/**
 * The map is always mounted; every route renders into the floating panel on top of it. The home route
 * is a guided-discovery panel, so visitors don't have to find stories by clicking random hexagons.
 */
export function AppShell() {
  return (
    <ToastProvider>
      <MapProvider>
        <TourProvider>
        <div className="app">
          <WorldMap />
          <TopBar />
          <MapControls />
          <Outlet />
          <FooterLinks />
          <SignInNotice />
          <Welcome />
          <ClarityIdentify />
        </div>
        </TourProvider>
      </MapProvider>
    </ToastProvider>
  );
}

function FooterLinks() {
  return (
    <nav className="footer-links" aria-label="Site">
      <Link to="/collections">Collections</Link>
      <Link to="/about">About</Link>
      <Link to="/terms">Terms</Link>
      <Link to="/privacy">Privacy</Link>
      <Link to="/support">Support</Link>
    </nav>
  );
}

function SignInNotice() {
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const signin = params.get('signin');
  useEffect(() => {
    if (!signin) return;
    toast(SIGNIN_MESSAGES[signin] ?? 'Sign-in failed.');
    params.delete('signin');
    setParams(params, { replace: true });
  }, [signin, params, setParams, toast]);
  return null;
}

/** Tags Clarity recordings with the signed-in person's public id and display name (re-sent per page, as Clarity advises). */
function ClarityIdentify() {
  const user = useSession().data?.user;
  const { pathname } = useLocation();
  const id = user?.id;
  const displayName = user?.displayName;
  useEffect(() => {
    if (id && displayName) identifyClarityUser({ id, displayName });
  }, [id, displayName, pathname]);
  return null;
}
