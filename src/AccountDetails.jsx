import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import './account-details.css';

const DAY = 86400000;
const finite = value => typeof value === 'number' && Number.isFinite(value);
export const integerText = value => finite(value) ? Math.round(value).toLocaleString('ko-KR') : '—';
const tokenText = value => {
  if (!finite(value) || value < 0) return '—';
  if (value > 0 && value < 10000) return '<0.01M';
  return `${(value / 1000000).toLocaleString('ko-KR', { maximumFractionDigits: 2 })}M`;
};
const dayKey = value => new Date(value).toISOString().slice(0, 10);
const todayTime = today => Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
const parseDay = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && dayKey(time) === value ? time : null;
};
const groupKey = (time, grouping) => {
  const date = new Date(time);
  if (grouping === 'month') return `${dayKey(time).slice(0, 7)}-01`;
  if (grouping === 'week') return dayKey(time - ((date.getUTCDay() + 6) % 7) * DAY);
  return dayKey(time);
};
const shortDate = value => value ? `${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))}` : '—';
const dateTime = value => {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
};

// Keep unknown dates null. Weekly and monthly totals include returned days only.
export function aggregateDailyUsage(buckets, days, grouping, today = new Date()) {
  const end = todayTime(today);
  const start = end - (days - 1) * DAY;
  const daily = new Map();
  for (const bucket of buckets || []) {
    const time = parseDay(bucket?.startDate);
    if (time === null || time < start || time > end || !finite(bucket.tokens) || bucket.tokens < 0) continue;
    daily.set(bucket.startDate, bucket.tokens);
  }
  const groups = new Map();
  for (let time = start; time <= end; time += DAY) {
    const key = groupKey(time, grouping);
    const day = dayKey(time);
    const value = daily.get(day);
    const item = groups.get(key) || { key, startDate: day, endDate: day, tokens: null, recordedDays: 0, days: 0 };
    item.endDate = day;
    item.days += 1;
    if (finite(value)) { item.tokens = (item.tokens ?? 0) + value; item.recordedDays += 1; }
    groups.set(key, item);
  }
  return [...groups.values()].map(item => ({ ...item, label: grouping === 'day' ? item.startDate : grouping === 'month' ? item.key.slice(0, 7) : `${item.startDate} ~ ${item.endDate}` }));
}

const windowName = window => {
  const minutes = window?.windowDurationMins;
  if (!finite(minutes) || minutes <= 0) return '사용량';
  if (minutes % 1440 === 0) return `${integerText(minutes / 1440)}일`;
  if (minutes % 60 === 0) return `${integerText(minutes / 60)}시간`;
  return `${integerText(minutes)}분`;
};

function TrendChart({ points, valueKey, label, percent = false, line = false }) {
  const values = points.map(point => point[valueKey]).filter(finite);
  const maximum = percent ? 100 : Math.max(1, ...values);
  const valueLabel = value => percent ? `${integerText(value)}%` : tokenText(value);
  const width = 720, height = 184, left = Math.min(124, Math.max(60, valueLabel(maximum).length * 7 + 18)), right = 16, top = 15, bottom = 32;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const step = plotWidth / Math.max(points.length, 1);
  const firstTime = Date.parse(points[0]?.time), lastTime = Date.parse(points.at(-1)?.time);
  const x = index => line && lastTime > firstTime ? left + 4 + (plotWidth - 8) * ((Date.parse(points[index].time) - firstTime) / (lastTime - firstTime)) : left + step * (index + .5);
  const y = value => top + plotHeight * (1 - value / maximum);
  const tickValues = [...new Set([maximum, maximum / 2, 0].map(value => Math.round(value)))];
  const segments = [];
  if (line) {
    let segment = [];
    points.forEach((point, index) => {
      if (!finite(point[valueKey])) { if (segment.length) segments.push(segment); segment = []; }
      else segment.push(`${x(index)},${y(point[valueKey])}`);
    });
    if (segment.length) segments.push(segment);
  }
  const labelIndexes = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])].filter(index => index >= 0);
  return <svg className="details-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
    <title>{label}</title>
    {tickValues.map(value => <g key={value}><line className="chart-grid" x1={left} x2={width - right} y1={y(value)} y2={y(value)}/><text className="chart-label" x={left - 10} y={y(value) + 4} textAnchor="end">{valueLabel(value)}</text></g>)}
    {segments.map((segment, index) => <polyline key={index} className="chart-line" points={segment.join(' ')}/>)}
    {points.map((point, index) => finite(point[valueKey]) ? line
      ? <circle className="chart-point" key={point.key} cx={x(index)} cy={y(point[valueKey])} r={3}><title>{point.label}: {integerText(point[valueKey])}%</title></circle>
      : <rect className="chart-bar" key={point.key} x={x(index) - Math.min(28, step * .62) / 2} y={y(point[valueKey])} width={Math.min(28, step * .62)} height={Math.max(point[valueKey] === 0 ? 1 : 2, top + plotHeight - y(point[valueKey]))} rx={2}><title>{point.label}: {tokenText(point[valueKey])} 토큰</title></rect>
      : <text className="chart-missing" key={point.key} x={x(index)} y={top + plotHeight - 4} textAnchor="middle">—</text>)}
    {labelIndexes.map(index => <text className="chart-label" key={index} x={index === 0 ? left : index === points.length - 1 ? width - right : x(index)} y={height - 8} textAnchor={index === 0 ? 'start' : 'end'}>{shortDate(points[index].startDate)}</text>)}
  </svg>;
}

