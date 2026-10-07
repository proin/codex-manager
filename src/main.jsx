import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ExternalLink, Loader2, MoreHorizontal, Plus, RefreshCw, Server, Users, X } from 'lucide-react';
import { createDemoBridge } from './demo';
import { AccountDetails } from './AccountDetails';
import { HostManager } from './HostManager';
import { createDemoHostBridge } from './host-demo';
import { ResetCreditPicker, isResetCreditSelectable, resetCreditDate, resetCreditTitle } from './ResetCreditPicker';
import './styles.css';

const isDemo = new URLSearchParams(location.search).get('demo') === '1';
const bridge = isDemo ? createDemoBridge() : window.accountManager;
const hostBridge = isDemo ? createDemoHostBridge() : window.hostManager;
const emptyState = { accounts: [], refresh: { running: false }, runtime: { available: false } };
const integer = value => typeof value === 'number' && Number.isFinite(value) ? Math.round(value).toLocaleString('ko-KR') : '—';
const dateText = value => {
  if (!value) return '—';
  const date = new Date(typeof value === 'number' ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
};
function buckets(account) {
  const values = Object.values(account.usage?.rateLimitsByLimitId || {}).filter(Boolean);
  return values.length ? values : account.usage?.rateLimits ? [account.usage.rateLimits] : [];
}
function creditBalance(account) {
  const all = buckets(account);
  const credits = (all.find(item => item.limitId === 'codex') || all[0])?.credits ?? account.usage?.rateLimits?.credits;
  if (!credits) return '—';
  if (credits.unlimited) return '무제한';
  if (credits.balance != null && credits.balance !== '') {
    const number = Number(credits.balance);
    return integer(number);
  }
  return credits.hasCredits === false ? '0' : '—';
}
const resetCount = account => {
  const value = account.usage?.rateLimitResetCredits?.availableCount;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};
const busy = account => ['loading', 'loggingIn'].includes(account.status) || account.resetAttempt?.status === 'pending';
const needsRead = account => account.resetAttempt?.status === 'completed' && account.resetAttempt.needsRefresh;
const canReset = account => !busy(account) && !account.warning && !account.error && !needsRead(account) && account.status === 'ready' && account.resetAttempt?.status !== 'uncertain' && resetCount(account) > 0;
const canOpenResetList = account => !['loggingIn', 'signedOut'].includes(account.status) && account.resetAttempt?.status !== 'pending';
const canRetry = account => account.resetAttempt?.status === 'uncertain' && !busy(account);
const period = window => {
  const mins = window?.windowDurationMins;
  if (!mins) return '사용량';
  if (mins === 10080) return '주간';
  if (mins === 1440) return '일간';
  return mins % 60 !== 0 ? `${integer(mins)}분` : mins % 1440 === 0 ? `${integer(mins / 1440)}일` : `${integer(mins / 60)}시간`;
};

function Modal({ title, children, footer, onClose, alert = false, wide = false }) {
  const ref = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const targets = () => [...ref.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')];
    targets()[0]?.focus();
    const keydown = event => {
      if (event.key === 'Escape') close.current();
      if (event.key !== 'Tab') return;
      const items = targets();
      if (!items.length) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1).focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}><section ref={ref} className={`modal ${wide ? 'wide' : ''}`} role={alert ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby="dialog-title">
    <div className="modal-heading"><h2 id="dialog-title">{title}</h2><button className="icon-button" aria-label="닫기" onClick={onClose}><X size={18}/></button></div>
    <div className="modal-body">{children}</div><div className="modal-footer">{footer}</div>
  </section></div>;
}

function Usage({ account }) {
  const all = buckets(account);
  return <div className="usage-list">{(all.length ? all : [{}]).map((bucket, index) => <div key={bucket.limitId || index}>
    {all.length > 1 && <div className="bucket-name">{bucket.limitName || bucket.limitId || 'Codex'}</div>}
    <div className="usage-windows">{[bucket.primary, bucket.secondary].map((window, i) => {
      const value = typeof window?.usedPercent === 'number' && Number.isFinite(window.usedPercent) ? Math.max(0, Math.min(100, 100 - window.usedPercent)) : null;
      return <div className="usage-cell" key={i}><div className={`usage-value ${value !== null && value <= 15 ? 'low' : ''}`}><span>{period(window)}</span><strong>{value === null ? '—' : `${integer(value)}%`}</strong>{value !== null && <span>남음</span>}</div>{window?.resetsAt > 0 && <small>{dateText(window.resetsAt)} 갱신</small>}</div>;
    })}</div>
  </div>)}</div>;
}

function AccountApp() {
  const [state, setState] = useState(emptyState);
  const [selected, setSelected] = useState(new Set());
  const [modal, setModal] = useState(null);
  const [label, setLabel] = useState('');
  const [method, setMethod] = useState('chatgpt');
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState('');
  const [menu, setMenu] = useState(null);
  const apply = snapshot => {
    if (!snapshot?.accounts) return;
    setState({ ...emptyState, ...snapshot });
    setModal(previous => {
      if (!previous?.readPendingIds?.length) return previous;
      const pendingIds = previous.readPendingIds.filter(id => {
        const account = snapshot.accounts.find(item => item.id === id);
        return account && account.lastUpdated === previous.readBaseline[id] && !['error', 'signedOut'].includes(account.status);
      });
      return pendingIds.length === previous.readPendingIds.length ? previous : { ...previous, readPendingIds: pendingIds };
    });
  };
  const run = async (action, close = false) => {
    try { const result = await action(); apply(result); if (close) setModal(null); return result; }
    catch (error) { setNotice(error.message || '작업을 완료하지 못했습니다.'); return null; }
  };
  useEffect(() => {
    if (!bridge) return;
    run(() => bridge.getState());
    return bridge.onState(apply);
  }, []);
  useEffect(() => {
    setSelected(previous => new Set([...previous].filter(id => state.accounts.some(account => account.id === id))));
    if (modal?.type === 'login' && state.accounts.some(account => account.id === modal.id && account.status === 'ready' && !account.login)) setModal(null);
    if (['resetPicker', 'reset'].includes(modal?.type)) {
      setModal(previous => {
        if (!['resetPicker', 'reset'].includes(previous?.type)) return previous;
        const selections = Object.fromEntries(Object.entries(previous.selections || {}).filter(([id, creditId]) => {
          const account = state.accounts.find(item => item.id === id);
          return account && account.email === previous.accountEmails[id] && (account.usage?.rateLimitResetCredits?.credits || []).some(credit => credit.id === creditId && isResetCreditSelectable(credit));
        }));
        return Object.keys(selections).length === Object.keys(previous.selections || {}).length ? previous : { ...previous, selections };
      });
    }
  }, [state.accounts]);
  useEffect(() => {
    if (!menu) return;
    const close = event => { if (event.key === 'Escape' || (event.type === 'click' && !event.target.closest('.account-actions'))) setMenu(null); };
    document.addEventListener('click', close); document.addEventListener('keydown', close);
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', close); };
  }, [menu]);
  if (!bridge) return <main className="launch-screen"><h1>Codex Account Manager</h1><p>계정 관리 기능은 데스크톱 앱에서 사용할 수 있습니다.</p><code>npm run dev</code></main>;

  const accounts = state.accounts;
  const selectedAccounts = accounts.filter(account => selected.has(account.id));
  const eligible = selectedAccounts.filter(canOpenResetList);
  const target = modal?.id ? accounts.find(account => account.id === modal.id) : null;
  const resetTargets = accounts.filter(account => modal?.ids?.includes(account.id));
  const pickerTargets = accounts.filter(account => modal?.pickerIds?.includes(account.id));
  const retry = modal?.type === 'retry';
  const canSelectReset = account => canReset(account) && !(modal?.readPendingIds || []).includes(account.id) && account.email === modal?.accountEmails?.[account.id];
  const selectedCredit = account => account.usage?.rateLimitResetCredits?.credits?.find(credit => credit.id === modal?.selections?.[account.id]);
  const selectedResetAccounts = pickerTargets.filter(account => canSelectReset(account) && isResetCreditSelectable(selectedCredit(account)));
  const confirmEnabled = resetTargets.length > 0 && resetTargets.length === modal?.ids?.length && resetTargets.every(retry ? canRetry : account => canSelectReset(account) && isResetCreditSelectable(selectedCredit(account)));
  const openAdd = () => { setLabel(''); setMethod('chatgpt'); setModal({ type: 'add' }); };
  const startLogin = async id => { setModal({ type: 'login', id }); await run(() => bridge.login(id, method)); };
  const refreshResetList = async picker => {
    const readBaseline = Object.fromEntries(accounts.filter(account => picker.pickerIds.includes(account.id)).map(account => [account.id, account.lastUpdated]));
    setModal(previous => previous?.session === picker.session ? { ...previous, refreshing: true, error: '', readBaseline, readPendingIds: [...picker.pickerIds] } : previous);
    try {
      const result = await bridge.refreshAccounts(picker.pickerIds);
      if (!result?.accounts) throw new Error('초기화권 목록을 조회하지 못했습니다.');
      apply(result);
      setModal(previous => previous?.session === picker.session ? { ...previous, refreshing: false, readPendingIds: [] } : previous);
    } catch (error) {
      setModal(previous => previous?.session === picker.session ? { ...previous, refreshing: false, error: error.message || '초기화권 목록을 조회하지 못했습니다.' } : previous);
    }
  };
  const openResetList = ids => {
    const picker = { type: 'resetPicker', ids, pickerIds: ids, selections: {}, session: crypto.randomUUID(), accountEmails: Object.fromEntries(accounts.filter(account => ids.includes(account.id)).map(account => [account.id, account.email])), refreshing: true, readPendingIds: ids, readBaseline: Object.fromEntries(accounts.filter(account => ids.includes(account.id)).map(account => [account.id, account.lastUpdated])) };
    setMenu(null); setModal(picker); refreshResetList(picker);
  };
  const addAccount = async event => {
    event.preventDefault(); setWorking(true);
    const previous = new Set(accounts.map(account => account.id));
    const result = await run(() => bridge.addAccount(label.trim() || '새 계정'));
    const added = result?.accounts.find(account => !previous.has(account.id));
    if (added) await startLogin(added.id);
    setWorking(false);
  };
  const confirmReset = async () => {
    if (!confirmEnabled || working) return;
    if (!retry && !resetTargets.every(account => canSelectReset(account) && isResetCreditSelectable(selectedCredit(account)))) {
      setModal(previous => ({ ...previous, type: 'resetPicker', ids: previous.pickerIds }));
      return;
    }
    setWorking(true);
    const ids = resetTargets.map(account => account.id);
    await run(() => retry ? bridge.resetAccounts(ids) : bridge.resetAccounts(ids, Object.fromEntries(ids.map(id => [id, modal.selections[id]]))), true);
    setWorking(false);
  };

  return <main className="account-app">
    <header className="toolbar"><h1>계정 <span aria-hidden="true">{accounts.length}</span></h1><div className="toolbar-actions">
      {isDemo && <span className="demo-badge">예시 데이터</span>}
      <button className="button" disabled={!accounts.length || state.refresh.running} onClick={() => run(() => bridge.refreshAccounts())}><RefreshCw size={15} className={state.refresh.running ? 'spin' : ''}/>{state.refresh.running ? `${state.refresh.done}/${state.refresh.total} 조회 중` : '전체 조회'}</button>
      <button className="button primary" onClick={openAdd}><Plus size={16}/>계정 추가</button>
    </div></header>
    {notice && <div className="notice" role="alert"><span>{notice}</span><button className="icon-button" aria-label="알림 닫기" onClick={() => setNotice('')}><X size={16}/></button></div>}
    {!state.runtime.available && <div className="runtime-notice"><span>{state.runtime.error || 'Codex 실행 파일이 필요합니다.'}</span><button className="button" onClick={() => run(() => bridge.chooseCodexBinary())}>실행 파일 선택</button></div>}
    {selected.size > 0 && <div className="selection-bar"><span>{selected.size}개 선택</span><button className="text-button" disabled={selectedAccounts.every(busy)} onClick={() => run(() => bridge.refreshAccounts([...selected]))}>선택 조회</button><button className="text-button" disabled={!eligible.length} onClick={() => openResetList(eligible.map(account => account.id))}>초기화권 사용{eligible.length > 0 && ` (${eligible.length})`}</button><button className="text-button deselect" onClick={() => setSelected(new Set())}>선택 해제</button></div>}
    <div className="table-scroll"><table aria-label="계정 목록"><thead><tr>
      <th className="check-col"><input type="checkbox" aria-label="모든 계정 선택" disabled={!accounts.length} checked={accounts.length > 0 && selected.size === accounts.length} onChange={() => setSelected(selected.size === accounts.length ? new Set() : new Set(accounts.map(account => account.id)))}/></th>
      <th className="account-col">계정</th><th className="usage-col numeric">사용량</th><th className="balance-col numeric">크레딧</th><th className="reset-col numeric">초기화권</th><th className="actions-col">작업</th>
    </tr></thead><tbody>{accounts.map(account => <tr key={account.id} className={selected.has(account.id) ? 'selected' : ''}>
      <td><input type="checkbox" aria-label={`${account.label} 선택`} checked={selected.has(account.id)} onChange={() => setSelected(previous => { const next = new Set(previous); next.has(account.id) ? next.delete(account.id) : next.add(account.id); return next; })}/></td>
      <td className="account-col"><button className="account-info" aria-label={`${account.label} 상세 통계`} onClick={() => { setMenu(null); setModal({ type: 'details', id: account.id }); }}><span className="account-name"><strong>{account.label}</strong>{account.planType && <span className="plan">{account.planType}</span>}</span><span className="email">{account.email || '로그인 전'}</span></button>
        <small className="account-status">{account.status === 'loading' ? '조회 중' : account.status === 'loggingIn' ? '로그인 중' : account.status === 'signedOut' ? '로그인 필요' : account.lastUpdated ? `${dateText(account.lastUpdated)} 조회` : '조회 전'}</small>
        {(account.error || account.warning) && <p className="row-error">{account.error || account.warning}</p>}
        {account.resetAttempt?.message && <p className="row-result" role="status">{account.resetAttempt.message}</p>}
      </td>
      <td className="numeric"><Usage account={account}/></td>
      <td className="numeric"><span className="credit-balance">{creditBalance(account)}</span>{creditBalance(account) === '—' && <small className="muted">정보 없음</small>}</td>
      <td className="numeric"><div className="reset-cell"><button className="credit-value reset-list-entry" aria-label={`${account.label} 초기화권 목록`} disabled={!canOpenResetList(account)} onClick={() => openResetList([account.id])}><b>{integer(resetCount(account))}</b>{resetCount(account) !== null && <span>개</span>}</button>
        {account.resetAttempt?.status === 'pending' ? <button className="button small" disabled>적용 중</button>
          : needsRead(account) ? <button className="button small" disabled={busy(account)} onClick={() => run(() => bridge.refreshAccounts([account.id]))}>사용량 다시 조회</button>
            : account.resetAttempt?.status === 'uncertain' ? <button className="button small" disabled={!canRetry(account)} onClick={() => setModal({ type: 'retry', ids: [account.id] })}>결과 다시 확인</button>
              : <button className="button small" disabled={!canOpenResetList(account)} onClick={() => openResetList([account.id])}>초기화권 사용</button>}
      </div></td>
      <td><div className="account-actions">{['signedOut', 'loggingIn'].includes(account.status) ? <button className="text-button" onClick={() => account.login ? setModal({ type: 'login', id: account.id }) : startLogin(account.id)}>로그인</button> : <button className="icon-button" aria-label={`${account.label} 사용량 조회`} disabled={busy(account)} onClick={() => run(() => bridge.refreshAccounts([account.id]))}><RefreshCw size={15} className={account.status === 'loading' ? 'spin' : ''}/></button>}
        <button className="icon-button" aria-label={`${account.label} 메뉴`} aria-expanded={menu === account.id} onClick={() => setMenu(menu === account.id ? null : account.id)}><MoreHorizontal size={18}/></button>
        {menu === account.id && <div className="dropdown"><button onClick={() => { setLabel(account.label); setModal({ type: 'rename', id: account.id }); setMenu(null); }}>이름 변경</button><button onClick={() => { startLogin(account.id); setMenu(null); }}>다시 로그인</button><button className="danger-text" onClick={() => { setModal({ type: 'remove', id: account.id }); setMenu(null); }}>계정 삭제</button></div>}
      </div></td>
    </tr>)}{!accounts.length && <tr><td colSpan={6} className="empty">등록된 계정이 없습니다.</td></tr>}</tbody></table></div>

    {modal?.type === 'details' && target && <Modal wide title={`${target.label} 상세 통계`} onClose={() => setModal(null)} footer={<button className="button" onClick={() => setModal(null)}>닫기</button>}><AccountDetails account={target} bridge={bridge}/></Modal>}
    {modal?.type === 'add' && <Modal title="계정 추가" onClose={() => !working && setModal(null)} footer={<><button className="button" disabled={working} onClick={() => setModal(null)}>취소</button><button form="add-form" type="submit" className="button primary" disabled={working || !state.runtime.available}>로그인 시작</button></>}>
      <form id="add-form" onSubmit={addAccount}><label htmlFor="account-label">계정 이름</label><input id="account-label" maxLength={60} placeholder="예: 개인 계정" value={label} onChange={event => setLabel(event.target.value)}/><label htmlFor="login-method">로그인 방식</label><select id="login-method" value={method} onChange={event => setMethod(event.target.value)}><option value="chatgpt">브라우저 로그인</option><option value="chatgptDeviceCode">기기 코드로 로그인</option></select></form>
    </Modal>}
    {modal?.type === 'login' && <Modal title="계정 로그인" onClose={() => setModal(null)} footer={<><button className="button" onClick={() => run(() => bridge.cancelLogin(modal.id), true)}>로그인 취소</button>{target?.login?.url && <button className="button primary" onClick={() => run(() => bridge.openLogin(modal.id))}><ExternalLink size={15}/>로그인 페이지 열기</button>}</>}>
      <p>{target?.error || '브라우저에서 사용할 계정으로 로그인하십시오.'}</p>{target?.status !== 'error' && <Loader2 className="spin login-spinner" size={22}/>}{target?.login?.userCode && <div className="device-code" aria-label="로그인 코드">{target.login.userCode}</div>}
    </Modal>}
    {modal?.type === 'resetPicker' && <Modal wide title="초기화권 목록" onClose={() => setModal(null)} footer={<><button className="button" onClick={() => setModal(null)}>취소</button><button className="button primary" disabled={!selectedResetAccounts.length} onClick={() => setModal(previous => ({ ...previous, type: 'reset', ids: selectedResetAccounts.map(account => account.id) }))}>선택 완료</button></>}>
      <ResetCreditPicker accounts={pickerTargets} selections={modal.selections} pendingIds={modal.readPendingIds || []} refreshing={modal.refreshing} error={modal.error} selectable={canSelectReset} onSelect={(id, creditId) => setModal(previous => ({ ...previous, selections: { ...previous.selections, [id]: creditId } }))} onRefresh={() => refreshResetList(modal)}/>
    </Modal>}
    {['reset', 'retry'].includes(modal?.type) && <Modal alert title={retry ? '초기화 결과 확인' : '초기화권 사용 확인'} onClose={() => !working && setModal(null)} footer={<><button className="button" disabled={working} onClick={() => setModal(null)}>취소</button><button className="button primary" disabled={working || !confirmEnabled} onClick={confirmReset}>{working ? '처리 중' : retry ? '계속' : '사용'}</button></>}>
      <p>{retry ? '이전에 보낸 초기화 요청을 다시 처리합니다. 같은 요청 번호를 사용하며, 아직 처리되지 않았다면 초기화권이 사용됩니다.' : '선택한 계정마다 초기화권 1개를 사용합니다.'}</p>
      <div className="reset-account-list">{resetTargets.map(account => <div key={account.id}><strong>{account.label}</strong><span>{account.email}</span>{!retry && selectedCredit(account) && <div className="reset-confirm-credit"><span className="reset-confirm-title">{resetCreditTitle(selectedCredit(account))}</span><div className="reset-confirm-date"><span>발급</span><span>{resetCreditDate(selectedCredit(account).grantedAt)}</span></div><div className="reset-confirm-date"><span>만료</span><span>{resetCreditDate(selectedCredit(account).expiresAt, true)}</span></div></div>}</div>)}</div>
      {!retry && <p className="muted">사용한 초기화권은 되돌릴 수 없습니다.</p>}
      {!retry && <button className="text-button" disabled={working} onClick={() => setModal(previous => ({ ...previous, type: 'resetPicker', ids: previous.pickerIds }))}>목록으로 돌아가기</button>}
    </Modal>}
    {modal?.type === 'rename' && <Modal title="계정 이름 변경" onClose={() => setModal(null)} footer={<><button className="button" onClick={() => setModal(null)}>취소</button><button className="button primary" onClick={() => run(() => bridge.renameAccount(modal.id, label.trim() || '새 계정'), true)}>저장</button></>}><label htmlFor="rename-label">계정 이름</label><input id="rename-label" value={label} maxLength={60} onChange={event => setLabel(event.target.value)}/></Modal>}
    {modal?.type === 'remove' && <Modal title="계정 삭제" onClose={() => setModal(null)} footer={<><button className="button" onClick={() => setModal(null)}>취소</button><button className="button danger" onClick={() => run(() => bridge.removeAccount(modal.id), true)}>계정 삭제</button></>}><p><strong>{target?.label}</strong>을 목록에서 삭제합니다. 이 앱에 저장된 해당 계정의 로그인 정보도 삭제됩니다.</p></Modal>}
  </main>;
}

function App() {
  const [page, setPage] = useState('accounts');
  return <div className="manager-layout">
    <aside className="manager-sidebar">
      <div className="manager-brand"><span>Codex</span><small>Account Manager</small></div>
      <nav aria-label="관리 메뉴">
        <button className={page === 'accounts' ? 'active' : ''} aria-current={page === 'accounts' ? 'page' : undefined} onClick={() => setPage('accounts')}><Users size={17}/><span>계정관리</span></button>
        <button className={page === 'hosts' ? 'active' : ''} aria-current={page === 'hosts' ? 'page' : undefined} onClick={() => setPage('hosts')}><Server size={17}/><span>호스트관리</span></button>
      </nav>
    </aside>
    <div className="manager-content">{page === 'accounts' ? <AccountApp/> : <HostManager bridge={hostBridge} isDemo={isDemo}/>}</div>
  </div>;
}

createRoot(document.getElementById('root')).render(<App/>);
