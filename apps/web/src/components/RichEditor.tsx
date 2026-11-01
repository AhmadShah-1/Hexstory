import { useRef, useState } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { Placeholder } from '@tiptap/extensions';
import { LIMITS, isHttpUrl, type RichDoc } from '@hexstory/shared';
import { errorMessage } from '../api/client';
import { uploadImage } from '../api/queries';
import { docToEditor, editorToDoc } from '../lib/richtext';

/** Images carry our upload key alongside their display URL; only the key is stored. */
const StoryImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      key: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-key'),
        renderHTML: (attrs) => (attrs.key ? { 'data-key': attrs.key } : {}),
      },
    };
  },
}).configure({ inline: false, allowBase64: false });

type Panel = 'none' | 'link';

/**
 * Document-style editor for a story: write top to bottom, add links and photos inline.
 * Deliberately small: the toolbar only offers what the stored format supports.
 */
export function RichEditor({ initial, onChange }: { initial: RichDoc; onChange: (doc: RichDoc) => void }) {
  const [panel, setPanel] = useState<Panel>('none');
  const [linkUrl, setLinkUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [3] },
        code: false,
        codeBlock: false,
        horizontalRule: false,
        strike: false,
        underline: false,
        link: {
          openOnClick: false,
          autolink: true,
          protocols: ['http', 'https'],
          defaultProtocol: 'https',
          isAllowedUri: (url) => isHttpUrl(url),
          HTMLAttributes: { rel: 'nofollow ugc noopener noreferrer', target: '_blank' },
        },
      }),
      StoryImage,
      Placeholder.configure({ placeholder: 'Tell the story. What happened, who was there, how do you know?' }),
    ],
    content: docToEditor(initial),
    onUpdate: ({ editor }) => onChange(editorToDoc(editor.getJSON())),
  });

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e?.isActive('bold') ?? false,
      italic: e?.isActive('italic') ?? false,
      heading: e?.isActive('heading') ?? false,
      quote: e?.isActive('blockquote') ?? false,
      bullet: e?.isActive('bulletList') ?? false,
      ordered: e?.isActive('orderedList') ?? false,
      link: e?.isActive('link') ?? false,
      image: e?.isActive('image') ?? false,
      caption: (e?.getAttributes('image').title as string | undefined) ?? '',
    }),
  });

  if (!editor || !state) return null;

  const openLink = () => {
    setLinkUrl((editor.getAttributes('link').href as string | undefined) ?? '');
    setPanel(panel === 'link' ? 'none' : 'link');
  };

  const applyLink = () => {
    const raw = linkUrl.trim();
    const url = raw && !/^https?:\/\//i.test(raw) ? `https://${raw}` : raw;
    if (!url) return editor.chain().focus().extendMarkRange('link').unsetLink().run();
    if (!isHttpUrl(url)) return setError('That doesn’t look like a web address.');
    setError(null);
    if (editor.state.selection.empty && !state.link) {
      // Nothing selected: insert the address itself as linked text.
      editor.chain().focus().insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] }).run();
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    }
    // Continue typing after the link rather than with the linked words still selected.
    editor.commands.setTextSelection(editor.state.selection.to);
    editor.commands.unsetMark('link');
    setPanel('none');
    setTimeout(() => editor.commands.focus(), 0); // the link field unmounts and would otherwise keep focus
  };

  const addImage = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (editorToDoc(editor.getJSON()).filter((b) => b.type === 'image').length >= LIMITS.imagesMax) {
      return setError(`A story can have up to ${LIMITS.imagesMax} images.`);
    }
    if (file.size > LIMITS.imageBytesMax) return setError('Images must be smaller than 6 MB.');
    setUploading(true);
    try {
      const { imageKey, imageUrl } = await uploadImage(file);
      // Insert after the current selection, never over it (a selection would otherwise be replaced).
      const at = editor.state.selection.to;
      editor
        .chain()
        .focus()
        .setTextSelection(at)
        .insertContent({ type: 'image', attrs: { src: imageUrl, key: imageKey, title: '' } })
        .run();
      // Select the new image so its caption field appears straight away.
      const pos = findImage(editor, imageKey, at);
      if (pos !== null) editor.commands.setNodeSelection(pos);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  return (
    <div className="rich-editor">
      <div className="rich-toolbar" role="toolbar" aria-label="Formatting">
        <ToolButton label="Bold" active={state.bold} onClick={() => editor.chain().focus().toggleBold().run()}>
          <b>B</b>
        </ToolButton>
        <ToolButton label="Italic" active={state.italic} onClick={() => editor.chain().focus().toggleItalic().run()}>
          <i>I</i>
        </ToolButton>
        <span className="tool-sep" />
        <ToolButton label="Heading" active={state.heading} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
          H
        </ToolButton>
        <ToolButton label="Quote" active={state.quote} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
          <Icon d="M7 7h4v4c0 2.5-1.5 4-4 4.5M14 7h4v4c0 2.5-1.5 4-4 4.5" />
        </ToolButton>
        <ToolButton label="Bulleted list" active={state.bullet} onClick={() => editor.chain().focus().toggleBulletList().run()}>
          <Icon d="M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01" />
        </ToolButton>
        <ToolButton label="Numbered list" active={state.ordered} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
          <Icon d="M10 7h10M10 12h10M10 17h10M4 6h1.5v4M4 10h3M4 14.5c.5-.7 3-1 3 .5s-3 2-3 3h3" />
        </ToolButton>
        <span className="tool-sep" />
        <ToolButton label="Add link" active={state.link || panel === 'link'} onClick={openLink} wide>
          <Icon d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
          Link
        </ToolButton>
        <ToolButton label="Add photo" active={false} onClick={() => fileInput.current?.click()} wide disabled={uploading}>
          <Icon d="M4 6h16v12H4zM4 15l4.5-4.5L13 15M13 13l2.5-2.5L20 15M15.5 8.5h.01" />
          {uploading ? 'Uploading…' : 'Photo'}
        </ToolButton>
        <input
          ref={fileInput}
          type="file"
          hidden
          accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
          onChange={(e) => addImage(e.target.files?.[0])}
        />
      </div>

      {panel === 'link' && (
        <div className="rich-subbar">
          <input
            autoFocus
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                applyLink();
              }
              if (e.key === 'Escape') setPanel('none');
            }}
            placeholder="Paste a link, e.g. https://example.org/article"
            aria-label="Link address"
          />
          <button type="button" className="button button-primary" onClick={applyLink}>Apply</button>
          {state.link && (
            <button type="button" className="button" onClick={() => { editor.chain().focus().extendMarkRange('link').unsetLink().run(); setPanel('none'); }}>
              Remove
            </button>
          )}
        </div>
      )}

      {state.image && (
        <div className="rich-subbar">
          <input
            value={state.caption}
            maxLength={LIMITS.imageCreditMax}
            onChange={(e) => editor.chain().updateAttributes('image', { title: e.target.value }).run()}
            placeholder="Caption and credit, e.g. “Crowds at noon. Photo: own work”"
            aria-label="Image caption"
          />
          <button type="button" className="button" onClick={() => editor.chain().focus().deleteSelection().run()}>
            Remove photo
          </button>
        </div>
      )}

      {error && <p className="error-text rich-error">{error}</p>}
      <EditorContent editor={editor} className="rich-surface" />
    </div>
  );
}

function findImage(editor: Editor, key: string, near: number): number | null {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found === null && node.type.name === 'image' && node.attrs.key === key && pos >= near - 2) found = pos;
    return found === null;
  });
  return found;
}

function ToolButton({ label, active, onClick, children, wide = false, disabled = false }: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  wide?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`tool ${wide ? 'tool-wide' : ''}`}
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} // keep the editor's selection
      onClick={onClick}
    >
      {children}
    </button>
  );
}

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path d={d} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
