import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, ArrowUpCircle, Check, ChevronDown, ChevronRight, Copy, ExternalLink, Folder, FolderOpen, GripVertical, KeyRound, Loader2, Pencil, Plus, RefreshCw, Trash2, UserRound, X } from 'lucide-react';
import './host-manager.css';

const emptyState = { configPath: '', revision: '', hosts: [], groups: [], refresh: { running: false } };
const text = value => Array.isArray(value) ? value.filter(Boolean).join(', ') || '—' : value == null || value === '' ? '—' : String(value);
const loginActive = login => ['starting', 'waiting', 'verifying'].includes(login?.status);
const running = host => Boolean(host.operation?.running) || loginActive(host.login) || ['checking', 'loading', 'connecting'].includes(host.connection?.status);
const connectable = host => host.connectable !== false;
const connectionLabel = host => {
  switch (host.connection?.status) {
    case 'online': case 'connected': case 'ready': return '접속 가능';
    case 'loading': case 'checking': case 'connecting': return '조회 중';
    case 'offline': case 'error': case 'failed': return '접속 실패';
    case 'canceled': case 'cancelled': return '조회 취소';
    default: return host.connectable === false ? '공통 설정' : '조회 전';
  }
};
const accountLabel = host => {
  if (host.codex?.accountEmail) return host.codex.accountEmail;
  if (host.codex?.accountName) return host.codex.accountName;
  if (host.codex?.available === false) return '—';
  if (['signedOut', 'signed_out', 'loggedOut', 'not_logged_in'].includes(host.codex?.loginStatus)) return '로그인 필요';
  if (['apiKey', 'api_key'].includes(host.codex?.loginStatus)) return 'API 키 로그인';
  if (host.codex?.loginStatus === 'error' || (host.codex?.available && host.codex?.loginStatus === 'unknown')) return '계정 조회 실패';
  return '—';
};

function HostErrorPopover({ label, title, message, className = '', children }) {
  const ref = useRef(null);
  const timer = useRef(null);
  const id = useId();
  const [position, setPosition] = useState(null);
  const hide = () => { clearTimeout(timer.current); setPosition(null); };
  const deferHide = () => { clearTimeout(timer.current); timer.current = setTimeout(hide, 100); };
  const show = () => {
    clearTimeout(timer.current);
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(390, window.innerWidth - 24);
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    const above = window.innerHeight - rect.bottom < 150;
    setPosition({ left, width, ...(above ? { bottom: window.innerHeight - rect.top + 7 } : { top: rect.bottom + 7 }), maxHeight: Math.max(80, (above ? rect.top : window.innerHeight - rect.bottom) - 20) });
  };
  useEffect(() => {
    if (!position) return;
    const dismiss = event => { if (event.type === 'resize' || !event.target?.closest?.('.host-error-popover')) hide(); };
    const escape = event => { if (event.key === 'Escape') hide(); };
    window.addEventListener('resize', dismiss);
    document.addEventListener('scroll', dismiss, true);
    document.addEventListener('keydown', escape);
    return () => { window.removeEventListener('resize', dismiss); document.removeEventListener('scroll', dismiss, true); document.removeEventListener('keydown', escape); };
  }, [position]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <>
    <button ref={ref} type="button" className={`host-error-trigger ${className}`} aria-label={label} aria-describedby={position ? id : undefined} onMouseEnter={show} onMouseLeave={deferHide} onFocus={show} onBlur={hide}>{children}</button>
    {position && createPortal(<div id={id} role="tooltip" className="host-error-popover" style={position} onMouseEnter={() => clearTimeout(timer.current)} onMouseLeave={deferHide}><strong>{title}</strong><p>{message}</p></div>, document.body)}
  </>;
}

function HostModal({ title, children, tabs, footer, onClose, alert = false, wide = false }) {
  const ref = useRef(null);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const targets = () => [...(ref.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]') || [])]
      .filter(item => item.tabIndex >= 0 && !item.closest('[hidden], [aria-hidden="true"]') && item.getClientRects().length > 0);
    const focusFirst = () => (targets()[0] || ref.current)?.focus();
    focusFirst();
    const keydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key !== 'Tab') return;
      const items = targets();
      if (!items.length) { event.preventDefault(); ref.current?.focus(); return; }
      if (!items.includes(document.activeElement)) { event.preventDefault(); (event.shiftKey ? items.at(-1) : items[0]).focus(); }
      else if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1).focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus(); }
    };
    const focusin = event => { if (ref.current && !ref.current.contains(event.target)) focusFirst(); };
    document.addEventListener('keydown', keydown);
    document.addEventListener('focusin', focusin);
    return () => { document.removeEventListener('keydown', keydown); document.removeEventListener('focusin', focusin); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <section ref={ref} tabIndex={-1} className={`modal host-modal ${wide ? 'wide' : ''}`} role={alert ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby={titleId}>
      <div className="modal-heading"><h2 id={titleId}>{title}</h2><button className="icon-button" aria-label="닫기" onClick={onClose}><X size={18}/></button></div>
      {tabs}
      <div className="modal-body">{children}</div><div className="modal-footer">{footer}</div>
    </section>
  </div>;
}

const blankDraft = { alias: '', hostName: '', user: '', port: '', identityFile: '', proxyJump: '', groupId: '' };
function HostForm({ draft, groups, onChange, onSubmit }) {
  const field = (name, label, placeholder, props = {}) => <div className={name === 'identityFile' || name === 'proxyJump' ? 'host-form-full' : ''} key={name}>
    <label htmlFor={`host-${name}`}>{label}</label><input id={`host-${name}`} name={name} value={draft[name] || ''} onChange={event => onChange({ ...draft, [name]: event.target.value })} placeholder={placeholder} autoComplete="off" {...props}/>
  </div>;
  return <form id="host-form" onSubmit={onSubmit} className="host-form">
    {field('alias', 'SSH 이름', '예: dev-server', { required: true, maxLength: 120 })}
    {field('hostName', '호스트 주소', 'IP 또는 도메인')}
    {field('user', '접속 사용자', '예: ubuntu')}
    {field('port', 'SSH 포트', '기본 설정 사용', { type: 'number', min: 1, max: 65535, className: 'numeric' })}
    {field('identityFile', '개인 키 파일', '예: ~/.ssh/id_ed25519')}
    {field('proxyJump', '중간 접속 호스트', '예: bastion')}
    <div className="host-form-full"><label htmlFor="host-groupId">그룹</label><select id="host-groupId" value={draft.groupId || ''} onChange={event => onChange({ ...draft, groupId: event.target.value })}><option value="">그룹 없음</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></div>
    <p className="host-form-full muted">remote-mgmt와 같은 SSH 설정 파일에 저장됩니다. 다른 SSH 설정과 주석은 유지됩니다.</p>
  </form>;
}

const detailTabs = [{ name: 'connection', label: '접속 정보' }, { name: 'keys', label: '키 등록' }];
function HostTabs({ active, onChange, idPrefix }) {
  const move = event => {
    const current = detailTabs.findIndex(tab => tab.name === active);
    const next = event.key === 'ArrowRight' ? (current + 1) % detailTabs.length : event.key === 'ArrowLeft' ? (current + detailTabs.length - 1) % detailTabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? detailTabs.length - 1 : null;
    if (next == null) return;
    event.preventDefault();
    onChange(detailTabs[next].name);
    event.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next]?.focus();
  };
  return <div className="host-detail-tabs" role="tablist" aria-label="호스트 상세 메뉴">
    {detailTabs.map(tab => <button key={tab.name} type="button" role="tab" id={`${idPrefix}-${tab.name}-tab`} aria-selected={active === tab.name} aria-controls={`${idPrefix}-${tab.name}-panel`} tabIndex={active === tab.name ? 0 : -1} onClick={() => onChange(tab.name)} onKeyDown={move}>
      {tab.name === 'keys' ? <KeyRound size={15}/> : <Pencil size={15}/>} {tab.label}
    </button>)}
  </div>;
}

