import React, { useEffect, useId, useRef, useState } from 'react';
import { ArrowUp, Check, ChevronLeft, ChevronRight, Download, Eye, File, FileText, Folder, FolderInput, FolderOpen, FolderPlus, Home, Link, List, MoreHorizontal, Pencil, RefreshCw, Search, Trash2, Upload, X } from 'lucide-react';
import { MarkdownViewer } from './MarkdownViewer';
import { ActionButton } from './ActionButton';
import { FileNavigator } from './FileNavigator';
import './host-files.css';

const parentPath = path => path === '/' ? '/' : path.slice(0, path.lastIndexOf('/')) || '/';
const joinPath = (path, name) => `${path === '/' ? '' : path}/${name}`;
const statusLabels = { running: '전송 중', completed: '완료', error: '실패', canceled: '취소' };
const sizeLabel = value => {
  if (value == null || value === '') return '—';
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const unit = bytes >= 1024 ** 3 ? 'GiB' : bytes >= 1024 ** 2 ? 'MiB' : bytes >= 1024 ? 'KiB' : 'B';
  const divisor = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[unit];
  return `${Math.ceil(bytes / divisor).toLocaleString('ko-KR')} ${unit}`;
};
const dateLabel = value => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
};

function FileSelection({ checked, mixed, disabled, onChange }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed; }, [mixed]);
  return <input ref={ref} type="checkbox" aria-label="표시된 파일 전체 선택" aria-checked={mixed ? 'mixed' : checked} checked={checked} disabled={disabled} onChange={onChange}/>;
}

function FileMenu({ label, icon, items, disabled = false, className = '' }) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef(null), menu = useRef(null);
  const id = useId();
  const restore = () => { setOpen(false); wrapper.current?.querySelector('button')?.focus(); };
  useEffect(() => {
    if (!open) return;
    const outside = event => { if (!wrapper.current?.contains(event.target)) setOpen(false); };
    const escape = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); restore(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape, true);
    menu.current?.querySelector('[role^="menuitem"]:not(:disabled)')?.focus();
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); document.removeEventListener('keydown', escape, true); };
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const move = event => {
    if (event.key === 'Tab') { setOpen(false); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...menu.current.querySelectorAll('[role^="menuitem"]:not(:disabled)')], index = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowUp' ? (index + buttons.length - 1) % buttons.length : (index + 1) % buttons.length;
    buttons[next]?.focus();
  };
  return <div ref={wrapper} className={`host-files-menu ${className}`}>
    <ActionButton label={label} icon={icon} disabled={disabled} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(previous => !previous)} onKeyDown={event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(true); } }}/>
    {open && <div ref={menu} id={id} className="host-files-menu-popup" role="menu" aria-label={label} onKeyDown={move}>{items.map(item => <button type="button" role={typeof item.checked === 'boolean' ? 'menuitemcheckbox' : 'menuitem'} tabIndex={-1} aria-checked={typeof item.checked === 'boolean' ? item.checked : undefined} disabled={item.disabled} key={item.label} onClick={() => { restore(); item.onClick(); }}>
      {typeof item.checked === 'boolean' ? <span className="host-files-menu-check">{item.checked && <Check size={14} aria-hidden="true"/>}</span> : item.icon && <item.icon size={14} aria-hidden="true"/>}<span>{item.label}</span>
    </button>)}</div>}
  </div>;
}

