import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { contributeTax, getBalance as getPoolBalance } from '../src/services/modPoolService';
import { awardTokens, getBalance } from '../src/services/tokenService';
import { cleanupUser, createUser, uid } from './helpers';

let userId: string;

after(async () => {
  if (userId) await cleanupUser(userId);
});

test('replaying an idempotent moderation tax does not credit the pool twice', async () => {
  const user = await createUser({ role: 'MODERATOR' });
  userId = user.id;
  await awardTokens({
    userId,
    type: 'EARN',
    amount: 100,
    reason: 'Moderation tax test funding',
    sourceType: 'TEST',
    sourceId: uid(),
  });

  const sourceId = `tax-replay:${uid()}`;
  const initialWallet = await getBalance(userId);
  const initialPool = await getPoolBalance();

  await contributeTax({ userId, rewardAmount: 20, sourceId });
  const firstPool = await getPoolBalance();
  await contributeTax({ userId, rewardAmount: 20, sourceId });

  assert.equal(await getPoolBalance(), firstPool);
  assert.ok(firstPool > initialPool);
  assert.ok(await getBalance(userId) < initialWallet);
});
