import { describe, expect, it } from 'vitest';
import { checkSupportUrl, resolveSupportLinks, supportUrlOrNull } from './support.js';

describe('support link validation', () => {
  it('accepts the owner PayPal.Me link and the documented paypal.me form', () => {
    expect(supportUrlOrNull('paypal', 'https://www.paypal.com/paypalme/hexstory')).toBe('https://www.paypal.com/paypalme/hexstory');
    expect(supportUrlOrNull('paypal', '  https://www.paypal.com/paypalme/hexstory/5  ')).toBe('https://www.paypal.com/paypalme/hexstory/5');
    expect(supportUrlOrNull('paypal', 'https://paypal.me/hexstory')).toBe('https://paypal.me/hexstory');
  });

  it('accepts Stripe Payment Links, including test-mode links and query parameters', () => {
    expect(supportUrlOrNull('stripe', 'https://buy.stripe.com/aEU5kE3pQ8Zb0og000')).toBe('https://buy.stripe.com/aEU5kE3pQ8Zb0og000');
    expect(supportUrlOrNull('stripe', 'https://buy.stripe.com/test_eVa3do41l4Ye6KkcMN?locale=de')).toBe(
      'https://buy.stripe.com/test_eVa3do41l4Ye6KkcMN?locale=de',
    );
  });

  it('treats empty and unset as not configured', () => {
    for (const raw of ['', '   ', undefined, null]) {
      expect(supportUrlOrNull('stripe', raw)).toBeNull();
      expect(checkSupportUrl('paypal', raw)).toEqual({ ok: false, reason: 'not set' });
    }
  });

  it('rejects anything that is not https', () => {
    for (const raw of [
      'http://buy.stripe.com/abc',
      'javascript:alert(1)//buy.stripe.com/abc',
      'data:text/html,buy.stripe.com',
      'ftp://buy.stripe.com/abc',
      '//buy.stripe.com/abc',
      'buy.stripe.com/abc',
    ]) {
      expect(supportUrlOrNull('stripe', raw), raw).toBeNull();
    }
  });

  it('rejects lookalike and wrong hosts (exact match only)', () => {
    for (const raw of [
      'https://buy.stripe.com.evil.com/abc',
      'https://evilbuy.stripe.com/abc',
      'https://checkout.stripe.com/abc',
      'https://stripe.com/abc',
      'https://buy.stripe.com./abc',
      'https://buy.strípe.com/abc',
      'https://xn--buy-stripe-xyz.com/abc',
      'https://www.paypal.com/paypalme/hexstory', // right host, wrong provider
    ]) {
      expect(supportUrlOrNull('stripe', raw), raw).toBeNull();
    }
    for (const raw of [
      'https://paypal.com.attacker.net/paypalme/hexstory',
      'https://www.paypal.com.attacker.net/paypalme/hexstory',
      'https://evilpaypal.com/paypalme/hexstory',
      'https://paypal.com/paypalme/hexstory',
      'https://www.paypa1.com/paypalme/hexstory',
      'https://www.pаypal.com/paypalme/hexstory', // Cyrillic "а" → xn-- host
      'https://xn--www-paypal-xyz.com/paypalme/hexstory',
      'https://paypal.me.evil.com/hexstory',
      'https://buy.stripe.com/abc',
    ]) {
      expect(supportUrlOrNull('paypal', raw), raw).toBeNull();
    }
  });

  it('rejects credentials and explicit ports, even the default one', () => {
    for (const raw of [
      'https://user:pass@buy.stripe.com/abc',
      'https://user@buy.stripe.com/abc',
      'https://evil.com@buy.stripe.com/abc',
      'https://buy.stripe.com:443/abc',
      'https://buy.stripe.com:8443/abc',
    ]) {
      expect(supportUrlOrNull('stripe', raw), raw).toBeNull();
    }
    expect(supportUrlOrNull('paypal', 'https://www.paypal.com:443/paypalme/hexstory')).toBeNull();
  });

  it('requires a specific link rather than a home page or other page', () => {
    expect(supportUrlOrNull('stripe', 'https://buy.stripe.com/')).toBeNull();
    expect(supportUrlOrNull('paypal', 'https://www.paypal.com/')).toBeNull();
    expect(supportUrlOrNull('paypal', 'https://www.paypal.com/signin?returnUri=https://evil.com')).toBeNull();
    expect(supportUrlOrNull('paypal', 'https://paypal.me/')).toBeNull();
  });

  it('reports configured-but-invalid values without echoing the URL', () => {
    const { links, problems } = resolveSupportLinks({
      stripe: 'https://buy.stripe.com.evil.com/secret-looking-path?x=1',
      paypal: 'https://www.paypal.com/paypalme/hexstory',
    });
    expect(links).toEqual({ stripe: null, paypal: 'https://www.paypal.com/paypalme/hexstory' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('STRIPE_SUPPORT_URL');
    expect(problems[0]).not.toContain('evil');
    expect(problems[0]).not.toContain('secret-looking-path');
    expect(resolveSupportLinks({}).problems).toEqual([]);
  });
});
