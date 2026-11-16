import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { communityService } from '../src/services/communityService';
import { awardTokens } from '../src/services/tokenService';
import { cleanupUser, createUser } from './helpers';

const userIds: string[] = [];

after(async () => {
  await Promise.all(userIds.map(cleanupUser));
});

test('pin and lock rewards are one-time per topic, across moderators and reversals', async () => {
  const author = await createUser();
  userIds.push(author.id);
  const moderatorA = await createUser({ role: 'MODERATOR' });
  userIds.push(moderatorA.id);
  const moderatorB = await createUser({ role: 'ADMIN' });
  userIds.push(moderatorB.id);

  const topic = await prisma.topic.create({
    data: {
      title: 'Moderation reward test',
      content: 'Test topic content',
      authorId: author.id,
      category: 'GENERAL',
    },
  });

  const firstPin = await communityService.pinTopic(topic.id, moderatorA.id);
  assert.ok(firstPin.reward);
  await communityService.pinTopic(topic.id, moderatorA.id);
  const repeatPin = await communityService.pinTopic(topic.id, moderatorB.id);
  assert.equal(repeatPin.reward, null);

  const pinAwards = await prisma.tokenLedger.count({
    where: {
      sourceType: 'COMMUNITY_MODERATION',
      sourceId: `TOPIC_PINNED:${topic.id}`,
      type: 'EARN',
    },
  });
  const pinTaxes = await prisma.tokenLedger.count({
    where: {
      sourceType: 'MOD_POOL_TAX',
      sourceId: `moderation:TOPIC_PINNED:${topic.id}`,
      type: 'TAX',
    },
  });
  assert.equal(pinAwards, 1);
  assert.equal(pinTaxes, 1);

  const firstLock = await communityService.lockTopic(topic.id, moderatorA.id);
  assert.ok(firstLock.reward);
  await communityService.lockTopic(topic.id, moderatorA.id);
  const repeatLock = await communityService.lockTopic(topic.id, moderatorB.id);
  assert.equal(repeatLock.reward, null);

  const lockAwards = await prisma.tokenLedger.count({
    where: {
      sourceType: 'COMMUNITY_MODERATION',
      sourceId: `TOPIC_LOCKED:${topic.id}`,
      type: 'EARN',
    },
  });
  const lockTaxes = await prisma.tokenLedger.count({
    where: {
      sourceType: 'MOD_POOL_TAX',
      sourceId: `moderation:TOPIC_LOCKED:${topic.id}`,
      type: 'TAX',
    },
  });
  assert.equal(lockAwards, 1);
  assert.equal(lockTaxes, 1);
});

test('existing topic moderation awards block a second award after deployment', async () => {
  const author = await createUser();
  userIds.push(author.id);
  const moderatorA = await createUser({ role: 'MODERATOR' });
  userIds.push(moderatorA.id);
  const moderatorB = await createUser({ role: 'ADMIN' });
  userIds.push(moderatorB.id);

  const topic = await prisma.topic.create({
    data: {
      title: 'Legacy moderation reward test',
      content: 'Test topic content',
      authorId: author.id,
      category: 'GENERAL',
    },
  });

  await awardTokens({
    userId: moderatorA.id,
    type: 'EARN',
    amount: 5,
    reason: 'Existing community moderation action',
    sourceType: 'COMMUNITY_MODERATION',
    sourceId: `TOPIC_PINNED:${topic.id}`,
    idempotencyKey: `moderation:TOPIC_PINNED:${topic.id}:${moderatorA.id}`,
  });

  const result = await communityService.pinTopic(topic.id, moderatorB.id);
  assert.equal(result.reward, null);
  assert.equal(
    await prisma.tokenLedger.count({
      where: {
        sourceType: 'COMMUNITY_MODERATION',
        sourceId: `TOPIC_PINNED:${topic.id}`,
        type: 'EARN',
      },
    }),
    1,
  );
});
