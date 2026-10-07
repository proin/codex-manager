export function createDemoBridge() {
  const listeners = new Set();
  const now = Date.now();
  const second = Math.floor(now / 1000);
  const resetCredits = (id, count) => Array.from({ length: count }, (_, index) => ({
    id: `${id}-reset-${index + 1}`, resetType: 'codexRateLimits', status: 'available',
    grantedAt: second - (index + 1) * 86400, expiresAt: second + (index + 1) * 7 * 86400,
    title: `초기화권 ${index + 1}`, description: 'Codex 사용량을 초기화합니다.',
  })).concat({ id: `${id}-expired`, resetType: 'codexRateLimits', status: 'available', grantedAt: second - 14 * 86400, expiresAt: second - 86400, title: '기간이 지난 초기화권', description: null });
  const sample = (id, label, email, plan, short, weekly, count) => ({ id, label, email, planType: plan, status: 'ready', lastUpdated: new Date(now - 180000).toISOString(), usage: { rateLimitsByLimitId: { codex: { limitId:'codex', limitName:'Codex', planType:plan, primary: {usedPercent:short,windowDurationMins:300,resetsAt:Math.floor(now/1000)+8200}, secondary:{usedPercent:weekly,windowDurationMins:10080,resetsAt:Math.floor(now/1000)+256000} } }, rateLimitResetCredits: count === null ? null : {availableCount:count,credits:resetCredits(id, count)} } });
  let state = { accounts: [sample('demo-1','개인 계정','personal@example.com','Plus',28,44,2),sample('demo-2','프로젝트 계정','project@example.com','Pro',8,16,5),sample('demo-3','연구 계정','research@example.com','Plus',92,78,1),sample('demo-4','업무 계정','work@example.com','Team',41,32,null), {id:'demo-5',label:'테스트 계정',email:'test@example.com',planType:'Plus',status:'signedOut',usage:null}], activity:[], refresh:{running:false,done:0,total:0}, runtime:{available:true,version:'화면 점검용 예시',path:'/demo/codex'} };
  state.accounts[0].usage.rateLimitsByLimitId.codex.credits = { hasCredits: true, unlimited: false, balance: '1200' };
  state.accounts[1].usage.rateLimitsByLimitId.codex.credits = { hasCredits: true, unlimited: true, balance: null };
  state.accounts[2].usage.rateLimitsByLimitId.codex.credits = { hasCredits: false, unlimited: false, balance: '0' };
  const dayMs = 86400000;
  const details = new Map();
  const point = (account, time = new Date().toISOString()) => ({
    time, buckets: Object.values(account.usage?.rateLimitsByLimitId || {}).map(bucket => ({ limitId: bucket.limitId, limitName: bucket.limitName, primary: structuredClone(bucket.primary), secondary: structuredClone(bucket.secondary) })),
    creditBalance: account.usage?.rateLimitsByLimitId?.codex?.credits?.balance == null ? null : Number(account.usage.rateLimitsByLimitId.codex.credits.balance),
    creditsUnlimited: Boolean(account.usage?.rateLimitsByLimitId?.codex?.credits?.unlimited), resetCredits: account.usage?.rateLimitResetCredits?.availableCount ?? null,
  });
  const detailFor = id => {
    const account = state.accounts.find(item => item.id === id);
    if (!account) throw new Error('계정을 찾을 수 없습니다.');
    if (!details.has(id)) details.set(id, { accountId: id, email: account.email || null, trackingStartedAt: new Date(now).toISOString(), updatedAt: null, usageFetchedAt: null, usageError: null, tokenUsage: null, snapshots: [], resets: [] });
    return details.get(id);
  };
  state.accounts.filter(account => account.status === 'ready').forEach((account, accountIndex) => {
    const daily = Array.from({ length: 90 }, (_, index) => ({ startDate: new Date(now - (89 - index) * dayMs).toISOString().slice(0, 10), tokens: Math.round((12000 + ((index * 7919) % 67000)) * (accountIndex + 1)) })).filter((_, index) => index !== 84);
    const history = Array.from({ length: 30 }, (_, index) => {
      const snapshot = point(account, new Date(now - (29 - index) * dayMs).toISOString());
      snapshot.buckets.forEach(bucket => { bucket.primary.usedPercent = (index * 13 + accountIndex * 3) % 100; bucket.secondary.usedPercent = (index * 7 + accountIndex * 11) % 100; });
      return snapshot;
    });
    details.set(account.id, {
      accountId: account.id, email: account.email, trackingStartedAt: history[0].time, updatedAt: new Date(now).toISOString(), usageFetchedAt: new Date(now).toISOString(), usageError: null,
      tokenUsage: { summary: { lifetimeTokens: daily.reduce((sum, row) => sum + row.tokens, 0), peakDailyTokens: Math.max(...daily.map(row => row.tokens)), longestRunningTurnSec: 540, currentStreakDays: 5, longestStreakDays: 18 }, dailyUsageBuckets: daily },
      snapshots: history,
      resets: [{ id: `${account.id}-past-reset`, time: new Date(now - 3 * dayMs).toISOString(), requestedAt: new Date(now - 3 * dayMs - 1200).toISOString(), outcome: 'reset', usedCount: 1, timeKind: 'completed' }],
    });
  });
  const snapshot = () => structuredClone(state);
  const emit = () => { listeners.forEach((fn) => fn(snapshot())); return snapshot(); };
  const log = (account, type, message) => state.activity.unshift({id:crypto.randomUUID(),time:new Date().toISOString(),accountId:account.id,label:account.label,type,message});
  return {
    getState:async () => snapshot(), onState:(callback) => {listeners.add(callback); return () => listeners.delete(callback);},
    getAccountDetails: async id => structuredClone(detailFor(id)),
    refreshAccountDetails: async id => { await new Promise(resolve => setTimeout(resolve, 180)); const value = detailFor(id); value.usageFetchedAt = new Date().toISOString(); return structuredClone(value); },
    addAccount:async (label) => {state.accounts.push({id:crypto.randomUUID(),label:label || '새 계정',status:'signedOut',usage:null}); return emit();},
    renameAccount:async (id,label) => {state.accounts.find((account) => account.id === id).label = label; return emit();},
    removeAccount:async (id) => {state.accounts=state.accounts.filter((account) => account.id !== id);return emit();},
    login:async (id,method) => {const account=state.accounts.find((account) => account.id===id);account.status='loggingIn';account.login={type:method,loginId:'demo',url:'https://auth.openai.com/',userCode:method==='chatgptDeviceCode'?'DEMO-CODE':null};return emit();},
    cancelLogin:async (id) => {const account=state.accounts.find((account) => account.id===id);account.status='signedOut';delete account.login;return emit();},
    openLogin:async () => {}, openUsagePage:async () => {}, chooseCodexBinary:async () => snapshot(),
    refreshAccounts:async (ids) => {const targets=state.accounts.filter((account) => (!ids || ids.includes(account.id)) && account.status!=='signedOut');state.refresh={running:true,done:0,total:targets.length};targets.forEach((account)=>account.status='loading');emit();for (const account of targets){await new Promise((resolve)=>setTimeout(resolve,180));account.status='ready';account.lastUpdated=new Date().toISOString();state.refresh.done++;log(account,'refresh','사용량 조회 완료 (예시)');emit();}state.refresh.running=false;return emit();},
    resetAccounts: async (ids, selections) => {
      const targets = state.accounts.filter(item => ids.includes(item.id));
      const chosen = targets.map(account => {
        const credit = account.usage?.rateLimitResetCredits?.credits?.find(item => item.id === selections?.[account.id]);
        const current = Date.now() / 1000;
        if (!credit || credit.status !== 'available' || credit.resetType !== 'codexRateLimits' || credit.grantedAt > current || (credit.expiresAt != null && credit.expiresAt <= current)) throw new Error('사용할 초기화권을 다시 선택하십시오.');
        return { account, credit };
      });
      for (const { account, credit } of chosen) {
        const credits = account.usage.rateLimitResetCredits;
        credits.availableCount--;
        credits.credits = credits.credits.filter(item => item.id !== credit.id);
        Object.values(account.usage.rateLimitsByLimitId).forEach(bucket => { bucket.primary.usedPercent = 0; bucket.secondary.usedPercent = 0; });
        account.resetAttempt = { status: 'completed', creditId: credit.id, message: '초기화권 사용 완료 (예시)' };
        const history = detailFor(account.id), time = new Date().toISOString();
        history.resets.push({ id: crypto.randomUUID(), time, requestedAt: time, outcome: 'reset', usedCount: 1, timeKind: 'completed' });
        history.snapshots.push(point(account, time)); history.updatedAt = time;
        log(account, 'reset', '초기화권 1개 사용 완료 (예시)');
      }
      return emit();
    }
  };
}