const isMarkdown = entry => entry?.type === 'file' && /\.(md|markdown)$/i.test(entry.name);
const folderLabel = path => path === '/' ? '전체 폴더' : path.split('/').filter(Boolean).at(-1) || '홈 폴더';
function Breadcrumbs({ path, onNavigate, disabled = false, label = '현재 폴더' }) {
  const names = path.split('/').filter(Boolean);
  return <nav className="host-files-breadcrumbs" aria-label={label}>
    <button type="button" aria-label="전체 폴더 열기" disabled={disabled} onClick={() => onNavigate('/')}><Folder size={14}/><span>전체 폴더</span></button>
    {names.map((name, index) => <React.Fragment key={index}><ChevronRight size={13}/><button type="button" disabled={disabled} aria-current={index === names.length - 1 ? 'location' : undefined} onClick={() => onNavigate(`/${names.slice(0, index + 1).join('/')}`)}>{name}</button></React.Fragment>)}
  </nav>;
}
function MoveFolderPicker({ host, bridge, path, onChange, disabled, excludedPaths, onReady }) {
  const [folders, setFolders] = useState([]), [loading, setLoading] = useState(false), [error, setError] = useState(''), [editing, setEditing] = useState(false), [input, setInput] = useState(path), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true; setLoading(true); setError(''); setInput(path); onReady('');
    bridge.listFiles(host.id, path).then(result => { if (live) { if (typeof result?.path !== 'string' || !Array.isArray(result.entries)) throw new Error('폴더를 불러오지 못했습니다.'); if (excludedPaths.some(source => result.path === source || result.path.startsWith(`${source}/`))) throw new Error('선택한 항목 안으로 이동할 수 없습니다.'); setFolders(result.entries.filter(item => item.type === 'directory' && !excludedPaths.some(source => item.path === source || item.path.startsWith(`${source}/`)))); if (result.path !== path) onChange(result.path); else onReady(path); } }).catch(failure => { if (live) { setFolders([]); setError(failure.message || '폴더를 불러오지 못했습니다.'); } }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [host.id, bridge, path, excludedPaths, attempt, onReady]);
  return <div className="host-files-folder-picker" aria-label="이동할 폴더 선택">
    <div className="host-files-picker-location"><ActionButton label="이동 위치 상위 폴더" icon={ArrowUp} disabled={disabled || path === '/'} onClick={() => onChange(parentPath(path))}/><Breadcrumbs path={path} onNavigate={onChange} disabled={disabled} label="이동 위치"/></div>
    {error && <div className="host-files-error" role="alert"><span>{error}</span><ActionButton label="다시 시도" icon={RefreshCw} disabled={disabled} onClick={() => setAttempt(value => value + 1)}/></div>}
    <div className="host-files-picker-folders">{loading ? <p role="status">폴더를 불러오는 중입니다.</p> : folders.length ? folders.map(folder => <button type="button" key={folder.path} disabled={disabled} aria-label={`${folder.name} 이동 폴더 열기`} onClick={() => onChange(folder.path)}><Folder size={16}/><span>{folder.name}</span><ChevronRight size={13}/></button>) : <p>하위 폴더가 없습니다.</p>}</div>
    <div className="host-files-picker-target"><span>선택한 폴더 <strong>{folderLabel(path)}</strong></span><ActionButton label="경로 입력" icon={Pencil} disabled={disabled} aria-expanded={editing} onClick={() => setEditing(!editing)}/></div>
    {editing && <label>이동할 폴더 경로<div className="host-files-picker-path"><input aria-label="이동할 폴더 경로" value={input} onChange={event => setInput(event.target.value)} disabled={disabled} autoComplete="off"/><ActionButton label="폴더 열기" icon={FolderOpen} disabled={disabled || !input.startsWith('/')} onClick={() => onChange(input)}/></div></label>}
  </div>;
}

