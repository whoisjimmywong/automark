import { useEffect, useRef } from 'react';

/** HTML 子集净化（与 vision/app/richtext.py 白名单一致） */
export function sanitizeHtml(dirty: string): string {
  const doc = new DOMParser().parseFromString(dirty, 'text/html');
  return Array.from(doc.body.childNodes).map(serialize).join('');
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function serialize(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeText(node.textContent ?? '');
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  const inner = Array.from(el.childNodes).map(serialize).join('');
  switch (tag) {
    case 'b':
    case 'strong':
      return inner ? `<b>${inner}</b>` : '';
    case 'i':
    case 'em':
      return inner ? `<i>${inner}</i>` : '';
    case 'u':
      return inner ? `<u>${inner}</u>` : '';
    case 'br':
      return '<br/>';
    case 'ul':
      return `<ul>${inner}</ul>`;
    case 'ol':
      return `<ol>${inner}</ol>`;
    case 'li':
      return inner ? `<li>${inner}</li>` : '';
    case 'p':
    case 'div':
      return inner ? `${inner}<br/>` : '';
    case 'img': {
      const img = el as HTMLImageElement;
      const src = img.getAttribute('src') ?? '';
      if (!src.startsWith('data:image/')) return '';
      const w = img.getAttribute('width');
      return `<img src="${src}"${w ? ` width="${w}"` : ''}/>`;
    }
    default:
      // 其余标签剥壳保留内容
      return inner;
  }
}

/** 读取图片文件并压缩为 data URI（最长边 1200px，随 AMF 打包） */
export async function fileToDataUri(file: File, maxDim = 1200): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  // 保留 PNG 透明背景；其余用 jpeg 压缩
  return file.type === 'image/png'
    ? canvas.toDataURL('image/png')
    : canvas.toDataURL('image/jpeg', 0.85);
}

export default function RichTextEditor({
  value,
  onChange,
  placeholder,
  minHeight = 64,
}: {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  minHeight?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const imgInput = useRef<HTMLInputElement>(null);
  const inner = useRef<string | null>(null);

  // 仅当外部值与编辑器内容不同步时回写（避免光标跳动）
  useEffect(() => {
    if (ref.current && value !== inner.current) {
      ref.current.innerHTML = value || '';
      inner.current = value;
    }
  }, [value]);

  function emit() {
    const html = sanitizeHtml(ref.current?.innerHTML ?? '');
    inner.current = html;
    onChange(html);
  }

  function exec(cmd: string, arg?: string) {
    ref.current?.focus();
    document.execCommand(cmd, false, arg);
    emit();
  }

  async function insertImage(file: File) {
    const dataUri = await fileToDataUri(file);
    ref.current?.focus();
    document.execCommand('insertImage', false, dataUri);
    emit();
  }

  return (
    <div className="rte-wrap">
      <div className="rte-toolbar">
        <button type="button" title="加粗" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('bold')}>
          <b>B</b>
        </button>
        <button type="button" title="斜体" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('italic')}>
          <i>I</i>
        </button>
        <button type="button" title="下划线" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('underline')}>
          <u>U</u>
        </button>
        <button type="button" title="无序列表" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('insertUnorderedList')}>
          •≡
        </button>
        <button type="button" title="有序列表" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('insertOrderedList')}>
          1.≡
        </button>
        <button type="button" title="插入图片" onMouseDown={(e) => e.preventDefault()} onClick={() => imgInput.current?.click()}>
          🖼 图片
        </button>
        <input
          ref={imgInput}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void insertImage(f);
            e.target.value = '';
          }}
        />
      </div>
      <div
        ref={ref}
        className="rte"
        style={{ minHeight }}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder ?? ''}
        onInput={emit}
        onBlur={emit}
      />
    </div>
  );
}
