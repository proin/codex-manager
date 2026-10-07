import React from 'react';
import { RefreshCw } from 'lucide-react';
import './reset-credit-picker.css';

const integer = value => typeof value === 'number' && Number.isFinite(value) ? Math.round(value).toLocaleString('ko-KR') : '—';
const validTime = value => Number.isSafeInteger(value) && value >= 0;

export function resetCreditDate(value, expires = false) {
  if (expires && value == null) return '만료일 없음';
  if (!validTime(value)) return '정보 없음';
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? '정보 없음' : date.toLocaleString('ko-KR', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

export function resetCreditState(credit, currentTime = Date.now() / 1000) {
  if (!credit || typeof credit.id !== 'string' || !credit.id.trim()) return '정보 없음';
  if (credit.resetType !== 'codexRateLimits') return credit.resetType ? '지원하지 않는 초기화권' : '정보 없음';
  if (credit.status === 'used' || credit.status === 'redeemed') return '사용 완료';
  if (credit.status === 'redeeming') return '처리 중';
  if (credit.status === 'expired') return '만료';
  if (credit.status !== 'available') return '정보 없음';
  if (!validTime(credit.grantedAt) || (credit.expiresAt != null && !validTime(credit.expiresAt))) return '정보 없음';
  if (credit.expiresAt != null && credit.expiresAt < credit.grantedAt) return '정보 없음';
  if (credit.expiresAt != null && credit.expiresAt <= currentTime) return '만료';
  if (credit.grantedAt > currentTime) return '사용 기간 전';
  return '사용 가능';
}

export const isResetCreditSelectable = credit => resetCreditState(credit) === '사용 가능';
export const resetCreditTitle = credit => {
  const title = typeof credit?.title === 'string' ? credit.title.trim() : '';
  if (/^full reset$/i.test(title)) return '사용량 초기화권';
  return title && !/^rate[- ]limit reset(?: credit)?$/i.test(title) ? title : '초기화권';
};
const resetCreditDescription = credit => {
  const description = typeof credit?.description === 'string' ? credit.description.trim() : '';
  return /^Thanks for using Codex! You've been granted one free rate limit reset\.$/i.test(description)
    ? 'Codex 사용량을 초기화합니다.' : description;
};

export function ResetCreditPicker({ accounts, selections, pendingIds, refreshing, error, selectable, onSelect, onRefresh }) {
  return <div className="reset-credit-picker">
    <div className="reset-picker-toolbar"><p>계정마다 사용할 초기화권 1개를 선택하십시오.</p><button className="button small" disabled={refreshing} onClick={onRefresh}><RefreshCw size={14} className={refreshing ? 'spin' : ''}/>{refreshing ? '목록 조회 중' : '목록 새로 조회'}</button></div>
    {error && <p className="reset-picker-error" role="alert">{error}</p>}
    {accounts.map(account => {
      const value = account.usage?.rateLimitResetCredits;
      const credits = Array.isArray(value?.credits) ? value.credits.filter(credit => credit && typeof credit === 'object') : null;
      const count = typeof value?.availableCount === 'number' && Number.isFinite(value.availableCount) ? value.availableCount : null;
      const pending = pendingIds.includes(account.id) || account.status === 'loading';
      const enabled = selectable(account);
      const accountMessage = pending ? '목록을 조회하고 있습니다.' : account.status === 'signedOut' ? '로그인 후 초기화권 목록을 조회하십시오.' : account.resetAttempt?.status === 'uncertain' ? '이전 초기화 요청의 결과를 먼저 확인하십시오.' : account.warning || account.error || '';
      return <section key={account.id} className="reset-picker-account" aria-label={`${account.label} 초기화권`}>
        <div className="reset-picker-account-heading"><div><h3>{account.label}</h3><span className="email">{account.email || '로그인 전'}</span></div><div className="reset-picker-count"><span>보유</span><strong>{integer(count)}</strong>{count !== null && <span>개</span>}</div></div>
        {accountMessage && <p className={account.error || account.warning ? 'reset-picker-error' : 'reset-picker-note'}>{accountMessage}</p>}
        {credits === null ? <p className="reset-picker-empty">초기화권 목록 정보가 제공되지 않았습니다.</p> : credits.length === 0 ? <p className="reset-picker-empty">{count > 0 ? '보유 개수와 목록이 일치하지 않습니다. 목록을 다시 조회하십시오.' : '보유한 초기화권이 없습니다.'}</p> : <>
          <div className="reset-picker-table-scroll"><table aria-label={`${account.label} 초기화권 목록`}><thead><tr><th className="reset-picker-radio-col">선택</th><th>초기화권</th><th className="reset-picker-date-col">발급 일시</th><th className="reset-picker-date-col">만료 일시</th><th className="reset-picker-status-col">상태</th></tr></thead><tbody>{credits.map((credit, index) => {
            const status = resetCreditState(credit);
            const disabled = !enabled || status !== '사용 가능';
            return <tr key={`${credit.id || 'unknown'}-${index}`} className={disabled ? 'reset-picker-unavailable' : ''}>
              <td className="reset-picker-radio-col"><input type="radio" name={`reset-credit-${account.id}`} aria-label={`${resetCreditTitle(credit)} 선택 (${credit.id || index + 1})`} checked={Boolean(credit.id) && selections[account.id] === credit.id} disabled={disabled} onChange={() => onSelect(account.id, credit.id)}/></td>
              <td><strong className="reset-picker-title">{resetCreditTitle(credit)}</strong>{resetCreditDescription(credit) && <small>{resetCreditDescription(credit)}</small>}</td>
              <td className="reset-picker-date">{resetCreditDate(credit.grantedAt)}</td><td className="reset-picker-date">{resetCreditDate(credit.expiresAt, true)}</td><td><span className={`reset-picker-status ${status === '사용 가능' ? 'available' : ''}`}>{status}</span></td>
            </tr>;
          })}</tbody></table></div>
          {count !== null && count > credits.length && <p className="reset-picker-note">일부 초기화권만 목록에 표시됩니다. 표시된 초기화권 중에서 선택하십시오.</p>}
        </>}
      </section>;
    })}
    {!accounts.length && <p className="reset-picker-empty">조회할 계정이 없습니다.</p>}
  </div>;
}
