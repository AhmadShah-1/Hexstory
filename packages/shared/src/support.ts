/**
 * Links for the public Support page (voluntary contributions through provider-hosted pages).
 * Hexstory never handles payments itself: it only links to a Stripe Payment Link and a PayPal.Me page.
 * See docs/DEPLOYMENT.md "Support page (Stripe and PayPal links)".
 */
export type SupportProvider = 'stripe' | 'paypal';

/** What `GET /api/support` returns. `null` = that option is not offered. */
export interface SupportLinks {
  stripe: string | null;
  paypal: string | null;
}

/**
 * Exact hostnames per provider; no suffix or substring matching, so `buy.stripe.com.evil.com`,
 * `evilbuy.stripe.com` and punycode lookalikes never match.
 * - Stripe: `buy.stripe.com` is the Stripe-hosted Payment Link host. (Stripe also offers custom
 *   domains for Payment Links; those are deliberately not accepted here.)
 * - PayPal: PayPal documents PayPal.Me links as `paypal.me/<name>` and `www.paypal.com/paypalme/<name>`.
 */
const HOSTS: Record<SupportProvider, readonly string[]> = {
  stripe: ['buy.stripe.com'],
  paypal: ['www.paypal.com', 'paypal.me'],
};

/** Path must point at a specific link, not a site's home page. */
const PATHS: Record<string, RegExp> = {
  'buy.stripe.com': /^\/[A-Za-z0-9_-]+\/?$/,
  'www.paypal.com': /^\/paypalme\/[A-Za-z0-9]+(\/[^/]*)?\/?$/,
  'paypal.me': /^\/[A-Za-z0-9]+(\/[^/]*)?\/?$/,
};

export type SupportUrlCheck = { ok: true; url: string } | { ok: false; reason: string };

/**
 * Validates a configured support link. Unset/empty → `{ ok: false, reason: 'not set' }`.
 * Requires https, no username/password, no explicit port, and an allowed exact hostname.
 * The reason never contains the URL itself, so it is safe to log.
 */
export function checkSupportUrl(provider: SupportProvider, raw: string | null | undefined): SupportUrlCheck {
  const value = raw?.trim() ?? '';
  if (!value) return { ok: false, reason: 'not set' };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'must use https://' };
  if (url.username || url.password) return { ok: false, reason: 'must not contain a username or password' };
  // `new URL` drops a default port (":443"), so also look at what was actually written: the
  // authority must be exactly the hostname (no port, credentials, trailing dot or odd characters).
  const authority = /^https:\/\/([^/?#\\]*)/i.exec(value)?.[1];
  if (url.port || authority?.includes(':')) return { ok: false, reason: 'must not specify a port' };
  const allowed = HOSTS[provider];
  if (!allowed.includes(url.hostname) || authority?.toLowerCase() !== url.hostname) {
    return { ok: false, reason: `host must be ${allowed.join(' or ')}` };
  }
  if (!PATHS[url.hostname]!.test(url.pathname)) {
    return {
      ok: false,
      reason: provider === 'stripe' ? 'must be a Payment Link (https://buy.stripe.com/<id>)' : 'must be a PayPal.Me link (https://www.paypal.com/paypalme/<name>)',
    };
  }
  return { ok: true, url: url.href };
}

/** The validated link, or null when unset or invalid. */
export const supportUrlOrNull = (provider: SupportProvider, raw: string | null | undefined): string | null => {
  const check = checkSupportUrl(provider, raw);
  return check.ok ? check.url : null;
};

export const SUPPORT_ENV: Record<SupportProvider, string> = { stripe: 'STRIPE_SUPPORT_URL', paypal: 'PAYPAL_SUPPORT_URL' };

/** Resolves both links; `problems` lists configured-but-invalid values (safe to log: no URLs). */
export function resolveSupportLinks(raw: Partial<Record<SupportProvider, string | undefined>>): {
  links: SupportLinks;
  problems: string[];
} {
  const links: SupportLinks = { stripe: null, paypal: null };
  const problems: string[] = [];
  for (const provider of ['stripe', 'paypal'] as const) {
    const check = checkSupportUrl(provider, raw[provider]);
    if (check.ok) links[provider] = check.url;
    else if (check.reason !== 'not set') problems.push(`${SUPPORT_ENV[provider]} ignored: ${check.reason}. The option is hidden.`);
  }
  return { links, problems };
}
