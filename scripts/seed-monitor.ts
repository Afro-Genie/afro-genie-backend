/**
 * Live Seed Monitor
 *
 * Run in a separate terminal to watch seed progress in real-time.
 * Refreshes every 5 seconds.
 *
 * Usage:
 *   npx tsx scripts/seed-monitor.ts
 *   npx tsx scripts/seed-monitor.ts --once    # Show once and exit
 */

import * as fs from 'fs';
import * as path from 'path';

const PROGRESS_FILE = path.join(__dirname, '..', 'seed-progress.json');
const ONCE = process.argv.includes('--once');

function loadProgress(): any {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return null;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

function display(data: any): void {
  const pct = data.totalQueries > 0
    ? Math.round((data.completedQueries / data.totalQueries) * 100)
    : 0;
  const barLen = 30;
  const filled = Math.round((pct / 100) * barLen);
  const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);

  const statusIcon = data.status === 'completed' ? '✅' :
    data.status === 'failed' ? '❌' :
    data.status === 'paused' ? '⏸️' : '🔄';

  console.log('\x1b[2J\x1b[H');
  console.log('┌──────────────────────────────────────────────────────┐');
  console.log('│        AFRO-GENIE SEED LIVE MONITOR                  │');
  console.log('├──────────────────────────────────────────────────────┤');
  console.log(`│  ${statusIcon} Status:   ${data.status.toUpperCase().padEnd(37)}│`);
  console.log(`│  Started:  ${formatTime(data.startedAt).padEnd(37)}│`);
  console.log(`│  Updated:  ${formatTime(data.lastUpdatedAt).padEnd(37)}│`);
  console.log('├──────────────────────────────────────────────────────┤');
  console.log(`│  Queries:  ${data.completedQueries}/${data.totalQueries}  ${bar} ${pct}% │`);
  console.log(`│  Batches:  ${data.currentBatch + 1}/${data.totalBatches}                                   │`);
  console.log('├──────────────────────────────────────────────────────┤');
  console.log('│  📊 DATABASE LIVE COUNTS                             │');
  console.log(`│  🎵 Songs:   ${String(data.dbCounts.songs).padEnd(38)}│`);
  console.log(`│  🎤 Artists: ${String(data.dbCounts.artists).padEnd(38)}│`);
  console.log(`│  💿 Albums:  ${String(data.dbCounts.albums).padEnd(38)}│`);
  console.log('├──────────────────────────────────────────────────────┤');
  console.log('│  📈 SESSION STATS                                    │');
  console.log(`│  Songs created:   ${String(data.stats.songsCreated).padEnd(33)}│`);
  console.log(`│  Artists created: ${String(data.stats.artistsCreated).padEnd(33)}│`);
  console.log(`│  Albums created:  ${String(data.stats.albumsCreated).padEnd(33)}│`);
  console.log(`│  Records skipped: ${String(data.stats.songsSkipped + data.stats.artistsSkipped + data.stats.albumsSkipped).padEnd(33)}│`);
  console.log(`│  Errors:          ${String(data.stats.errors).padEnd(33)}│`);
  console.log('├──────────────────────────────────────────────────────┤');
  if (data.failedQueries && data.failedQueries.length > 0) {
    console.log(`│  ⚠️  Failed: ${data.failedQueries.join(', ').substring(0, 42).padEnd(42)}│`);
    console.log('├──────────────────────────────────────────────────────┤');
  }
  console.log('│  📋 RECENT LOGS                                      │');
  const logs = data.logs || [];
  for (const log of logs.slice(-8)) {
    console.log(`│  ${log.substring(0, 52).padEnd(52)}│`);
  }
  console.log('└──────────────────────────────────────────────────────┘');

  if (data.status === 'completed') {
    console.log('\n  🎉 Seed completed successfully!');
  } else if (data.status === 'failed') {
    console.log('\n  ❌ Seed failed. Check logs for details.');
    console.log('  Run with --resume to continue from last checkpoint.');
  } else {
    console.log('\n  Refreshing every 5s... Press Ctrl+C to stop monitoring.');
  }
}

function monitor(): void {
  const data = loadProgress();
  if (!data) {
    console.log('⏳ Waiting for seed to start... (no seed-progress.json found)');
    if (!ONCE) {
      setTimeout(monitor, 5000);
    }
    return;
  }

  display(data);

  if (ONCE) return;

  if (data.status === 'running') {
    setTimeout(monitor, 5000);
  }
}

monitor();
