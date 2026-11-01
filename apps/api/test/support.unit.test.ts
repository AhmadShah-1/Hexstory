import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { supportRoutes } from '../src/routes/support.js';

const BASE = { NODE_ENV: 'test', DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused', APP_ORIGIN: 'http://localhost:5173' };
const OWNER_PAYPAL = 'https://www.paypal.com/paypalme/hexstory';
const STRIPE = 'https://buy.stripe.com/test_eVa3do41l4Ye6KkcMN';

async function getSupport(env: Record<string, string | undefined>) {
  const config = loadConfig({ ...BASE, ...env });
  const warnings: string[] = [];
  const noop = () => {};
  const logger = {
    level: 'info', info: noop, error: noop, debug: noop, fatal: noop, trace: noop, silent: noop,
    warn: (msg: unknown) => void warnings.push(String(msg)),
    child: () => logger,
  };
  const app = Fastify({ loggerInstance: logger as never });
  await app.register(supportRoutes({ config }));
  const res = await app.inject({ method: 'GET', url: '/api/support' });
  await app.close();
  return { status: res.statusCode, body: res.json(), cache: res.headers['cache-control'], warnings, config };
}

describe('GET /api/support', () => {
  it('returns nulls when nothing is configured (unset or empty)', async () => {
    for (const env of [{}, { STRIPE_SUPPORT_URL: '', PAYPAL_SUPPORT_URL: '' }]) {
      const res = await getSupport(env);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ stripe: null, paypal: null });
      expect(res.warnings).toEqual([]);
    }
  });

  it('returns valid links', async () => {
    const res = await getSupport({ STRIPE_SUPPORT_URL: STRIPE, PAYPAL_SUPPORT_URL: OWNER_PAYPAL });
    expect(res.body).toEqual({ stripe: STRIPE, paypal: OWNER_PAYPAL });
    expect(res.cache).toBe('public, max-age=300');
  });

  it('hides invalid links without failing startup, and warns without logging the URL', async () => {
    const res = await getSupport({
      STRIPE_SUPPORT_URL: 'https://buy.stripe.com.evil.com/abc?token=x',
      PAYPAL_SUPPORT_URL: 'http://www.paypal.com/paypalme/hexstory',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stripe: null, paypal: null });
    expect(res.warnings).toHaveLength(2);
    expect(res.warnings.join('\n')).toMatch(/STRIPE_SUPPORT_URL ignored/);
    expect(res.warnings.join('\n')).toMatch(/PAYPAL_SUPPORT_URL ignored: must use https/);
    expect(res.warnings.join('\n')).not.toContain('evil');
  });

  it('keeps one valid option when the other is invalid', async () => {
    const res = await getSupport({ STRIPE_SUPPORT_URL: 'https://user:pw@buy.stripe.com/abc', PAYPAL_SUPPORT_URL: OWNER_PAYPAL });
    expect(res.body).toEqual({ stripe: null, paypal: OWNER_PAYPAL });
  });
});
