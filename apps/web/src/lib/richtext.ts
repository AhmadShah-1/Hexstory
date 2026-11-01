import type { JSONContent } from '@tiptap/react';
import type { Block, Inline, RichDoc } from '@hexstory/shared';

/**
 * Converts between the editor's (TipTap) JSON and our stored RichDoc format.
 * Anything the editor holds that RichDoc doesn't support is dropped here, which is also
 * what keeps pasted content from other sites (e.g. external images) out of stories.
 */
function inlines(node: JSONContent): Inline[] {
  const out: Inline[] = [];
  for (const child of node.content ?? []) {
    if (child.type === 'hardBreak') out.push({ type: 'break' });
    else if (child.type === 'text' && child.text) {
      const text: Inline = { type: 'text', text: child.text };
      for (const mark of child.marks ?? []) {
        if (mark.type === 'bold') text.bold = true;
        if (mark.type === 'italic') text.italic = true;
        if (mark.type === 'link' && typeof mark.attrs?.href === 'string') text.href = mark.attrs.href;
      }
      out.push(text);
    }
  }
  return out;
}

const joinWithBreaks = (parts: Inline[][]) =>
  parts.filter((p) => p.length).flatMap((p, i): Inline[] => (i ? [{ type: 'break' }, ...p] : p));

/** Flattens a (possibly nested) list into items; nested items follow their parent. */
function listItems(list: JSONContent): Inline[][] {
  const items: Inline[][] = [];
  for (const item of list.content ?? []) {
    const own = (item.content ?? []).filter((c) => c.type === 'paragraph').map(inlines);
    if (own.some((p) => p.length)) items.push(joinWithBreaks(own));
    for (const nested of (item.content ?? []).filter((c) => c.type === 'bulletList' || c.type === 'orderedList')) {
      items.push(...listItems(nested));
    }
  }
  return items;
}

export function editorToDoc(json: JSONContent): RichDoc {
  const doc: Block[] = [];
  const walk = (nodes: JSONContent[]) => {
    for (const node of nodes) {
      switch (node.type) {
        case 'paragraph': {
          const content = inlines(node);
          if (content.length) doc.push({ type: 'paragraph', content });
          break;
        }
        case 'heading': {
          const content = inlines(node);
          if (content.length) doc.push({ type: 'heading', content });
          break;
        }
        case 'blockquote': {
          const content = joinWithBreaks((node.content ?? []).map(inlines));
          if (content.length) doc.push({ type: 'quote', content });
          break;
        }
        case 'bulletList':
        case 'orderedList': {
          const items = listItems(node);
          if (items.length) doc.push({ type: 'list', ordered: node.type === 'orderedList', items });
          break;
        }
        case 'image':
          if (typeof node.attrs?.key === 'string') {
            doc.push({ type: 'image', key: node.attrs.key, caption: (node.attrs.title as string | null)?.trim() || null });
          }
          break;
        default:
          if (node.content) walk(node.content);
      }
    }
  };
  walk(json.content ?? []);
  return doc;
}

function toEditorInlines(content: Inline[]): JSONContent[] {
  return content.map((i) => {
    if (i.type === 'break') return { type: 'hardBreak' };
    const marks = [
      ...(i.bold ? [{ type: 'bold' }] : []),
      ...(i.italic ? [{ type: 'italic' }] : []),
      ...(i.href ? [{ type: 'link', attrs: { href: i.href } }] : []),
    ];
    return { type: 'text', text: i.text, ...(marks.length ? { marks } : {}) };
  });
}

export function docToEditor(doc: RichDoc): JSONContent {
  const content = doc.map((b): JSONContent => {
    switch (b.type) {
      case 'paragraph':
        return { type: 'paragraph', content: toEditorInlines(b.content) };
      case 'heading':
        return { type: 'heading', attrs: { level: 3 }, content: toEditorInlines(b.content) };
      case 'quote':
        return { type: 'blockquote', content: [{ type: 'paragraph', content: toEditorInlines(b.content) }] };
      case 'list':
        return {
          type: b.ordered ? 'orderedList' : 'bulletList',
          content: b.items.map((item) => ({ type: 'listItem', content: [{ type: 'paragraph', content: toEditorInlines(item) }] })),
        };
      case 'image':
        return { type: 'image', attrs: { src: b.url ?? `/media/${b.key}.webp`, key: b.key, title: b.caption ?? '' } };
    }
  });
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}