function HostDetails({ host, details, loading, error, keyError, keyResult, keyHistory, password, setPassword, action, tab, idPrefix, onInspect, onRegister, onGenerate }) {
  const effective = details?.effective || {};
  const key = details?.key || keyResult?.key;
  const value = (property, alternate) => effective[property] ?? effective[alternate] ?? host[property];
  const registered = keyResult?.registered;
  const address = text(value('hostName', 'hostname'));
  const keyState = registered === true ? '등록 완료' : registered === false ? '미등록' : '조회 전';
  return <div className="host-details">
    <div id={`${idPrefix}-connection-panel`} role="tabpanel" aria-labelledby={`${idPrefix}-connection-tab`} hidden={tab !== 'connection'} tabIndex={0}>
      {loading && <p className="host-loading" role="status"><Loader2 size={15} className="spin"/>접속 정보 조회 중</p>}
      {error && <p className="host-inline-error" role="alert">{error}</p>}
      <section aria-label="SSH 접속 정보"><h3>SSH 접속 정보</h3>
        <dl className="host-info-grid">
          <div><dt>SSH 이름</dt><dd>{text(host.alias)}</dd></div>
          <div><dt>호스트 주소</dt><dd className="host-mono">{address}</dd></div>
          <div><dt>접속 사용자</dt><dd>{text(value('user'))}</dd></div>
          <div><dt>SSH 포트</dt><dd className="numeric">{text(value('port'))}</dd></div>
          <div className="host-info-full"><dt>개인 키 파일</dt><dd className="host-mono">{text(effective.identityFile ?? effective.identityFiles ?? effective.identities ?? host.identityFile)}</dd></div>
          <div className="host-info-full"><dt>중간 접속 호스트</dt><dd>{text(value('proxyJump', 'proxyjump'))}</dd></div>
        </dl>
      </section>
      <section aria-label="호스트 Codex 정보"><h3>Codex</h3>
        <dl className="host-info-grid"><div><dt>버전</dt><dd className="numeric">{host.codex?.available === false ? '설치 없음' : text(host.codex?.version)}</dd></div><div><dt>로그인 계정</dt><dd>{accountLabel(host)}</dd></div></dl>
      </section>
    </div>
    <div id={`${idPrefix}-keys-panel`} role="tabpanel" aria-labelledby={`${idPrefix}-keys-tab`} hidden={tab !== 'keys'} tabIndex={0}>
      <section className="host-key-controls" aria-label="SSH 키 등록">
        <div className="host-key-target-grid">
          <div><label>등록할 호스트</label><div className="host-key-target"><strong>{host.alias}</strong><span>{address}</span></div></div>
          <div className="host-password-field">
            <label htmlFor="host-password">서버 비밀번호 <span className="muted">(선택)</span></label>
            <div className="host-password-input"><input id="host-password" type="password" autoComplete="off" value={password} disabled={Boolean(action) || !connectable(host)} onChange={event => setPassword(event.target.value)} placeholder="필요할 때만 입력"/>
              {password && <button type="button" className="icon-button" aria-label="비밀번호 지우기" disabled={Boolean(action)} onClick={() => setPassword('')}><X size={14}/></button>}
            </div>
          </div>
        </div>
        <p className="host-password-note">비밀번호는 접속에만 사용되며 저장되지 않습니다.</p>
        <div className="host-key-buttons"><button type="button" className="button" disabled={Boolean(action) || loading || !connectable(host)} onClick={onInspect}><RefreshCw size={14} className={action === 'inspect' ? 'spin' : ''}/>{action === 'inspect' ? '조회 중' : '등록 상태 조회'}</button><button type="button" className="button primary" disabled={Boolean(action) || loading || !connectable(host) || !key?.publicExists || !key?.privateExists || !key?.publicKey?.trim()} onClick={onRegister}><KeyRound size={14}/>{action === 'register' ? '처리 중' : '미등록 시 등록'}</button></div>
        <div className={`host-key-status-banner ${registered === true ? 'registered' : ''}`} role="status"><strong>{keyState}</strong><span>{registered === true ? '이 컴퓨터의 공개 키가 서버에 등록되어 있습니다.' : registered === false ? '이 컴퓨터의 공개 키가 서버에 등록되지 않았습니다.' : '등록 상태 조회를 누르면 서버에 등록된 키를 불러옵니다.'}</span></div>
        {loading && <p className="host-loading" role="status"><Loader2 size={15} className="spin"/>키 정보 조회 중</p>}
        {error && <p className="host-inline-error" role="alert">{error}</p>}
        {keyError && <p className="host-inline-error" role="alert">{keyError}</p>}
      </section>
      <div className="host-key-workspace">
        <section className="host-authorized-keys" role="region" aria-label="서버에 등록된 키">
          <div className="host-section-heading"><h3>서버에 등록된 키</h3>{Array.isArray(keyResult?.keys) && <span className="muted numeric">{keyResult.keys.length}개</span>}</div>
          <div className="host-server-key-body">
            {keyResult?.keys?.length > 0 ? <ul>{keyResult.keys.map((item, index) => <li className={item.matchesLocal ? 'matches-local' : ''} key={item.id || `${item.fingerprint}-${index}`}><div><strong>{item.comment || item.keyType || '공개 키'}</strong>{item.matchesLocal && <span className="host-key-local"><Check size={11}/>이 컴퓨터</span>}</div><code>{item.fingerprint || '—'}</code>{item.matchesLocal && <p>이 컴퓨터의 공개 키와 일치합니다.</p>}</li>)}</ul> : <p className="host-key-empty muted">{Array.isArray(keyResult?.keys) ? '등록된 키가 없습니다.' : '등록 상태를 조회하면 키 목록이 표시됩니다.'}</p>}
          </div>
        </section>
        <section className="host-local-key-panel" aria-label="이 컴퓨터의 공개 키">
          <div className="host-section-heading"><h3>이 컴퓨터의 공개 키</h3></div>
          <div className="host-local-key-body">
            <dl className="host-key-info"><div><dt>공개 키 파일</dt><dd className="host-mono">{text(key?.publicKeyPath)}</dd></div><div><dt>키 지문</dt><dd className="host-mono">{key?.publicExists ? text(key.fingerprint) : loading ? '조회 중' : '공개 키 없음'}</dd></div></dl>
            {!loading && key && !key.publicExists && <div className="host-key-generate"><p>서버에 등록할 공개 키를 생성합니다.</p><button type="button" className="button" disabled={Boolean(action) || !connectable(host)} onClick={onGenerate}><KeyRound size={14}/>{action === 'generate' ? (key.privateExists ? '공개 키 생성 중' : '키 생성 중') : key.privateExists ? '공개 키 생성' : '키 생성'}</button></div>}
            <div className="host-key-result" role="region" aria-label="처리 결과"><h4>처리 결과</h4>{keyHistory.length ? <ol>{keyHistory.map((item, index) => <li key={index}><time>{item.time}</time><span>{item.message}</span></li>)}</ol> : <p>조회 또는 등록 결과가 표시됩니다.</p>}</div>
            {key?.publicExists && key.publicKey && <div className="host-key-source"><h4>공개 키 내용</h4><textarea className="host-public-key-preview" readOnly aria-label="등록할 공개 키" value={key.publicKey} rows={4}/></div>}
          </div>
        </section>
      </div>
    </div>
  </div>;
}