const resetOutcome = { reset: '사용 완료', alreadyRedeemed: '사용 처리 확인', nothingToReset: '초기화할 사용량 없음', noCredit: '초기화권 없음', uncertain: '결과 미확정' };
const resetDateLabel = item => item.timeKind === 'completed' ? item.usedCount === 1 ? '사용 일시' : '처리 일시' : item.timeKind === 'confirmed' ? '처리 확인' : '요청 일시';

function ResetHistory({ resets = [] }) {
  const rows = [...resets].sort((a, b) => (Date.parse(b.time) || 0) - (Date.parse(a.time) || 0));
  return <section className="details-section" aria-labelledby="reset-history-title">
    <div className="details-section-heading"><h3 id="reset-history-title">초기화권 사용</h3><span className="details-note">이 앱에 저장된 초기화 기록입니다.</span></div>
    {rows.length ? <div className="details-table-scroll reset-history-scroll"><table className="details-table" aria-label="초기화권 사용 기록"><thead><tr><th className="details-date">일시</th><th>상태</th><th className="details-number">사용 수량</th></tr></thead><tbody>{rows.map((item, index) => <tr key={item.id || index}>
      <td className="details-date"><time dateTime={item.time || undefined}>{dateTime(item.time)}</time><small>{resetDateLabel(item)}</small></td><td>{resetOutcome[item.outcome] || '결과 미확정'}</td><td className="details-number">{integerText(item.usedCount)}{finite(item.usedCount) ? '개' : ''}</td>
    </tr>)}</tbody></table></div> : <p className="details-empty">초기화권 사용 기록이 없습니다.</p>}
  </section>;
}

