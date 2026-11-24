import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Job } from 'bullmq';
import { env } from '../src/lib/env';
import { CatalogQuotaExceededError } from '../src/lib/catalogImportQuota';
import { getJobStallInfo } from '../src/lib/catalogImportDiagnostics';

function fakeJob(timestamp: number, lastUpdatedAt?: string): Job {
  return {
    id: 'catalog_apply_test',
    timestamp,
    processedOn: timestamp,
    progress: lastUpdatedAt ? { lastUpdatedAt } : null,
  } as unknown as Job;
}

describe('catalog import diagnostics', () => {
  test('marks a job with stale progress as stalled', () => {
    const staleAt = new Date(Date.now() - env.YOUTUBE_IMPORT_STALL_MS - 60_000).toISOString();
    const info = getJobStallInfo(fakeJob(Date.parse(staleAt), staleAt));
    assert.equal(info.stalled, true);
    assert.match(info.reason, /No progress update/);
    assert.equal(info.lastProgressAt, staleAt);
  });

  test('does not mark a recently updated job as stalled', () => {
    const recentAt = new Date(Date.now() - 5_000).toISOString();
    const info = getJobStallInfo(fakeJob(Date.parse(recentAt), recentAt));
    assert.equal(info.stalled, false);
    assert.equal(info.reason, '');
  });
});

describe('catalog import quota errors', () => {
  test('explains why the import was aborted and when the budget resets', () => {
    const resetAt = '2026-11-24T00:00:00.000Z';
    const error = new CatalogQuotaExceededError(
      {
        used: env.YOUTUBE_DAILY_QUOTA_UNITS,
        limit: env.YOUTUBE_DAILY_QUOTA_UNITS,
        remaining: 0,
        resetAt,
        source: 'estimated',
      },
      100,
    );
    assert.match(error.message, /quota budget exhausted/i);
    assert.match(error.message, /different YouTube API key/);
    assert.match(error.message, new RegExp(resetAt));
    assert.equal(error.requestedUnits, 100);
  });
});
