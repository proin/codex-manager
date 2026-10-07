'use strict';

const { createHash } = require('node:crypto');

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_SNAPSHOTS = 10_000;
const RESET_OUTCOMES = new Set(['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit', 'uncertain']);
const SUMMARY_FIELDS = ['lifetimeTokens', 'peakDailyTokens', 'longestRunningTurnSec', 'currentStreakDays', 'longestStreakDays'];
const emailKey = (email) => typeof email === 'string' ? email.trim().toLowerCase() : '';
const numeric = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const instant = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const label = (value) => typeof value === 'string' ? value.slice(0, 100) : null;

function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = instant(`${value}T00:00:00.000Z`);
  return parsed?.slice(0, 10) === value ? value : null;
}

function tokenUsage(value) {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'summary') || !Object.hasOwn(value, 'dailyUsageBuckets')) return null;
  const summary = value.summary && typeof value.summary === 'object'
    ? Object.fromEntries(SUMMARY_FIELDS.map((field) => [field, numeric(value.summary[field])])) : null;
  const days = new Map();
  if (Array.isArray(value.dailyUsageBuckets)) {
    for (const bucket of value.dailyUsageBuckets) {
      const startDate = calendarDate(bucket?.startDate);
      const tokens = numeric(bucket?.tokens);
      // A duplicate date is one daily total, never an additional day to sum twice.
      if (startDate && tokens !== null) days.set(startDate, { startDate, tokens });
    }
  }
  return {
    summary,
    dailyUsageBuckets: Array.isArray(value.dailyUsageBuckets) ? [...days.values()].sort((a, b) => a.startDate.localeCompare(b.startDate)) : null,
  };
}

function windowValue(value) {
  if (!value || typeof value !== 'object') return null;
  return { usedPercent: numeric(value.usedPercent), windowDurationMins: numeric(value.windowDurationMins), resetsAt: numeric(value.resetsAt) };
}

function snapshotFromUsage(usage, time) {
  time = instant(time);
  if (!usage || !time) return null;
  const mapped = usage.rateLimitsByLimitId && typeof usage.rateLimitsByLimitId === 'object'
    ? Object.entries(usage.rateLimitsByLimitId).filter(([, row]) => row && typeof row === 'object') : [];
  const entries = mapped.length ? mapped : usage.rateLimits ? [[usage.rateLimits.limitId || 'codex', usage.rateLimits]] : [];
  const buckets = entries.slice(0, 100).map(([key, row]) => ({
    limitId: label(row.limitId) || label(key) || 'codex', limitName: label(row.limitName),
    primary: windowValue(row.primary), secondary: windowValue(row.secondary),
  }));
  const credits = (entries.find(([key, row]) => (row.limitId || key) === 'codex') || entries[0])?.[1]?.credits ?? usage.rateLimits?.credits;
  const rawBalance = credits?.balance;
  const parsedBalance = typeof rawBalance === 'number' || (typeof rawBalance === 'string' && rawBalance.trim()) ? Number(rawBalance) : null;
  return {
    time, buckets,
    creditBalance: numeric(parsedBalance) ?? (credits?.hasCredits === false ? 0 : null),
    creditsUnlimited: credits?.unlimited === true,
    resetCredits: numeric(usage.rateLimitResetCredits?.availableCount),
  };
}

function snapshotValue(row) {
  const time = instant(row?.time);
  if (!time || !Array.isArray(row.buckets)) return null;
  return {
    time,
    buckets: row.buckets.slice(0, 100).filter((item) => item && typeof item === 'object').map((item) => ({
      limitId: label(item.limitId) || 'codex', limitName: label(item.limitName),
      primary: windowValue(item.primary), secondary: windowValue(item.secondary),
    })),
    creditBalance: numeric(row.creditBalance), creditsUnlimited: row.creditsUnlimited === true,
    resetCredits: numeric(row.resetCredits),
  };
}

function resetValue(row) {
  const time = instant(row?.time);
  const requestedAt = instant(row?.requestedAt);
  if (!time || !requestedAt || typeof row.id !== 'string' || !/^reset-[a-f0-9]{32}$/.test(row.id) || !RESET_OUTCOMES.has(row.outcome)) return null;
  return {
    id: row.id, time, requestedAt, outcome: row.outcome,
    usedCount: ['reset', 'alreadyRedeemed'].includes(row.outcome) ? 1 : row.outcome === 'uncertain' ? null : 0,
    timeKind: row.outcome === 'uncertain' ? 'requested' : row.outcome === 'alreadyRedeemed' ? 'confirmed' : 'completed',
  };
}

