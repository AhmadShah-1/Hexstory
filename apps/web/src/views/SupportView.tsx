import { useNavigate } from 'react-router';
import { supportUrlOrNull } from '@hexstory/shared';
import { useSupportLinks } from '../api/queries';
import { closePage } from '../lib/navigation';
import { Modal } from '../components/Modal';

/**
 * Voluntary contributions through provider-hosted pages (a Stripe Payment Link and PayPal.Me).
 * Hexstory takes no payment details and records nothing: these are ordinary outbound links, and
 * nothing on this site treats a return from Stripe or PayPal as proof of payment.
 */
export function SupportView() {
  const navigate = useNavigate();
  const { data, isPending, isError, refetch } = useSupportLinks();
  // Defence in depth: render only links that pass the same allowlist the API applies.
  const stripe = supportUrlOrNull('stripe', data?.stripe);
  const paypal = supportUrlOrNull('paypal', data?.paypal);

  return (
    <Modal open onClose={() => closePage(navigate)} title="Support Hexstory">
      <div className="prose support">
        <p>
          Hexstory is free to use. Voluntary contributions help cover hosting, storage, and continued development.
        </p>
        <p>
          Contributions are entirely optional. They do not unlock features, access or moderation privileges, and they
          don't earn anyone preferential treatment: everyone's stories, edits and reports are handled the same way.
        </p>

        <h3 id="support-options-title">Ways to contribute</h3>
        {isPending ? (
          <p className="muted" role="status">
            Loading…
          </p>
        ) : isError ? (
          <p className="notice" role="alert">
            The contribution options couldn't be loaded.{' '}
            <button type="button" className="link-button" onClick={() => refetch()}>
              Try again
            </button>
          </p>
        ) : !stripe && !paypal ? (
          <p className="notice">
            Contributions aren't available right now. Hexstory stays free to use either way; thank you for thinking of
            it.
          </p>
        ) : (
          <ul className="support-options" aria-labelledby="support-options-title">
            {stripe && (
              <li className="support-option">
                <h4>Card</h4>
                <p>
                  Pay by card on a secure checkout page hosted by Stripe. You don't need a Stripe account. Apple Pay or
                  Google Pay may also be offered, depending on your device.
                </p>
                <a className="button button-primary" href={stripe} target="_blank" rel="noopener noreferrer">
                  Support with card<span className="visually-hidden"> (opens Stripe in a new tab)</span>
                </a>
              </li>
            )}
            {paypal && (
              <li className="support-option">
                <h4>PayPal</h4>
                <p>Send a contribution through PayPal, on PayPal's own page.</p>
                <a className="button button-primary" href={paypal} target="_blank" rel="noopener noreferrer">
                  Support with PayPal<span className="visually-hidden"> (opens PayPal in a new tab)</span>
                </a>
              </li>
            )}
          </ul>
        )}

        <p className="muted small">
          Payments are made entirely on Stripe's or PayPal's site, under their terms and privacy policies. Hexstory
          never sees or stores your card or PayPal details, and contributing changes nothing about your Hexstory
          account.
        </p>
      </div>
    </Modal>
  );
}
