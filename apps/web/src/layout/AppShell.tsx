import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation, useSearchParams } from 'react-router';
import { ToastProvider, useToast } from '../components/Toast';
import { MapProvider, useMapState } from '../map/MapContext';
import { WorldMap } from '../map/WorldMap';
import { Welcome } from '../views/Welcome';
import { TopBar } from './TopBar';

const SIGNIN_MESSAGES: Record<string, string> = {
  failed: 'Sign-in did not complete. Please try again.',
  banned: 'This account has been suspended.',
  unavailable: "Sign-in isn't available yet.",
};

/** The map is always mounted; every route renders into the floating panel on top of it. */
export function AppShell() {
  return (
    <ToastProvider>
      <MapProvider>
        <div className="app">
          <WorldMap />
          <TopBar />
          <Outlet />
          <FooterLinks />
          <FirstVisitHint />
          <SignInNotice />
          <Welcome />
        </div>
      </MapProvider>
    </ToastProvider>
  );
}

function FooterLinks() {
  return (
    <nav className="footer-links" aria-label="Site">
      <Link to="/about">About</Link>
      <Link to="/terms">Terms</Link>
      <Link to="/privacy">Privacy</Link>
    </nav>
  );
}

const HINT_KEY = 'hexstory:hint-dismissed';
function readHintDismissed() {
  try {
    return localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return false;
  }
}

/** A single gentle pointer for first-time visitors; disappears once they open any hex. */
function FirstVisitHint() {
  const location = useLocation();
  const { mode } = useMapState();
  const [dismissed, setDismissed] = useState(readHintDismissed);

  useEffect(() => {
    if (location.pathname === '/' || dismissed) return;
    setDismissed(true);
    try {
      localStorage.setItem(HINT_KEY, '1');
    } catch {
      /* storage unavailable; the hint just shows again next visit */
    }
  }, [location.pathname, dismissed]);

  if (dismissed || location.pathname !== '/' || mode !== 'browse') return null;
  return <div className="hint">Every place has a story. Tap a hexagon to explore.</div>;
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