export function HostFiles({ host, bridge, onBack }) {
  const [listing, setListing] = useState({ path: '', home: '', entries: [] });
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState('');
  const [hidden, setHidden] = useState(false);
  const [selection, setSelection] = useState([]);
  const [history, setHistory] = useState([]);
  const [form, setForm] = useState(null);
  const [value, setValue] = useState('');
  const [transfers, setTransfers] = useState([]);
  const [transferLoading, setTransferLoading] = useState(Boolean(bridge?.getFileTransfers));
  const [canceling, setCanceling] = useState([]);
  const [dropPath, setDropPath] = useState('');
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [previewPath, setPreviewPath] = useState(null);
  const [previewFragment, setPreviewFragment] = useState('');
  const [previewDocument, setPreviewDocument] = useState(null);
  const [moveReadyPath, setMoveReadyPath] = useState('');
  const alive = useRef(true), request = useRef(0), mutation = useRef(false), currentPath = useRef(''), dragPaths = useRef([]), transferStates = useRef(new Map()), pendingUploadRefresh = useRef(false);
  const searchInput = useRef(null);
  const failedLoad = useRef(null);
  const load = async (path, { record = false, resetSelection = true } = {}) => {
    if (host.connectable === false || !bridge?.listFiles) return;
    const token = ++request.current, previous = currentPath.current;
    failedLoad.current = null; setLoading(true); setError('');
    try {
      const result = await bridge.listFiles(host.id, path);
      if (!alive.current || token !== request.current) return;
      if (typeof result?.path !== 'string' || !Array.isArray(result.entries)) throw new Error('파일 목록을 불러오지 못했습니다.');
      currentPath.current = result.path; setListing(result);
      if (resetSelection) setSelection([]);
      else setSelection(ids => ids.filter(id => result.entries.some(entry => entry.path === id)));
      if (record && previous && previous !== result.path) setHistory(items => [...items, previous].slice(-50));
      if (pendingUploadRefresh.current && !mutation.current) { pendingUploadRefresh.current = false; queueMicrotask(() => { if (alive.current) load(result.path, { resetSelection: false }); }); }
    } catch (failure) {
      if (alive.current && token === request.current) {
        failedLoad.current = { path, options: { record, resetSelection } };
        setError(failure.message || '파일 목록을 불러오지 못했습니다.');
      }
    }
    finally { if (alive.current && token === request.current) setLoading(false); }
  };
  const retryLoad = () => {
    const failed = failedLoad.current;
    return failed ? load(failed.path, failed.options) : load(currentPath.current || '');
  };
  useEffect(() => {
    alive.current = true;
    if (host.connectable === false) return;
    if (!bridge?.listFiles) { setError('파일 기능은 최신 데스크톱 앱에서 사용할 수 있습니다.'); return () => { alive.current = false; request.current++; }; }
    let events = 0;
    const update = (snapshot, fromEvent = false) => {
      if (!alive.current || !Array.isArray(snapshot)) return;
      const items = snapshot.filter(item => item.hostId === host.id);
      setTransfers(items); setTransferLoading(false);
      if (items.some(item => item.status === 'running' || (fromEvent && transferStates.current.get(item.id) !== item.status))) setInspectorOpen(true);
      let refresh = false;
      for (const item of items) {
        const previous = transferStates.current.get(item.id);
        if (item.direction === 'upload' && ['completed', 'error', 'canceled', 'cancelled'].includes(item.status) && previous !== item.status && (previous === 'running' || !previous)) refresh = true;
        transferStates.current.set(item.id, item.status);
      }
      if (refresh) {
        if (currentPath.current && !mutation.current) load(currentPath.current, { resetSelection: false });
        else pendingUploadRefresh.current = true;
      }
    };
    const unsubscribe = bridge?.onFileTransfers?.(snapshot => { events++; update(snapshot, true); });
    const start = events;
    bridge?.getFileTransfers?.().then(snapshot => { if (events === start) update(snapshot); }).catch(failure => { if (alive.current) { setTransferLoading(false); setError(failure.message || '전송 정보를 불러오지 못했습니다.'); } });
    load('');
    return () => { alive.current = false; request.current++; unsubscribe?.(); };
  }, [bridge, host.id]);
  useEffect(() => { if (searchOpen) searchInput.current?.focus(); }, [searchOpen]);
  const entries = listing.entries.filter(entry => (hidden || !entry.name.startsWith('.')) && entry.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())).sort((left, right) => Number(right.type === 'directory') - Number(left.type === 'directory') || left.name.localeCompare(right.name, 'ko', { numeric: true }));
  const selectedEntries = listing.entries.filter(entry => selection.includes(entry.path));
  const infoEntries = previewPath ? [{ ...(previewDocument || {}), path: previewPath, name: previewDocument?.name || previewPath.split('/').at(-1), type: 'file' }] : selectedEntries;
  const visibleSelected = entries.filter(entry => selection.includes(entry.path)).length;
  const transferRunning = transfers.some(item => item.status === 'running');
  const showInspector = inspectorOpen || transferRunning;
  const disabled = busy || loading || transferLoading || transferRunning || !listing.path || host.connectable === false || !bridge?.listFiles;
  const navigationDisabled = (busy && !transferRunning) || host.connectable === false || !bridge?.listFiles;
  const navigate = path => { if (busy && !transferRunning) return; setForm(null); setPreviewPath(null); setNotice(''); setFilter(''); load(path, { record: true }); };
  const back = () => { if (!history.length || (busy && !transferRunning)) return; const path = history.at(-1); setHistory(items => items.slice(0, -1)); setForm(null); setPreviewPath(null); setFilter(''); load(path); };
  const toggle = (path, checked) => setSelection(items => checked ? [...new Set([...items, path])] : items.filter(item => item !== path));
  const openForm = (type, paths = selection, target) => {
    const selected = listing.entries.filter(entry => paths.includes(entry.path));
    if (disabled || (type !== 'mkdir' && !selected.length)) return;
    failedLoad.current = null; setError(''); setNotice(''); setMoveReadyPath(''); setForm({ type, paths: selected.map(entry => entry.path), names: selected.map(entry => entry.name), base: listing.path });
    setValue(type === 'rename' ? selected[0].name : type === 'move' ? target || listing.path : '');
  };
  const perform = async (operation, message) => {
    if (mutation.current || transferLoading || transferRunning) return;
    const path = currentPath.current;
    failedLoad.current = null; mutation.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await operation();
      if (!alive.current) return;
      if (result?.canceled) return;
      setForm(null); if (message) { setNotice(message); setPreviewPath(null); setPreviewFragment(''); setPreviewDocument(null); }
      if (path === currentPath.current) await load(path, { resetSelection: false });
    } catch (failure) { if (alive.current) setError(failure.message || '파일 작업을 완료하지 못했습니다.'); }
    finally { mutation.current = false; if (alive.current) { setBusy(false); if (pendingUploadRefresh.current && currentPath.current) { pendingUploadRefresh.current = false; load(currentPath.current, { resetSelection: false }); } } }
  };
  const submit = event => {
    event.preventDefault();
    if (!form || mutation.current) return;
    if (['mkdir', 'rename'].includes(form.type) && (!value || ['.', '..'].includes(value) || value.includes('/') || value.includes('\0'))) { setError('이름을 입력하십시오. /를 포함하거나 . 또는 ..인 이름은 사용할 수 없습니다.'); return; }
    if (form.type === 'move' && (moveReadyPath !== value || value === form.base)) return;
    if (form.type === 'move' && !value.startsWith('/')) { setError('이동할 폴더의 전체 경로를 입력하십시오.'); return; }
    if (form.type === 'mkdir') perform(() => bridge.createDirectory(host.id, joinPath(form.base, value)), '폴더를 생성했습니다.');
    else if (form.type === 'rename') perform(() => bridge.renameFile(host.id, form.paths[0], joinPath(form.base, value)), '이름을 변경했습니다.');
    else if (form.type === 'move') perform(() => bridge.moveFiles(host.id, form.paths, value), '파일을 이동했습니다.');
    else if (form.type === 'delete') perform(() => bridge.deleteFiles(host.id, form.paths), '파일을 삭제했습니다.');
  };
  const upload = directory => perform(() => bridge.uploadFiles(host.id, listing.path, directory ? { directory: true } : undefined), '');
  const download = paths => perform(() => bridge.downloadFiles(host.id, paths), '');
  const cancel = async id => {
    if (canceling.includes(id)) return;
    setCanceling(items => [...items, id]);
    try { const result = await bridge.cancelFileTransfer(id); if (Array.isArray(result) && alive.current) setTransfers(result.filter(item => item.hostId === host.id)); }
    catch (failure) { if (alive.current) setError(failure.message || '전송을 취소하지 못했습니다.'); }
    finally { if (alive.current) setCanceling(items => items.filter(item => item !== id)); }
  };
  const beginDrag = (event, entry) => {
    if (disabled) { event.preventDefault(); return; }
    const paths = selection.includes(entry.path) ? selectedEntries.map(item => item.path) : [entry.path];
    dragPaths.current = paths; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-codex-host-files', JSON.stringify(paths));
  };
  const drop = (event, entry) => {
    event.preventDefault(); setDropPath('');
    const paths = dragPaths.current; dragPaths.current = [];
    if (entry.type !== 'directory' || disabled || !paths.length || paths.includes(entry.path)) return;
    openForm('move', paths, entry.path);
  };
  const openPreview = (path, fragment = '') => { if (path !== previewPath) setPreviewDocument(null); setPreviewPath(path); setPreviewFragment(fragment); };
  const closePreview = () => { const path = listing.entries.some(entry => entry.path === previewPath) ? previewPath : selection[0]; setPreviewPath(null); setPreviewFragment(''); setPreviewDocument(null); requestAnimationFrame(() => document.querySelector(`.host-files-name[data-file-path="${CSS.escape(path || '')}"]`)?.focus()); };
  const openEntry = entry => { if (disabled) return; if (['directory', 'symlink'].includes(entry.type)) navigate(entry.path); else if (isMarkdown(entry)) openPreview(entry.path); };
  const title = { mkdir: '새 폴더', rename: '이름 변경', move: '파일 이동', delete: '파일 삭제 확인' }[form?.type];
  return <section className={`host-files ${showInspector ? 'inspector-open' : ''}`} aria-label={`${host.alias} 파일 브라우저`} onKeyDown={event => {
    if (event.key !== 'Escape' || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
    if (form) { if (!busy) setForm(null); }
    else if (previewPath) closePreview();
    else { setSelection([]); if (!transferRunning) setInspectorOpen(false); }
  }}>
    <header className="host-files-header" role="toolbar" aria-label="파일 관리 도구">
      <div className="host-files-navigation">
        <ActionButton label="호스트 목록으로 돌아가기" tooltip="호스트 목록" icon={List} className="host-files-back" onClick={onBack}/>
        <ActionButton label="이전 폴더" icon={ChevronLeft} disabled={navigationDisabled || !history.length} onClick={back}/>
        <ActionButton label="상위 폴더" icon={ArrowUp} disabled={navigationDisabled || !listing.path || listing.path === '/'} onClick={() => navigate(parentPath(listing.path))}/>
        <ActionButton label="홈 폴더" icon={Home} disabled={navigationDisabled} onClick={() => navigate(listing.home || '')}/>
      </div>
      <FileNavigator hostLabel={host.alias} path={listing.path} home={listing.home} disabled={navigationDisabled} loading={loading} onNavigate={navigate}/>
      <div className="host-files-actions">
        <ActionButton label="파일 새로고침" tooltip="새로고침" icon={RefreshCw} busy={loading} disabled={navigationDisabled || loading} onClick={() => load(listing.path, { resetSelection: false })}/>
        <FileMenu label="업로드" icon={Upload} className="host-files-upload-menu" disabled={disabled || !bridge?.uploadFiles} items={[{ label: '파일 업로드', icon: File, onClick: () => upload(false) }, { label: '폴더 업로드', icon: Folder, onClick: () => upload(true) }]}/>
        <ActionButton label="새 폴더" icon={FolderPlus} disabled={disabled} onClick={() => openForm('mkdir')}/>
        <ActionButton label="다운로드" icon={Download} disabled={disabled || !selectedEntries.length || !bridge?.downloadFiles} onClick={() => download(selection)}/>
        <ActionButton label="이름 변경" icon={Pencil} disabled={disabled || selectedEntries.length !== 1} onClick={() => openForm('rename')}/>
        <ActionButton label="이동" icon={FolderInput} disabled={disabled || !selectedEntries.length} onClick={() => openForm('move')}/>
        <ActionButton label="삭제" icon={Trash2} className="host-files-delete" disabled={disabled || !selectedEntries.length} onClick={() => openForm('delete')}/>
      </div>
      <div className="host-files-header-end">
        <div className={`host-files-search-control ${searchOpen ? 'expanded' : ''}`}>
          <ActionButton label="파일 검색" icon={Search} aria-expanded={searchOpen} onClick={() => { setSearchOpen(true); searchInput.current?.focus(); }}/>
          {searchOpen && <><input ref={searchInput} type="search" aria-label="파일 이름 검색" value={filter} onChange={event => setFilter(event.target.value)} placeholder="파일 검색" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setFilter(''); setSearchOpen(false); } }}/><ActionButton label="검색 닫기" icon={X} onClick={() => { setFilter(''); setSearchOpen(false); }}/></>}
        </div>
        <FileMenu label="파일 옵션" icon={MoreHorizontal} className="host-files-options" items={[{ label: '숨김 파일 표시', checked: hidden, onClick: () => { setHidden(!hidden); if (hidden) setSelection(paths => paths.filter(path => !listing.entries.find(entry => entry.path === path)?.name.startsWith('.'))); } }, { label: '파일 정보 표시', checked: showInspector, disabled: transferRunning, onClick: () => setInspectorOpen(previous => !previous) }]}/>
      </div>
    </header>
    <div className="host-files-layout">
      <div className="host-files-content">
        {error && <div className="host-files-error" role="alert"><span>{error}</span>{!form && <ActionButton label="다시 시도" icon={RefreshCw} busy={loading} disabled={loading} onClick={retryLoad}/>}</div>}
        {notice && <p className="host-files-notice" role="status"><Check size={14}/>{notice}</p>}
        {form && <form className={`host-files-form ${form.type === 'delete' ? 'danger' : ''}`} aria-label={title} onSubmit={submit} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) setForm(null); } }}>
          <h3>{title}</h3>
          {form.type === 'delete' ? <p>선택한 파일과 폴더를 삭제합니다. 폴더 안의 파일도 삭제되며 복구할 수 없습니다.</p> : form.type === 'move' ? <p>이동할 폴더를 선택하십시오.</p> : null}
          {form.names.length > 0 && <ul>{form.names.map(name => <li key={name}>{name}</li>)}</ul>}
          {form.type === 'move' ? <MoveFolderPicker host={host} bridge={bridge} path={value} onChange={path => { setValue(path); setMoveReadyPath(''); }} disabled={busy} excludedPaths={form.paths} onReady={setMoveReadyPath}/> : form.type !== 'delete' && <label>{form.type === 'rename' ? '새 이름' : '폴더 이름'}<input value={value} onChange={event => setValue(event.target.value)} disabled={busy} autoFocus autoComplete="off" required/></label>}
          <div className="host-files-form-actions"><button type="button" className="button" disabled={busy} onClick={() => setForm(null)}>취소</button><button type="submit" className={`button ${form.type === 'delete' ? 'danger' : 'primary'}`} disabled={busy || (form.type !== 'delete' && !value) || (form.type === 'move' && (moveReadyPath !== value || value === form.base))}>{busy ? '처리 중' : form.type === 'delete' ? '파일 삭제' : form.type === 'move' ? '이 폴더로 이동' : form.type === 'mkdir' ? '폴더 만들기' : '이름 변경'}</button></div>
        </form>}
        {previewPath ? <MarkdownViewer host={host} path={previewPath} fragment={previewFragment} bridge={bridge} onClose={closePreview} onOpenFile={openPreview} onDocumentLoaded={setPreviewDocument}/> : <>
          <div className="host-files-table-scroll"><table className="host-files-table" aria-label="원격 파일 목록" aria-busy={loading}><thead><tr><th className="host-files-select"><FileSelection checked={entries.length > 0 && visibleSelected === entries.length} mixed={visibleSelected > 0 && visibleSelected < entries.length} disabled={disabled || !entries.length} onChange={event => setSelection(items => event.target.checked ? [...new Set([...items, ...entries.map(entry => entry.path)])] : items.filter(path => !entries.some(entry => entry.path === path)))}/></th><th>이름</th><th className="numeric">크기</th><th className="numeric">수정일</th></tr></thead><tbody>
            {entries.map(entry => <tr key={entry.path} className={`${selection.includes(entry.path) ? 'selected' : ''} ${dropPath === entry.path ? 'drop-target' : ''}`} draggable={!disabled} onClick={event => { if (disabled || event.target.closest('button,input')) return; setSelection([entry.path]); }} onDragStart={event => beginDrag(event, entry)} onDragEnd={() => { dragPaths.current = []; setDropPath(''); }} onDragOver={event => { if (entry.type === 'directory' && dragPaths.current.length && !dragPaths.current.includes(entry.path) && !disabled) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropPath(entry.path); } }} onDragLeave={() => setDropPath('')} onDrop={event => drop(event, entry)} onDoubleClick={event => { if (event.target.closest('input') || (entry.type === 'directory' && event.target.closest('button'))) return; openEntry(entry); }}>
              <td><input type="checkbox" aria-label={`${entry.name} 선택`} checked={selection.includes(entry.path)} disabled={disabled} onChange={event => toggle(entry.path, event.target.checked)}/></td><td><button type="button" className="host-files-name" data-file-path={entry.path} aria-label={`${entry.name} ${entry.type === 'directory' ? '폴더 열기' : '파일 선택'}`} disabled={disabled} onClick={event => { if (entry.type === 'directory') { if (event.detail < 2) openEntry(entry); } else setSelection([entry.path]); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); openEntry(entry); } }}>{entry.type === 'directory' ? <Folder size={17}/> : entry.type === 'symlink' ? <Link size={17}/> : isMarkdown(entry) ? <FileText size={17}/> : <File size={17}/>}<span title={entry.name}>{entry.name}</span></button></td><td className="numeric" title={entry.size != null && entry.size !== '' && Number.isFinite(Number(entry.size)) ? `${Number(entry.size).toLocaleString('ko-KR')} B` : undefined}>{entry.type === 'directory' ? '—' : sizeLabel(entry.size)}</td><td className="numeric">{dateLabel(entry.modifiedAt)}</td>
            </tr>)}
            {!entries.length && <tr><td colSpan={4} className="empty">{loading ? '파일을 불러오는 중입니다.' : !listing.path ? '파일 목록을 불러오지 못했습니다.' : filter ? '검색 결과가 없습니다.' : '빈 폴더입니다.'}</td></tr>}
          </tbody></table></div>
        </>}
      </div>
      <aside className="host-files-sidebar" aria-label="파일 정보">
        <div className="host-files-sidebar-heading"><h2>{infoEntries.length ? '선택 항목' : '현재 폴더'}</h2><ActionButton label="파일 정보 닫기" icon={X} className="host-files-inspector-toggle" disabled={transferRunning} onClick={() => setInspectorOpen(false)}/></div>
        {infoEntries.length === 1 ? <div className="host-files-inspector"><div className="host-files-inspector-icon">{infoEntries[0].type === 'directory' ? <Folder size={34}/> : isMarkdown(infoEntries[0]) ? <FileText size={34}/> : <File size={34}/>}</div><h3>{infoEntries[0].name}</h3><dl><div><dt>종류</dt><dd>{infoEntries[0].type === 'directory' ? '폴더' : isMarkdown(infoEntries[0]) ? '마크다운 문서' : infoEntries[0].type === 'symlink' ? '바로가기' : '파일'}</dd></div>{infoEntries[0].type !== 'directory' && <div><dt>크기</dt><dd className="numeric">{sizeLabel(infoEntries[0].size)}</dd></div>}<div><dt>수정일</dt><dd className="numeric">{dateLabel(infoEntries[0].modifiedAt)}</dd></div></dl>{isMarkdown(infoEntries[0]) && <ActionButton label="미리보기" icon={Eye} disabled={disabled} onClick={() => openPreview(infoEntries[0].path)}/>}{infoEntries[0].type === 'directory' && <ActionButton label="폴더 열기" icon={FolderOpen} disabled={disabled} onClick={() => openEntry(infoEntries[0])}/>}</div> : infoEntries.length > 1 ? <div className="host-files-inspector"><h3>{infoEntries.length}개 항목</h3><p>파일 {infoEntries.filter(item => item.type !== 'directory').length}개 · 폴더 {infoEntries.filter(item => item.type === 'directory').length}개</p><ul className="host-files-selected-names">{infoEntries.map(item => <li key={item.path}>{item.name}</li>)}</ul></div> : <div className="host-files-inspector"><div className="host-files-inspector-icon"><Folder size={34}/></div><h3>{folderLabel(listing.path)}</h3><p className="host-files-location" title={listing.path}>{listing.path}</p></div>}
        <section className="host-files-host-summary" aria-label="접속 호스트"><h3>접속 호스트</h3><strong>{host.alias}</strong><p>{host.hostName || host.alias}</p></section>
        {transfers.length > 0 && <section className="host-files-transfers" aria-label="파일 전송"><h3>파일 전송</h3><ul>{[...transfers].reverse().map(item => {
          const total = Math.max(0, Number(item.totalBytes) || 0), done = Math.max(0, Number(item.completedBytes) || 0), progress = total ? Math.min(100, Math.floor(done / total * 100)) : item.status === 'completed' ? 100 : 0;
          return <li key={item.id} className={item.status}><div className="host-files-transfer-heading"><strong>{item.direction === 'upload' ? '업로드' : '다운로드'}</strong><span>{statusLabels[item.status] || item.status}</span>{item.status === 'running' && <ActionButton label={`${item.id} 전송 취소`} tooltip="전송 취소" icon={X} busy={canceling.includes(item.id)} disabled={canceling.includes(item.id)} onClick={() => cancel(item.id)}/>}</div>{item.currentFile && <p className="host-files-transfer-file" title={item.currentFile}>{item.currentFile.split('/').at(-1)}</p>}<p className="numeric host-files-transfer-size">{total ? `${progress}% · ${sizeLabel(done)} / ${sizeLabel(total)}` : sizeLabel(done)}</p>{item.message && <p className="host-files-transfer-message">{item.message}</p>}{item.status === 'running' && <progress aria-label={`${item.id} 전송 진행률`} value={total ? progress : undefined} max={100}/>}{item.error && <p className="host-files-transfer-error" role="alert">{item.error}</p>}</li>;
        })}</ul></section>}
      </aside>
    </div>
  </section>;
}
