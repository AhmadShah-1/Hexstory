import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link, useNavigate } from 'react-router';
import { Modal } from '../components/Modal';
import terms from '../../../../legal/terms-of-service.md?raw';
import privacy from '../../../../legal/privacy-policy.md?raw';
import about from '../content/about.md?raw';

const PAGES = { about, terms, privacy } as const;
export type PageName = keyof typeof PAGES;

/** Long-form pages (About, Terms, Privacy) shown over the map. Markdown is rendered without raw HTML. */
export function PageView({ page }: { page: PageName }) {
  const navigate = useNavigate();
  const [, title, body] = PAGES[page].match(/^# (.+)\n([\s\S]*)$/) ?? [null, page, PAGES[page]];
  return (
    <Modal open onClose={() => navigate('/')} title={title ?? ''}>
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
