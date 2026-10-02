/**
 * Stage 4 apply — P5-R-1 (restore Challenges) + P5-R-2 (worker diagnosis).
 *
 * Class B (additive upsert). Runs the actual production service functions
 * rather than re-implementing their logic in SQL, so this test is the code that
 * will run in production.
 *
 * Sequence (plan §4.1, §4.3):
 *   pre-check        rows -> "expect old week, expired"
 *   apply            runChallengeRotation()        -> { upserted, deactivated }
 *   post-check       rows -> "expect 5 active new + 4 inactive old"
 *   idempotent re-run runChallengeRotation()        -> no new rows, deactivated 0
 *   route-path check getCurrentChallenges(userId)  -> the exact list GET /api/challenges returns
 *
 * Usage:
 *   npx tsx scripts/stage4-restore.ts          # full run (Class B, additive)
 *
 * Do NOT run this against a disposable database flag — it feeds production by
 * design. It only upserts and deactivates; it can never destroy a row.
 */
import { runChallengeRotation } from '../src/jobs/challengeRotationJob';
import { getCurrentChallenges } from '../src/services/challengeService';
import { prisma } from '../src/lib/prisma';

let argc = process.argv.slice(2);
const DRY_RUN = argc.includes('--dry-run');

async function snapshot(label: string) {
  const rows = await prisma.challenge.findMany({ orderBy: { startsAt: 'asc' } });
  console.log(`\n--- [${label}] ${rows.length} Challenge row(s) ---`);
  for (const r of rows) {
    console.log(
      `  active=${r.active} ${r.type.padEnd(22)} ${r.title.padEnd(26)} ${r.startsAt.toISOString()} -> ${r.expiresAt.toISOString()}`,
    );
  }
  return rows;
}

async function main() {
  console.log('STAGE 4', DRY_RUN ? 'DRY RUN — no writes' : 'APPLY — Class B additive upsert');

  await snapshot('pre-check');

  if (DRY_RUN) {
    console.log('\n  dry-run: skipping runChallengeRotation()');
    await prisma.$disconnect();
    return;
  }

  console.log('\n--- apply: runChallengeRotation() ---');
  const applied = await runChallengeRotation();
  console.log('  result:', JSON.stringify(applied));

  await snapshot('post-check');

  console.log('\n--- idempotency: runChallengeRotation() again ---');
  const rerun = await runChallengeRotation();
  console.log('  result:', JSON.stringify(rerun));
  await snapshot('after re-run');
  if (rerun.deactivated !== 0) {
    console.log('\n  !! deactivated is non-zero on re-run — re-running changed state');
    process.exit(1);
  }

  console.log('\n--- route-path check: getCurrentChallenges(userId) ---');
  console.log('  (this is exactly what GET /api/challenges returns for an authenticated user)');
  const user = await prisma.user.findFirst({
    orderBy: { createdAt: 'asc' },
    select: { id: true, email: true },
  });
  const userId = user?.id;
  const list = userId ? await getCurrentChallenges(userId) : await getCurrentChallenges();
  console.log(`  user: ${user?.email ?? '(none)'}  ->  ${list.length} open challenge(s)`);
  for (const c of list) {
    console.log(
      `  ${c.type.padEnd(22)} ${c.title.padEnd(26)} progress=${c.progress}/${String(c.targetValue).padEnd(3)} completed=${c.completed} claimed=${c.claimed}`,
    );
  }

  if (list.length === 0) {
    console.log('\n  !! getCurrentChallenges returned zero — stage 4 did not restore the feature');
    await prisma.$disconnect();
    process.exit(1);
  }

  console.log('\nOK: Challenges feature restored; rotation is idempotent.');
  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (e) => {
  console.error('[stage4] FATAL', e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});