export function HostManager({ bridge, isDemo = false }) {
  const [state, setState] = useState(emptyState);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState('');
  const [modal, setModal] = useState(null);
  const [draft, setDraft] = useState(blankDraft);
  const [details, setDetails] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [keyResult, setKeyResult] = useState(null);
  const [keyError, setKeyError] = useState('');
  const [keyHistory, setKeyHistory] = useState([]);
  const [detailTab, setDetailTab] = useState('connection');
  const tabsId = useId();
  const [password, setPassword] = useState('');
  const [action, setAction] = useState('');
  const [groupName, setGroupName] = useState('');
  const [loginError, setLoginError] = useState('');
  const [copiedCode, setCopiedCode] = useState(false);
  const activeLoginHost = useRef(null);
  const [pendingOrder, setPendingOrder] = useState(null);
  const [orderSaving, setOrderSaving] = useState(false);
  const [draggedId, setDraggedId] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const orderBusy = useRef(false);
  const dragSource = useRef(null);
  const request = useRef(0);
  const mounted = useRef(true);
  const apply = snapshot => { if (mounted.current && snapshot?.hosts) { setState({ ...emptyState, ...snapshot, groups: Array.isArray(snapshot.groups) ? snapshot.groups : [] }); setLoaded(true); } };
  const run = async operation => {
    try { const result = await operation(); apply(result); return result; }
    catch (error) {
      if (mounted.current) setNotice(error.message || '작업을 완료하지 못했습니다.');
      try { const latest = await bridge.getState(); apply(latest); if (mounted.current && latest?.revision) setModal(previous => previous?.revision ? { ...previous, revision: latest.revision } : previous); } catch { /* Keep the received state when reloading fails. */ }
      return null;
    }
  };
  const groupsById = new Map(state.groups.map(item => [item.id, item]));
  const groupFor = item => groupsById.has(item?.groupId) ? item.groupId : null;
  const hostsById = new Map(state.hosts.map(item => [item.id, item]));
  const visibleHosts = pendingOrder ? [...pendingOrder.map(id => hostsById.get(id)).filter(Boolean), ...state.hosts.filter(item => !pendingOrder.includes(item.id))] : state.hosts;
  const saveOrder = async (ids, focusId) => {
    if (!bridge?.reorderHosts || orderBusy.current || ids.length !== state.hosts.length || ids.every((id, index) => id === state.hosts[index].id)) return;
    orderBusy.current = true; setOrderSaving(true); setPendingOrder(ids); setNotice('');
    try {
      const snapshot = await bridge.reorderHosts(ids, state.revision);
      apply(snapshot);
    } catch (error) {
      if (mounted.current) setNotice(error.message || '호스트 순서를 저장하지 못했습니다.');
      try { apply(await bridge.getState()); } catch { /* Keep the latest received state if reloading fails. */ }
    } finally {
      orderBusy.current = false;
      if (mounted.current) {
        setPendingOrder(null); setOrderSaving(false);
        if (focusId) requestAnimationFrame(() => document.querySelector(`.host-drag-handle[data-host-id="${CSS.escape(focusId)}"]`)?.focus());
      }
    }
  };
  const moveToGroup = async (hostId, groupId, ids) => {
    if (!bridge?.moveHostToGroup || orderBusy.current) return;
    orderBusy.current = true; setOrderSaving(true); setNotice('');
    try { apply(await bridge.moveHostToGroup(hostId, groupId, state.revision, ids)); }
    catch (error) {
      if (mounted.current) setNotice(error.message || '호스트 그룹을 변경하지 못했습니다.');
      try { apply(await bridge.getState()); } catch { /* Preserve the last snapshot. */ }
    } finally { orderBusy.current = false; if (mounted.current) { setOrderSaving(false); setPendingOrder(null); } }
  };
  const dragOverGroup = (event, groupId) => {
    if (!dragSource.current || orderBusy.current) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move';
    setDropTarget({ groupId });
  };
  const dropOnGroup = (event, groupId) => {
    if (!dragSource.current || orderBusy.current) return;
    event.preventDefault();
    const sourceId = dragSource.current, source = hostsById.get(sourceId);
    clearDrag();
    if (!source || groupFor(source) === groupId) return;
    const ids = visibleHosts.filter(item => item.id !== sourceId).map(item => item.id);
    const members = visibleHosts.filter(item => item.id !== sourceId && groupFor(item) === groupId);
    const last = members.at(-1)?.id;
    ids.splice(last ? ids.indexOf(last) + 1 : ids.length, 0, sourceId);
    moveToGroup(sourceId, groupId, ids);
  };
  const clearDrag = () => { dragSource.current = null; setDraggedId(null); setDropTarget(null); };
  const beginDrag = (event, item) => {
    if (orderBusy.current || modal || action) { event.preventDefault(); return; }
    dragSource.current = item.id; setDraggedId(item.id);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', item.id);
    event.dataTransfer.setDragImage(event.currentTarget.closest('tr'), 24, 20);
  };
  const dragOver = (event, item) => {
    if (!dragSource.current || orderBusy.current || dragSource.current === item.id) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move';
    const rect = event.currentTarget.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    setDropTarget(previous => previous?.id === item.id && previous.after === after ? previous : { id: item.id, after });
  };
  const drop = (event, item) => {
    if (!dragSource.current || orderBusy.current) return;
    event.preventDefault();
    const sourceId = dragSource.current;
    const rect = event.currentTarget.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    const ids = visibleHosts.map(entry => entry.id).filter(id => id !== sourceId);
    const index = ids.indexOf(item.id);
    clearDrag();
    if (sourceId === item.id || index < 0) return;
    ids.splice(index + (after ? 1 : 0), 0, sourceId);
    if (groupFor(hostsById.get(sourceId)) !== groupFor(item)) moveToGroup(sourceId, groupFor(item), ids);
    else saveOrder(ids, sourceId);
  };
  const moveByKeyboard = (event, item) => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key) || orderBusy.current || modal || action) return;
    event.preventDefault();
    const members = visibleHosts.filter(entry => groupFor(entry) === groupFor(item));
    const memberIndex = members.findIndex(entry => entry.id === item.id);
    const next = members[memberIndex + (event.key === 'ArrowUp' ? -1 : 1)];
    if (!next) return;
    const ids = visibleHosts.map(entry => entry.id), index = ids.indexOf(item.id), target = ids.indexOf(next.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    saveOrder(ids, item.id);
  };
  useEffect(() => {
    mounted.current = true;
    if (bridge) {
      (async () => {
        const snapshot = await run(() => bridge.getState());
        if (!mounted.current) return;
        setLoaded(true);
        const unread = snapshot?.hosts?.filter(host => connectable(host) && !host.connection?.checkedAt && !host.codex?.version && host.codex?.available == null && !['canceled', 'cancelled'].includes(host.connection?.status));
        if (unread?.length && !snapshot.refresh?.running) await run(() => bridge.refreshHosts(unread.map(host => host.id)));
      })();
    }
    const unsubscribe = bridge?.onState?.(apply);
    return () => { mounted.current = false; request.current++; unsubscribe?.(); if (activeLoginHost.current) bridge?.cancelCodexLogin?.(activeLoginHost.current).catch(() => {}); };
  }, [bridge]);
  const host = ['details', 'form', 'upgrade', 'delete', 'login'].includes(modal?.type) && modal?.id ? state.hosts.find(item => item.id === modal.id) || (modal.type === 'details' && details?.host?.id === modal.id ? details.host : null) : null;
  activeLoginHost.current = modal?.type === 'login' && (loginActive(host?.login) || action === 'startLogin') ? host.id : null;
  const close = async () => {
    if (action) return;
    if (modal?.type === 'login' && loginActive(host?.login)) {
      setAction('cancelLogin'); setLoginError('');
      try { apply(await bridge.cancelCodexLogin(host.id)); activeLoginHost.current = null; }
      catch (error) { if (mounted.current) { setLoginError(error.message || '로그인을 취소하지 못했습니다.'); setAction(''); } return; }
      if (!mounted.current) return;
      setAction('');
    }
    request.current++; setModal(null); setPassword(''); setDetailError(''); setKeyError(''); setLoginError('');
  };
  const openDetails = async target => {
    const token = ++request.current;
    setModal({ type: 'details', id: target.id }); setDetails(null); setKeyResult(null); setPassword(''); setDetailError(''); setKeyError(''); setKeyHistory([]); setDetailTab('connection'); setDetailLoading(true);
    try {
      const result = await bridge.getHostDetails(target.id);
      if (mounted.current && token === request.current) setDetails(result);
    } catch (error) {
      if (mounted.current && token === request.current) setDetailError(error.message || 'SSH 접속 정보를 조회하지 못했습니다.');
    } finally { if (mounted.current && token === request.current) setDetailLoading(false); }
  };
  const openForm = target => {
    request.current++; setPassword(''); setDetailError(''); setKeyError('');
    setDraft(target ? { ...target, ...Object.fromEntries(Object.keys(blankDraft).map(name => [name, target[name] ?? ''])) } : { ...blankDraft });
    setModal({ type: 'form', id: target?.id, revision: state.revision });
  };
  const save = async event => {
    event.preventDefault(); if (action) return;
    setAction('save');
    const payload = { ...draft, alias: draft.alias.trim(), hostName: draft.hostName.trim(), user: draft.user.trim(), port: String(draft.port || '').trim(), identityFile: draft.identityFile.trim(), proxyJump: draft.proxyJump.trim(), groupId: draft.groupId || null };
    if (draft.hostPatterns) payload.hostPatterns = [payload.alias, ...draft.hostPatterns.split(/\s+/).filter((name, index) => index > 0)].join(' ');
    const result = await run(() => bridge.saveHost(payload, modal.revision));
    if (result && mounted.current) setModal(null);
    if (mounted.current) setAction('');
  };
  const performKeyAction = async type => {
    if (!host || action) return;
    const id = host.id, token = request.current, secret = password || undefined;
    const current = () => mounted.current && token === request.current;
    const message = (value, fallback) => {
      const content = String(value || fallback);
      return secret ? content.split(secret).join('••••') : content;
    };
    const record = content => {
      const now = new Date();
      const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map(value => String(value).padStart(2, '0')).join(':');
      if (current()) setKeyHistory(previous => [...previous, { time, message: content }].slice(-12));
    };
    const applyKeyResult = result => {
      if (!current()) return;
      setKeyResult(previous => ({ ...previous, ...result, ...(result.message ? { message: message(result.message, '') } : {}) }));
      if (result.key) setDetails(previous => ({ ...previous, key: result.key }));
    };
    setAction(type); setKeyError('');
    try {
      if (type === 'generate') {
        const result = await bridge.generateKey(id);
        if (!current()) return;
        setDetails(previous => ({ ...previous, key: result.key || result })); setKeyResult(null);
        record(message(result.message, 'SSH 키를 준비했습니다.'));
        const freshDetails = await bridge.getHostDetails(id);
        if (current()) setDetails(freshDetails);
      }
      else {
        const inspected = await bridge.inspectKeys(id, secret);
        if (!current()) return;
        applyKeyResult(inspected);
        if (typeof inspected.registered !== 'boolean') throw new Error('공개 키 등록 상태를 조회하지 못했습니다. 등록 상태를 다시 조회하십시오.');
        record(message(inspected.message, inspected.registered ? '등록 상태 조회 완료: 이 컴퓨터의 키가 등록되어 있습니다.' : '등록 상태 조회 완료: 이 컴퓨터의 키가 등록되지 않았습니다.'));
        if (type === 'register') {
          if (inspected.registered) {
            record('이미 등록된 키입니다. 등록 작업을 생략했습니다.');
            return;
          }
          const result = await bridge.registerKey(id, secret);
          if (!current()) return;
          applyKeyResult(result);
          const confirmed = Array.isArray(result.keys) && typeof result.registered === 'boolean' ? result : await bridge.inspectKeys(id);
          if (!current()) return;
          applyKeyResult(confirmed);
          if (!confirmed.registered) throw new Error('키 등록 후 이 컴퓨터의 공개 키를 조회하지 못했습니다. 등록 상태를 다시 조회하십시오.');
          record(message(result.message, '공개 키를 등록했습니다.'));
          const freshDetails = await bridge.getHostDetails(id);
          if (current()) setDetails(freshDetails);
        }
      }
    } catch (error) { if (current()) { const content = message(error.message, 'SSH 키 작업을 완료하지 못했습니다.'); setKeyError(content); record(content); } }
    finally { if (current()) { setPassword(''); setAction(''); } }
  };
  const confirmUpgrade = async () => {
    if (!host || action) return;
    setAction('upgrade');
    const result = await run(() => bridge.upgradeCodex(host.id));
    if (mounted.current) { setAction(''); if (result) setModal(null); }
  };
  const confirmDelete = async () => {
    if (!host || action) return;
    setAction('delete');
    const result = await run(() => bridge.deleteHost(host.id, modal.revision));
    if (mounted.current) { setAction(''); if (result) setModal(null); }
  };

  const openGroupForm = group => { setGroupName(group?.name || ''); setModal({ type: 'groupForm', id: group?.id, revision: state.revision }); setNotice(''); };
  const saveGroup = async event => {
    event.preventDefault(); if (action || !groupName.trim()) return;
    setAction('saveGroup');
    const result = await run(() => bridge.saveGroup({ ...(modal.id ? { id: modal.id } : {}), name: groupName.trim() }, modal.revision));
    if (mounted.current) { setAction(''); if (result) setModal(null); }
  };
  const deleteGroup = async () => {
    if (action) return;
    setAction('deleteGroup'); const result = await run(() => bridge.deleteGroup(modal.id, modal.revision));
    if (mounted.current) { setAction(''); if (result) setModal(null); }
  };
  const collapseGroup = async group => {
    if (orderBusy.current || action) return;
    orderBusy.current = true; setOrderSaving(true);
    await run(() => bridge.setGroupCollapsed(group.id, !group.collapsed, state.revision));
    orderBusy.current = false; if (mounted.current) setOrderSaving(false);
  };
  const startLogin = async () => {
    if (!host || action || loginActive(host.login)) return;
    setAction('startLogin'); setLoginError(''); setCopiedCode(false);
    activeLoginHost.current = host.id;
    try { apply(await bridge.startCodexLogin(host.id)); }
    catch (error) { if (mounted.current) setLoginError(error.message || '로그인을 시작하지 못했습니다.'); }
    finally { if (mounted.current) setAction(''); }
  };
  const cancelLogin = async () => {
    if (!host || action) return;
    setAction('cancelLogin'); setLoginError('');
    try { apply(await bridge.cancelCodexLogin(host.id)); activeLoginHost.current = null; }
    catch (error) { if (mounted.current) setLoginError(error.message || '로그인을 취소하지 못했습니다.'); }
    finally { if (mounted.current) setAction(''); }
  };
  const loginLink = async type => {
    if (!host || action) return;
    setAction(type); setLoginError('');
    try { if (type === 'copyLoginCode') { await bridge.copyCodexLoginCode(host.id); if (mounted.current) setCopiedCode(true); } else await bridge.openCodexLogin(host.id); }
    catch (error) { if (mounted.current) setLoginError(error.message || '로그인 정보를 열지 못했습니다.'); }
    finally { if (mounted.current) setAction(''); }
  };
  const renderHost = item => {
        const failed = ['offline', 'error', 'failed'].includes(item.connection?.status);
        const statusClass = `host-status ${['online', 'connected', 'ready'].includes(item.connection?.status) ? 'connected' : failed ? 'failed' : ''}`;
        const status = <>{running(item) && <Loader2 size={12} className="spin"/>}{connectionLabel(item)}</>;
        const address = `${item.user ? `${item.user}@` : ''}${item.hostName || item.hostPatterns || item.alias}${item.port ? `:${item.port}` : ''}`;
        const accountError = item.codex?.message && (item.codex.loginStatus === 'error' || accountLabel(item) === '계정 조회 실패');
        const operationError = (item.login?.status === 'error' && item.login.error) || item.operation?.error || (item.operation?.status === 'error' ? item.operation.message : '');
        return <tr key={item.id} data-host-id={item.id} className={`${draggedId === item.id ? 'host-dragging' : ''} ${dropTarget?.id === item.id ? (dropTarget.after ? 'host-drop-after' : 'host-drop-before') : ''}`} onDragOver={event => dragOver(event, item)} onDrop={event => drop(event, item)}>
          <td className="host-drag-cell"><button type="button" className="host-drag-handle" data-host-id={item.id} aria-label={`${item.alias} 순서 변경`} title="드래그하거나 ↑↓ 키로 순서를 변경합니다." disabled={orderSaving || Boolean(modal) || Boolean(action) || !bridge?.reorderHosts} draggable={!orderSaving && !modal && !action && Boolean(bridge?.reorderHosts)} onDragStart={event => beginDrag(event, item)} onDragEnd={clearDrag} onKeyDown={event => moveByKeyboard(event, item)}><GripVertical size={15}/></button></td>
          <td className={state.groups.length ? 'host-tree-host' : ''}><button className="host-entry" aria-label={`${item.alias} 호스트 정보`} title={item.alias || item.hostPatterns} onClick={() => openDetails(item)}><strong>{item.alias || item.hostPatterns}</strong></button></td>
          <td><span className="host-address" title={address}>{address}</span></td>
          <td>{failed && item.connection?.message ? <HostErrorPopover label={`${item.alias} 접속 실패 상세`} title="접속 실패" message={item.connection.message} className={statusClass}>{status}</HostErrorPopover> : <span className={statusClass}>{status}</span>}</td>
          <td className="numeric"><strong className="host-version">{item.codex?.available === false ? '설치 없음' : text(item.codex?.version)}</strong></td>
          <td>{accountError ? <HostErrorPopover label={`${item.alias} 계정 조회 실패 상세`} title="계정 조회 실패" message={item.codex.message} className="host-account-error"><span className="host-account">{accountLabel(item)}</span><AlertCircle size={12}/></HostErrorPopover> : <span className="host-account" title={accountLabel(item)}>{accountLabel(item)}</span>}</td>
          <td><div className="host-row-actions">{operationError && <HostErrorPopover label={`${item.alias} 작업 오류 상세`} title="작업 오류" message={operationError} className="host-operation-error"><AlertCircle size={14}/></HostErrorPopover>}<button className="button small" disabled={!connectable(item) || running(item) || item.codex?.available === false} onClick={() => { setModal({ type: 'upgrade', id: item.id }); setDetailError(''); }}><ArrowUpCircle size={14}/>{['upgrade', 'upgradeCodex'].includes(item.operation?.type) && item.operation.running ? '업그레이드 중' : '업그레이드'}</button><button className="button small" disabled={!bridge?.startCodexLogin || !connectable(item) || (!loginActive(item.login) && running(item)) || item.codex?.available === false} onClick={() => { setModal({ type: 'login', id: item.id }); setLoginError(''); setCopiedCode(false); }}><UserRound size={14}/>{loginActive(item.login) ? '로그인 중' : '계정 전환'}</button><button className="icon-button" aria-label={`${item.alias} 호스트 조회`} disabled={!connectable(item) || running(item)} onClick={() => run(() => bridge.refreshHosts([item.id]))}><RefreshCw size={15} className={running(item) ? 'spin' : ''}/></button></div></td>
        </tr>;

  };
  const renderGroup = (groupId, group) => {
    const members = visibleHosts.filter(item => groupFor(item) === groupId), name = group?.name || '그룹 없음';
    return <React.Fragment key={groupId || 'ungrouped'}>
      <tr className={`host-group-row ${dropTarget?.groupId === groupId ? 'host-group-drop' : ''}`} data-group-id={groupId || ''} onDragOver={event => dragOverGroup(event, groupId)} onDrop={event => dropOnGroup(event, groupId)}>
        <td colSpan={7}><div className="host-group-header">
          {group ? <button type="button" className="host-group-toggle" aria-label={`${name} ${group.collapsed ? '펼치기' : '접기'}`} aria-expanded={!group.collapsed} disabled={orderSaving || Boolean(action)} onClick={() => collapseGroup(group)}>{group.collapsed ? <ChevronRight size={15}/> : <ChevronDown size={15}/>} {group.collapsed ? <Folder size={16}/> : <FolderOpen size={16}/>}<strong>{name}</strong></button> : <span className="host-ungrouped-label"><FolderOpen size={16}/><strong>{name}</strong></span>}
          <span className="host-group-count numeric">{members.length}개</span>
          {group && <div className="host-group-actions"><button type="button" className="icon-button" aria-label={`${name} 그룹 이름 변경`} disabled={orderSaving || Boolean(action)} onClick={() => openGroupForm(group)}><Pencil size={13}/></button><button type="button" className="icon-button" aria-label={`${name} 그룹 삭제`} disabled={orderSaving || Boolean(action)} onClick={() => setModal({ type: 'groupDelete', id: group.id, name, revision: state.revision })}><Trash2 size={13}/></button></div>}
        </div></td>
      </tr>
      {!group?.collapsed && members.map(renderHost)}
    </React.Fragment>;
  };

  return <main className="host-app">
    <header className="toolbar"><div><h1>호스트관리 <span aria-hidden="true">{state.hosts.length}</span></h1>{state.configPath && <p className="host-config-path">SSH 설정 <code>{state.configPath}</code></p>}</div><div className="toolbar-actions">
      {isDemo && <span className="demo-badge">예시 데이터</span>}
      <button className="button" disabled={!bridge || state.refresh.running || orderSaving} onClick={() => run(() => bridge.reloadHosts())}><RefreshCw size={15}/>목록 새로고침</button>
      <button className="button" disabled={!bridge || !state.hosts.some(connectable) || state.refresh.running} onClick={() => run(() => bridge.refreshHosts())}><RefreshCw size={15} className={state.refresh.running ? 'spin' : ''}/>{state.refresh.running ? `${state.refresh.completed ?? state.refresh.done ?? 0}/${state.refresh.total ?? 0} 조회 중` : '전체 조회'}</button>
      <button className="button" disabled={!bridge?.saveGroup || orderSaving} onClick={() => openGroupForm()}><Folder size={15}/>그룹 추가</button>
      <button className="button primary" disabled={!bridge || orderSaving} onClick={() => openForm()}><Plus size={16}/>호스트 추가</button>
    </div></header>
    {notice && <div className="notice" role="alert"><span>{notice}</span><button className="icon-button" aria-label="알림 닫기" onClick={() => setNotice('')}><X size={16}/></button></div>}
    {state.error && <div className="host-config-error" role="alert">{state.error}</div>}
    {!bridge && <div className="runtime-notice">호스트 관리 기능은 데스크톱 앱에서 사용할 수 있습니다.</div>}
    {state.refresh.running && <div className="host-refresh-bar" role="status"><span>호스트 정보를 조회하고 있습니다.</span><button className="text-button" onClick={() => run(() => bridge.cancelRefresh())}>조회 취소</button></div>}
    <span className="host-order-announcement" role="status">{orderSaving ? '호스트 순서 저장 중' : ''}</span>
    <div className="table-scroll host-table-scroll"><table className="host-table" aria-label="호스트 목록" aria-busy={orderSaving}><thead><tr><th className="host-drag-col" aria-label="순서"/><th className="host-name-col">호스트</th><th className="host-address-col">접속 주소</th><th className="host-status-col">접속 상태</th><th className="host-version-col numeric">Codex 버전</th><th className="host-account-col">로그인 계정</th><th className="host-actions-col">작업</th></tr></thead>
      <tbody>{state.groups.length ? <>{state.groups.map(group => renderGroup(group.id, group))}{renderGroup(null)}</> : visibleHosts.map(renderHost)}{!state.hosts.length && <tr><td colSpan={7} className="empty">{bridge && !loaded ? '호스트 목록을 불러오는 중입니다.' : '등록된 호스트가 없습니다.'}</td></tr>}</tbody>
    </table></div>
    {modal?.type === 'details' && host && <HostModal wide title={`${host.alias} 호스트 정보`} onClose={close} tabs={<HostTabs active={detailTab} onChange={setDetailTab} idPrefix={tabsId}/>} footer={<><button className="button danger" disabled={Boolean(action) || running(host) || orderSaving} onClick={() => { request.current++; setPassword(''); setModal({ type: 'delete', id: host.id, revision: state.revision }); }}><Trash2 size={14}/>호스트 삭제</button><button className="button" disabled={Boolean(action) || running(host) || orderSaving} onClick={() => openForm(host)}><Pencil size={14}/>접속 정보 수정</button><button className="button" disabled={Boolean(action)} onClick={close}>닫기</button></>}>
      <HostDetails host={host} details={details} loading={detailLoading} error={detailError} keyError={keyError} keyResult={keyResult} keyHistory={keyHistory} password={password} setPassword={setPassword} action={action} tab={detailTab} idPrefix={tabsId} onInspect={() => performKeyAction('inspect')} onRegister={() => performKeyAction('register')} onGenerate={() => performKeyAction('generate')}/>
    </HostModal>}
    {modal?.type === 'form' && <HostModal title={modal.id ? '호스트 수정' : '호스트 추가'} onClose={close} footer={<><button className="button" disabled={Boolean(action)} onClick={close}>취소</button><button form="host-form" type="submit" className="button primary" disabled={Boolean(action)}>{action === 'save' ? '저장 중' : '저장'}</button></>}><HostForm draft={draft} groups={state.groups} onChange={setDraft} onSubmit={save}/></HostModal>}
    {modal?.type === 'upgrade' && host && <HostModal alert title="Codex 업그레이드" onClose={close} footer={<><button className="button" disabled={Boolean(action)} onClick={close}>취소</button><button className="button primary" disabled={Boolean(action) || running(host)} onClick={confirmUpgrade}>{action === 'upgrade' ? '업그레이드 중' : '업그레이드'}</button></>}>
      <p><strong>{host.alias}</strong> 호스트의 Codex를 최신 버전으로 업그레이드합니다.</p><dl className="host-confirm-info"><div><dt>호스트 주소</dt><dd>{text(host.hostName || host.alias)}</dd></div><div><dt>설치된 버전</dt><dd className="numeric">{text(host.codex?.version)}</dd></div></dl>
    </HostModal>}
    {modal?.type === 'delete' && host && <HostModal alert title="호스트 삭제" onClose={close} footer={<><button className="button" disabled={Boolean(action)} onClick={close}>취소</button><button className="button danger" disabled={Boolean(action)} onClick={confirmDelete}>{action === 'delete' ? '삭제 중' : '호스트 삭제'}</button></>}><p><strong>{host.alias}</strong> 호스트를 SSH 설정 파일에서 삭제합니다. remote-mgmt 목록에서도 삭제됩니다.</p></HostModal>}
    {modal?.type === 'groupForm' && <HostModal title={modal.id ? '그룹 이름 변경' : '그룹 추가'} onClose={close} footer={<><button className="button" disabled={Boolean(action)} onClick={close}>취소</button><button type="submit" form="host-group-form" className="button primary" disabled={Boolean(action) || !groupName.trim()}>{action === 'saveGroup' ? '저장 중' : '저장'}</button></>}><form id="host-group-form" onSubmit={saveGroup}><label htmlFor="host-group-name">그룹 이름</label><input id="host-group-name" autoComplete="off" maxLength={120} required value={groupName} onChange={event => setGroupName(event.target.value)}/></form></HostModal>}
    {modal?.type === 'groupDelete' && <HostModal alert title="그룹 삭제" onClose={close} footer={<><button className="button" disabled={Boolean(action)} onClick={close}>취소</button><button className="button danger" disabled={Boolean(action)} onClick={deleteGroup}>{action === 'deleteGroup' ? '삭제 중' : '그룹 삭제'}</button></>}><p><strong>{modal.name}</strong> 그룹을 삭제합니다. 그룹에 속한 호스트는 유지되며 그룹 없음 목록으로 이동합니다.</p></HostModal>}
    {modal?.type === 'login' && host && <HostModal title="Codex 계정 전환" onClose={close} footer={<>
      {loginActive(host.login) ? <button className="button danger" disabled={Boolean(action)} onClick={cancelLogin}>{action === 'cancelLogin' ? '취소 중' : '로그인 취소'}</button> : <button className="button primary" disabled={Boolean(action) || !bridge?.startCodexLogin || running(host)} onClick={startLogin}>{action === 'startLogin' ? '시작 중' : '로그인 시작'}</button>}
      <button className="button" disabled={Boolean(action)} onClick={close}>{loginActive(host.login) ? '취소하고 닫기' : '닫기'}</button>
    </>}>
      <p><strong>{host.alias}</strong> 서버에서 기기 인증으로 Codex 로그인 계정을 변경합니다. 인증 페이지에서 전환할 계정으로 로그인한 후 인증 코드를 입력하십시오.</p>
      <dl className="host-confirm-info"><div><dt>호스트 주소</dt><dd>{text(host.hostName || host.alias)}</dd></div><div><dt>로그인 계정</dt><dd>{accountLabel(host)}</dd></div></dl>
      {(host.login?.status === 'starting' || action === 'startLogin') && <p className="host-login-status" role="status"><Loader2 size={15} className="spin"/>서버 로그인을 시작하고 있습니다.</p>}
      {['waiting', 'verifying'].includes(host.login?.status) && <div className="host-device-login">
        {host.login.url && <div className="host-login-url"><span>인증 페이지</span><code>{host.login.url}</code><button type="button" className="button small" disabled={Boolean(action)} onClick={() => loginLink('openLogin')}><ExternalLink size={14}/>로그인 페이지 열기</button></div>}
        {host.login.userCode && <div className="host-login-code"><span>인증 코드</span><strong>{host.login.userCode}</strong><button className="button small" disabled={Boolean(action)} onClick={() => loginLink('copyLoginCode')}><Copy size={14}/>{copiedCode ? '복사 완료' : '인증 코드 복사'}</button></div>}
        <p className="host-login-status" role="status"><Loader2 size={15} className="spin"/>{host.login.status === 'verifying' ? '로그인 계정을 조회하고 있습니다.' : '브라우저 인증을 기다리고 있습니다.'}</p>
      </div>}
      {host.login?.status === 'completed' && <p className="host-login-status completed" role="status"><Check size={16}/>계정 전환 완료{host.login.accountEmail && <strong>{host.login.accountEmail}</strong>}</p>}
      {host.login?.status === 'canceled' && <p className="host-login-status" role="status">로그인이 취소되었습니다.</p>}
      {(loginError || (host.login?.status === 'error' && host.login.error)) && <p className="host-inline-error host-login-error" role="alert">{loginError || host.login.error}</p>}
    </HostModal>}

  </main>;
}