function emptyStatistics(email, time = new Date().toISOString()) {
  return { version: 1, email: emailKey(email), trackingStartedAt: time, updatedAt: null, usageFetchedAt: null, usageError: null, tokenUsage: null, snapshots: [], resets: [] };
}

function retainSnapshots(statistics, time) {
  const cutoff = Date.parse(time) - RETENTION_MS;
  statistics.snapshots = statistics.snapshots.filter((row) => Date.parse(row.time) >= cutoff).slice(-MAX_SNAPSHOTS);
}

function recordSnapshot(statistics, usage, time) {
  const snapshot = snapshotFromUsage(usage, time);
  if (!snapshot) return;
  statistics.snapshots.push(snapshot);
  statistics.snapshots.sort((a, b) => a.time.localeCompare(b.time));
  retainSnapshots(statistics, new Date().toISOString());
  if (snapshot.time < statistics.trackingStartedAt) statistics.trackingStartedAt = snapshot.time;
  statistics.updatedAt = snapshot.time;
}

function recordReset(statistics, accountId, attempt) {
  if (!attempt?.idempotencyKey || emailKey(attempt.accountEmail) !== statistics.email) return;
  const requestedAt = instant(attempt.startedAt);
  if (!requestedAt) return;
  const outcome = attempt.status === 'completed' && RESET_OUTCOMES.has(attempt.outcome) ? attempt.outcome : 'uncertain';
  const finishedAt = instant(attempt.completedAt);
  // A completed event without a saved completion date must not get an invented date.
  if (outcome !== 'uncertain' && !finishedAt) return;
  const row = {
    id: `reset-${createHash('sha256').update(`${accountId}:${attempt.idempotencyKey}`).digest('hex').slice(0, 32)}`,
    time: outcome === 'uncertain' ? requestedAt : finishedAt,
    requestedAt, outcome,
    usedCount: ['reset', 'alreadyRedeemed'].includes(outcome) ? 1 : outcome === 'uncertain' ? null : 0,
    timeKind: outcome === 'uncertain' ? 'requested' : outcome === 'alreadyRedeemed' ? 'confirmed' : 'completed',
  };
  const index = statistics.resets.findIndex((event) => event.id === row.id);
  if (index < 0) statistics.resets.push(row); else statistics.resets[index] = row;
  statistics.resets.sort((a, b) => a.time.localeCompare(b.time));
  if (requestedAt < statistics.trackingStartedAt) statistics.trackingStartedAt = requestedAt;
  if (!statistics.updatedAt || row.time > statistics.updatedAt) statistics.updatedAt = row.time;
}

function restoreStatistics(raw, account, time = new Date().toISOString()) {
  const valid = raw?.version === 1 && emailKey(raw.email) === emailKey(account.email);
  const statistics = emptyStatistics(account.email, time);
  if (valid) {
    statistics.trackingStartedAt = instant(raw.trackingStartedAt) || time;
    statistics.updatedAt = instant(raw.updatedAt);
    statistics.usageFetchedAt = instant(raw.usageFetchedAt);
    statistics.tokenUsage = tokenUsage(raw.tokenUsage);
    statistics.snapshots = Array.isArray(raw.snapshots) ? raw.snapshots.map(snapshotValue).filter(Boolean).sort((a, b) => a.time.localeCompare(b.time)) : [];
    statistics.resets = Array.isArray(raw.resets) ? [...new Map(raw.resets.map(resetValue).filter(Boolean).map((row) => [row.id, row])).values()].sort((a, b) => a.time.localeCompare(b.time)) : [];
    // Failure messages are generated locally; do not trust arbitrary strings in a saved file.
    if (raw.usageError) statistics.usageError = '상세 사용량을 다시 조회하십시오.';
    retainSnapshots(statistics, time);
  } else if (!raw) {
    // Older releases stored only the most recent quota and reset request.
    recordSnapshot(statistics, account.usage, account.lastUpdated);
  }
  recordReset(statistics, account.id, account.resetAttempt);
  return statistics;
}

function publicDetails(account) {
  const value = account.statistics;
  return structuredClone({ accountId: account.id, email: account.email, trackingStartedAt: value.trackingStartedAt, updatedAt: value.updatedAt, usageFetchedAt: value.usageFetchedAt, usageError: value.usageError, tokenUsage: value.tokenUsage, snapshots: value.snapshots, resets: value.resets });
}

module.exports = { emptyStatistics, restoreStatistics, publicDetails, tokenUsage, recordSnapshot, recordReset, calendarDate };
