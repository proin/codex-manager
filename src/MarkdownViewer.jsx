import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, FileImage, FileText, Loader2, RefreshCw } from 'lucide-react';
import 'github-markdown-css/github-markdown-light.css';
import { ActionButton } from './ActionButton';
import './markdown-viewer.css';

const filename = path => path.split('/').filter(Boolean).at(-1) || '문서';
const controlCharacters = /[\u0000-\u001f\u007f]/;
const markdownPath = /\.(?:md|markdown)$/i;

function resolveLink(value, currentPath) {
  if (typeof value !== 'string') return null;
  const link = value.trim();
  if (!link || controlCharacters.test(link) || link.includes('\\') || link.startsWith('//')) return null;
  if (link.startsWith('#')) {
    try { return { type: 'fragment', fragment: decodeURIComponent(link.slice(1)) }; }
    catch { return null; }
  }
  if (/^https?:/i.test(link)) {
    try {
      const url = new URL(link);
      if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
      return { type: 'external', url: url.href };
    } catch { return null; }
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(link) || link.includes('?')) return null;
  let path, fragment = '';
  const separator = link.indexOf('#');
  try {
    path = decodeURIComponent(separator < 0 ? link : link.slice(0, separator));
    if (separator >= 0) fragment = decodeURIComponent(link.slice(separator + 1));
  }
  catch { return null; }
  if (!path || controlCharacters.test(path) || path.includes('\\') || path.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(path) || !markdownPath.test(path)) return null;
  const base = path.startsWith('/') ? [] : currentPath.split('/').slice(0, -1).filter(Boolean);
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') base.pop();
    else base.push(part);
  }
  return { type: 'file', path: `/${base.join('/')}`, fragment };
}

