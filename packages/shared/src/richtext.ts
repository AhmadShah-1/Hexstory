import { z } from 'zod';
import { LIMITS } from './limits.js';

/**
 * Story bodies are stored as this small, flat document format: our own, not an editor's.
 * Being flat (no nesting) keeps validation and rendering simple, and anything the editor
 * produces outside this format is dropped on conversion. Text is always rendered as text
 * (never HTML); links must be http(s); images can only reference our own uploads by key.
 */
export interface RichText {
  type: 'text';
  text: string;
  bold?: boolean;
  italic?: boolean;
  href?: string;
}
export type Inline = RichText | { type: 'break' };

export type Block =
  | { type: 'paragraph'; content: Inline[] }
  | { type: 'heading'; content: Inline[] }
  | { type: 'quote'; content: Inline[] }
  | { type: 'list'; ordered: boolean; items: Inline[][] }
  /** `url` is added by the server when sending; it is ignored on input. */
  | { type: 'image'; key: string; caption: string | null; url?: string };

export type RichDoc = Block[];

const isHttp = (v: string) => {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

const inlineSchema: z.ZodType<Inline> = z.union([
  z.object({
    type: z.literal('text'),
    text: z.string().min(1).max(LIMITS.bodyMax),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    href: z.string().max(LIMITS.sourceUrlMax).refine(isHttp, 'Links must start with http:// or https://').optional(),
  }),
  z.object({ type: z.literal('break') }),
]);
const inlines = z.array(inlineSchema).max(2_000);

export const richDocSchema = z
  .array(
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('paragraph'), content: inlines }),
      z.object({ type: z.literal('heading'), content: inlines }),
      z.object({ type: z.literal('quote'), content: inlines }),
      z.object({ type: z.literal('list'), ordered: z.boolean(), items: z.array(inlines).min(1).max(200) }),
      z.object({
        type: z.literal('image'),
        key: z.string().regex(/^[a-f0-9-]{36}$/),
        caption: z.string().trim().max(LIMITS.imageCreditMax).nullable(),
      }),
    ]),
  )
  .max(LIMITS.blocksMax)
  .refine((doc) => docImageKeys(doc).length <= LIMITS.imagesMax, `At most ${LIMITS.imagesMax} images per story`)
  .refine((doc) => docText(doc).length >= LIMITS.bodyMin, `Tell the story in at least ${LIMITS.bodyMin} characters`)
  .refine((doc) => docText(doc).length <= LIMITS.bodyMax, `Keep the story under ${LIMITS.bodyMax.toLocaleString('en')} characters`);

const inlineText = (content: Inline[]) => content.map((i) => (i.type === 'text' ? i.text : '\n')).join('');

/** Plain text of the story's words only (no image captions); used for length limits. */
export function docText(doc: RichDoc): string {
  return doc
    .map((b) => (b.type === 'list' ? b.items.map(inlineText).join('\n') : b.type === 'image' ? '' : inlineText(b.content)))
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

/** Readable plain-text version (images as placeholders); stored as `body` for diffs and abuse checks. */
export function docToPlainText(doc: RichDoc): string {
  return doc
    .map((b) => {
      switch (b.type) {
        case 'list':
          return b.items.map((item, i) => `${b.ordered ? `${i + 1}.` : '•'} ${inlineText(item)}`).join('\n');
        case 'image':
          return `[Image${b.caption ? `: ${b.caption}` : ''}]`;
        case 'quote':
          return `“${inlineText(b.content)}”`;
        default:
          return inlineText(b.content);
      }
    })
    .join('\n\n')
    .trim();
}

export function docImageKeys(doc: RichDoc): string[] {
  return doc.flatMap((b) => (b.type === 'image' ? [b.key] : []));
}

export function docLinkCount(doc: RichDoc): number {
  const all = doc.flatMap((b) => (b.type === 'list' ? b.items.flat() : b.type === 'image' ? [] : b.content));
  return new Set(all.flatMap((i) => (i.type === 'text' && i.href ? [i.href] : []))).size;
}

/** Stories written before rich text existed: plain paragraphs plus an optional cover image. */
export function legacyDoc(body: string, imageKey: string | null, imageCaption: string | null): RichDoc {
  const doc: RichDoc = imageKey ? [{ type: 'image', key: imageKey, caption: imageCaption }] : [];
  for (const para of body.split(/\n\s*\n/)) {
    const lines = para.split('\n').filter((l) => l.length);
    if (!lines.length) continue;
    doc.push({
      type: 'paragraph',
      content: lines.flatMap((text, i): Inline[] => (i ? [{ type: 'break' }, { type: 'text', text }] : [{ type: 'text', text }])),
    });
  }
  return doc;
}
