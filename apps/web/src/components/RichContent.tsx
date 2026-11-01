import type { Inline, RichDoc } from '@hexstory/shared';
import { isHttpUrl } from '@hexstory/shared';

/** Renders a story document as React elements. Text is never interpreted as HTML. */
export function RichContent({ doc }: { doc: RichDoc }) {
  return (
    <div className="story-body">
      {doc.map((block, i) => {
        switch (block.type) {
          case 'paragraph':
            return <p key={i}><Inlines content={block.content} /></p>;
          case 'heading':
            return <h3 key={i} className="story-heading"><Inlines content={block.content} /></h3>;
          case 'quote':
            return <blockquote key={i}><Inlines content={block.content} /></blockquote>;
          case 'list': {
            const List = block.ordered ? 'ol' : 'ul';
            return (
              <List key={i}>
                {block.items.map((item, j) => <li key={j}><Inlines content={item} /></li>)}
              </List>
            );
          }
          case 'image':
            return block.url ? (
              <figure key={i} className="story-figure">
                <img src={block.url} alt={block.caption ?? ''} loading="lazy" />
                {block.caption && <figcaption>{block.caption}</figcaption>}
              </figure>
            ) : null;
        }
      })}
    </div>
  );
}

function Inlines({ content }: { content: Inline[] }) {
  return (
    <>
      {content.map((node, i) => {
        if (node.type === 'break') return <br key={i} />;
        let el: React.ReactNode = node.text;
        if (node.italic) el = <em>{el}</em>;
        if (node.bold) el = <strong>{el}</strong>;
        if (node.href && isHttpUrl(node.href)) {
          el = <a href={node.href} target="_blank" rel="nofollow ugc noopener noreferrer">{el}</a>;
        }
        return <span key={i}>{el}</span>;
      })}
    </>
  );
}