export function AccountDetails({ account, bridge }) {
  const [details, setDetails] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [days, setDays] = useState(30);
  const [grouping, setGrouping] = useState('day');
  const [view, setView] = useState('tokens');
  const [selectedWindow, setSelectedWindow] = useState('');
  const request = useRef(0);
  const read = useCallback(async cached => {
    const version = ++request.current;
    const active = () => request.current === version;
    const sameIdentity = value => value?.accountId === account.id && String(value.email || '').trim().toLowerCase() === String(account.email || '').trim().toLowerCase();
    setRefreshing(true); setError('');
    if (cached) {
      try {
        const value = await bridge.getAccountDetails(account.id);
        if (active() && sameIdentity(value)) setDetails(value);
      } catch { /* A fresh request can recover from a failed cache read. */ }
    }
    if (!active()) return;
    try {
      const value = await bridge.refreshAccountDetails(account.id);
      if (active() && sameIdentity(value)) setDetails(value);
    } catch (cause) {
      if (active()) setError(cause?.message || '요청을 완료하지 못했습니다.');
    } finally {
      if (active()) setRefreshing(false);
    }
  }, [account.id, account.email, bridge]);
  useEffect(() => {
    setDetails(null); setView('tokens'); setSelectedWindow('');
    read(true);
    return () => { request.current += 1; };
  }, [read]);

  const buckets = details?.tokenUsage?.dailyUsageBuckets;
  const tokenPoints = useMemo(() => aggregateDailyUsage(buckets, days, grouping), [buckets, days, grouping]);
  const hasTokens = tokenPoints.some(item => finite(item.tokens));
  const tokenTotal = hasTokens ? tokenPoints.reduce((sum, item) => sum + (item.tokens ?? 0), 0) : null;
  const summary = details?.tokenUsage?.summary;
  const snapshotOptions = useMemo(() => {
    const options = new Map();
    for (const snapshot of details?.snapshots || []) for (const bucket of snapshot.buckets || []) for (const window of ['primary', 'secondary']) {
      if (!bucket[window]) continue;
      const key = `${bucket.limitId || 'codex'}:${window}`;
      options.set(key, { key, limitId: bucket.limitId, window, label: `${bucket.limitName || bucket.limitId || 'Codex'} · ${windowName(bucket[window])}` });
    }
    return [...options.values()];
  }, [details?.snapshots]);
  const chosenWindow = snapshotOptions.find(option => option.key === selectedWindow) || snapshotOptions[0];
  const quotaPoints = useMemo(() => {
    const end = new Date(); end.setHours(23, 59, 59, 999);
    const start = new Date(end); start.setDate(start.getDate() - days + 1); start.setHours(0, 0, 0, 0);
    return (details?.snapshots || []).filter(item => { const time = Date.parse(item.time); return time >= start.getTime() && time <= end.getTime(); }).sort((a, b) => Date.parse(a.time) - Date.parse(b.time)).map((item, index) => {
      const bucket = item.buckets?.find(bucket => bucket.limitId === chosenWindow?.limitId);
      const used = bucket?.[chosenWindow?.window]?.usedPercent;
      return { ...item, key: `${item.time}:${index}`, startDate: item.time.slice(0, 10), label: dateTime(item.time), remaining: finite(used) ? Math.max(0, Math.min(100, 100 - used)) : null };
    });
  }, [details?.snapshots, days, chosenWindow?.key]);

  return <div className="account-details" aria-busy={refreshing}>
    <div className="details-topline"><span className="details-email">{details?.email || account.email}</span><button className="button small" aria-label="통계 새로 조회" disabled={refreshing} onClick={() => read(false)}><RefreshCw size={14} className={refreshing ? 'spin' : ''}/>{refreshing ? '조회 중' : '새로 조회'}</button></div>
    {error && <p className="details-error" role="alert">통계를 조회하지 못했습니다. {error}</p>}
    {details?.usageError && <p className="details-error" role="alert">사용량을 조회하지 못했습니다. {details.usageError}</p>}
    {!details && refreshing ? <p className="details-empty" role="status">통계를 조회하고 있습니다.</p> : !details ? <p className="details-empty">통계 기록이 없습니다.</p> : <>
      <div className="details-controls"><div className="details-tabs" role="tablist" aria-label="통계 항목"><button id="tokens-tab" role="tab" aria-selected={view === 'tokens'} aria-controls="tokens-panel" onClick={() => setView('tokens')}>사용량 추이</button><button id="quota-tab" role="tab" aria-selected={view === 'quota'} aria-controls="quota-panel" onClick={() => setView('quota')}>잔여량 변화</button></div><div className="details-filters">
        <select aria-label="조회 기간" value={days} onChange={event => setDays(Number(event.target.value))}><option value={7}>최근 7일</option><option value={30}>최근 30일</option><option value={90}>최근 90일</option></select>
        {view === 'tokens' && <select aria-label="표시 간격" value={grouping} onChange={event => setGrouping(event.target.value)}><option value="day">일별</option><option value="week">주별</option><option value="month">월별</option></select>}
      </div></div>
      {view === 'tokens' ? <section id="tokens-panel" role="tabpanel" aria-labelledby="tokens-tab">
        <dl className="details-summary"><div><dt>기간 사용량</dt><dd>{tokenText(tokenTotal)}<small>토큰</small></dd></div><div><dt>전체 사용량</dt><dd>{tokenText(summary?.lifetimeTokens)}<small>토큰</small></dd></div><div><dt>하루 최대 사용량</dt><dd>{tokenText(summary?.peakDailyTokens)}<small>토큰</small></dd></div><div><dt>연속 사용</dt><dd>{integerText(summary?.currentStreakDays)}<small>일</small></dd></div><div><dt>최장 연속 사용</dt><dd>{integerText(summary?.longestStreakDays)}<small>일</small></dd></div><div><dt>최장 실행 시간</dt><dd>{integerText(summary?.longestRunningTurnSec)}<small>초</small></dd></div></dl>
        {hasTokens ? <><TrendChart points={tokenPoints} valueKey="tokens" label="기간별 토큰 사용량 그래프"/><p className="details-note">1M = 100만 토큰 · 기록이 없는 날짜는 —로 표시합니다.{grouping !== 'day' ? ' 조회된 날짜의 사용량을 합산합니다.' : ''}</p><div className="details-table-scroll token-history-scroll"><table className="details-table" aria-label="기간별 사용량"><thead><tr><th className="details-date">{grouping === 'day' ? '날짜' : '기간'}</th><th className="details-number">사용량 (토큰)</th>{grouping !== 'day' && <th className="details-number">기록된 날짜</th>}</tr></thead><tbody>{[...tokenPoints].reverse().map(item => <tr key={item.key}><td className="details-date">{item.label}</td><td className="details-number">{tokenText(item.tokens)}</td>{grouping !== 'day' && <td className="details-number">{integerText(item.recordedDays)} / {integerText(item.days)}일</td>}</tr>)}</tbody></table></div></> : <p className="details-empty">{Array.isArray(buckets) ? '이 기간의 사용량 기록이 없습니다.' : '사용량 정보가 없습니다.'}</p>}
        {details.usageFetchedAt && <p className="details-updated">사용량 조회 <time dateTime={details.usageFetchedAt}>{dateTime(details.usageFetchedAt)}</time></p>}
      </section> : <section id="quota-panel" role="tabpanel" aria-labelledby="quota-tab">
        <div className="quota-heading"><p className="details-note">{details.trackingStartedAt ? `${dateTime(details.trackingStartedAt)}부터 이 앱에서 조회한 기록입니다.` : '이 앱에서 조회한 잔여량 기록입니다.'}</p>{snapshotOptions.length > 0 && <select aria-label="사용량 종류" value={chosenWindow?.key || ''} onChange={event => setSelectedWindow(event.target.value)}>{snapshotOptions.map(option => <option value={option.key} key={option.key}>{option.label}</option>)}</select>}</div>
        {quotaPoints.length ? <>{quotaPoints.some(item => finite(item.remaining)) && <TrendChart points={quotaPoints} valueKey="remaining" label="사용량 잔여 비율 그래프" percent line/>}<div className="details-table-scroll quota-history-scroll"><table className="details-table" aria-label="잔여량 조회 기록"><thead><tr><th className="details-date">조회 일시</th><th className="details-number">남은 사용량</th><th className="details-number">크레딧</th><th className="details-number">초기화권</th></tr></thead><tbody>{[...quotaPoints].reverse().map(item => <tr key={item.key}><td className="details-date"><time dateTime={item.time}>{dateTime(item.time)}</time></td><td className="details-number">{integerText(item.remaining)}{finite(item.remaining) ? '%' : ''}</td><td className="details-number">{item.creditsUnlimited ? '무제한' : integerText(item.creditBalance)}</td><td className="details-number">{integerText(item.resetCredits)}{finite(item.resetCredits) ? '개' : ''}</td></tr>)}</tbody></table></div></> : <p className="details-empty">이 기간의 잔여량 기록이 없습니다.</p>}
      </section>}
      <ResetHistory resets={details.resets}/>
    </>}
  </div>;
}
