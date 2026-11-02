import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link, useNavigate } from 'react-router';
import { LIMITS, REPUTATION } from '@hexstory/shared';
import { useRules } from '../api/queries';
import { closePage } from '../lib/navigation';
import { Modal } from '../components/Modal';
import terms from '../../../../legal/terms-of-service.md?raw';
import privacy from '../../../../legal/privacy-policy.md?raw';
import about from '../content/about.md?raw';

const PAGES = { about, terms, privacy } as const;
export type PageName = keyof typeof PAGES;

/**
 * Fills `{{storiesPerDay.1}}`-style tokens from the rules in force (`/api/rules`, which includes any
 * Moderator changes), `{{limits.bodyMax}}`-style ones from LIMITS and `{{reputation.publishedStory}}`-style
 * ones from REPUTATION (negative weights also as `{{reputation.less.removed}}`, without the minus sign), so the numbers on the page are
 * the ones the API enforces. Unknown tokens are left as they are, so a typo is visible rather than
 * silently blank.
 */
function fillRules(text: string, source: object): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (token, path: string) => {
    let value: unknown = source;
    for (const key of path.split('.')) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
    return typeof value === 'number' || typeof value === 'string' ? String(value) : token;
  });
}

/** Long-form pages (About, Terms, Privacy) shown over the map. Markdown is rendered without raw HTML. */
export function PageView({ page }: { page: PageName }) {
  const navigate = useNavigate();
  const rules = useRules().data;
  const reputation = { ...REPUTATION, less: Object.fromEntries(Object.entries(REPUTATION).map(([k, v]) => [k, Math.abs(v)])) };
  const text = fillRules(PAGES[page], {
    ...rules,
    limits: { ...LIMITS, contentKilobytesMax: LIMITS.contentBytesMax / 1024, imageMegabytesMax: LIMITS.imageBytesMax / 1024 / 1024 },
    reputation,
  });
  const [, title, body] = text.match(/^# (.+)\n([\s\S]*)$/) ?? [null, page, text];
  return (
    <Modal open onClose={() => closePage(navigate)} title={title ?? ''}>
      <div className="prose">
        <Markdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href = '', children }) =>
              href.startsWith('/') ? (
                <Link to={href}>{children}</Link>
              ) : (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              ),
          }}
        >
          {body ?? ''}
        </Markdown>
      </div>
    </Modal>
  );
}