const headingText = node => typeof node.value === 'string' ? node.value : (node.children || []).map(headingText).join('');
const headingSlug = value => value.toLocaleLowerCase().replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');
function documentHeadings(prefix) {
  return () => tree => {
    const used = new Map();
    const walk = node => {
      if (node.type === 'heading') {
        const base = headingSlug(headingText(node)), count = used.get(base) || 0;
        let slug = count ? `${base}-${count}` : base;
        while (used.has(slug)) {
          const next = (used.get(base) || count) + 1;
          used.set(base, next); slug = `${base}-${next}`;
        }
        used.set(base, count + 1); if (slug !== base) used.set(slug, 1);
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id: `${prefix}-${slug}` } };
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}

export function MarkdownViewer({ host, path, fragment = '', bridge, onClose, onOpenFile, onDocumentLoaded }) {
  const target = `${host.id}\0${path}`;
  const [document, setDocument] = useState({ target, status: 'loading', file: null, error: '' });
  const [linkError, setLinkError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const request = useRef(0), article = useRef(null), title = useRef(null), loaded = useRef(onDocumentLoaded);
  loaded.current = onDocumentLoaded;
  const headingPrefix = `markdown-${useId().replace(/[^a-z\d_-]/gi, '')}`;
  const headings = useMemo(() => documentHeadings(headingPrefix), [headingPrefix]);
  const active = document.target === target ? document : { status: 'loading', file: null, error: '' };
  const name = active.file?.name || filename(path);
  const scrollToFragment = value => {
    const anchor = [...(article.current?.querySelectorAll('[id]') || [])].find(item => item.id === `${headingPrefix}-${value}` || item.id === value);
    if (anchor) { anchor.scrollIntoView({ block: 'start' }); anchor.focus({ preventScroll: true }); }
  };

  useEffect(() => {
    const token = ++request.current;
    let alive = true;
    setLinkError(''); setDocument({ target, status: 'loading', file: null, error: '' });
    title.current?.focus({ preventScroll: true });
    const load = async () => {
      try {
        if (!bridge?.readTextFile) throw new Error('문서 미리보기는 최신 데스크톱 앱에서 사용할 수 있습니다.');
        const result = await bridge.readTextFile(host.id, path);
        if (!alive || token !== request.current) return;
        if (typeof result?.content !== 'string' || (result.hostId && result.hostId !== host.id)) throw new Error('문서를 불러오지 못했습니다.');
        setDocument({ target, status: 'ready', file: result, error: '' });
      } catch (failure) {
        if (alive && token === request.current) setDocument({ target, status: 'error', file: null, error: failure?.message || '문서를 불러오지 못했습니다.' });
      }
    };
    load();
    return () => { alive = false; request.current++; };
  }, [bridge, host.id, path, target, attempt]);

  useEffect(() => {
    if (active.status === 'ready' && active.file) loaded.current?.(active.file);
  }, [active.status, active.file, target]);
  useEffect(() => {
    if (active.status === 'ready' && fragment) scrollToFragment(fragment);
  }, [active.status, active.file, fragment, headingPrefix]);

  const openLink = async (event, link) => {
    event.preventDefault();
    setLinkError('');
    if (link.type === 'fragment') {
      scrollToFragment(link.fragment);
      return;
    }
    if (link.type === 'file') {
      onOpenFile?.(link.path, link.fragment);
      if (link.path === (active.file?.path || path) && link.fragment) scrollToFragment(link.fragment);
      return;
    }
    const token = request.current;
    try { await bridge.openFileLink(link.url); }
    catch (failure) { if (token === request.current) setLinkError(failure?.message || '링크를 열지 못했습니다.'); }
  };

  const components = {
    a: ({ href, children, title: linkTitle }) => {
      const link = resolveLink(href, active.file?.path || path);
      if (!link || (link.type === 'file' && !onOpenFile) || (link.type === 'external' && !bridge?.openFileLink)) return <span className="markdown-unavailable-link" aria-disabled="true" title="이 링크는 미리보기에서 열 수 없습니다.">{children}</span>;
      const safeHref = link.type === 'external' ? link.url : link.type === 'fragment' ? `#${encodeURIComponent(link.fragment)}` : '#';
      return <a href={safeHref} title={linkTitle} onClick={event => openLink(event, link)}>{children}</a>;
    },
    img: ({ alt }) => <span className="markdown-image-placeholder" role="img" aria-label={alt || '이미지'}><FileImage size={15} aria-hidden="true"/><span>{alt || '이미지'}</span><small>이미지를 표시할 수 없습니다.</small></span>,
    ...Object.fromEntries([1, 2, 3, 4, 5, 6].map(level => [`h${level}`, ({ children, id }) => React.createElement(`h${level}`, { id, tabIndex: -1 }, children)])),
  };

  return <section className="markdown-viewer" aria-label={`${name} 미리보기`}>
    <header className="markdown-viewer-header">
      <ActionButton label="파일 목록" tooltip="파일 목록으로 돌아가기" icon={ArrowLeft} onClick={onClose}/>
      <div className="markdown-viewer-title"><FileText size={17} aria-hidden="true"/><h2 ref={title} tabIndex={-1}>{name}</h2><span>읽기 전용</span></div>
    </header>
    {active.status === 'loading' && <div className="markdown-viewer-message" role="status"><Loader2 size={18} className="spin" aria-hidden="true"/><p>문서를 불러오는 중입니다.</p></div>}
    {active.status === 'error' && <div className="markdown-viewer-message markdown-viewer-error"><p role="alert">{active.error}</p><ActionButton label="다시 시도" icon={RefreshCw} onClick={() => setAttempt(value => value + 1)}/></div>}
    {linkError && <p className="markdown-viewer-link-error" role="alert">{linkError}</p>}
    {active.status === 'ready' && <div className="markdown-viewer-scroll"><article ref={article} className="markdown-body" aria-label="마크다운 문서"><ReactMarkdown remarkPlugins={[remarkGfm, headings]} components={components} skipHtml urlTransform={(url, key) => key === 'href' && resolveLink(url, active.file?.path || path) ? url : ''}>{active.file.content}</ReactMarkdown></article></div>}
  </section>;
}
