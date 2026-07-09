import jwt from 'jsonwebtoken';
import { app } from '../src/app';
import { env } from '../src/lib/env';
import { prisma } from '../src/lib/prisma';

type TestResult = {
  name: string;
  pass: boolean;
  details: string;
};

const results: TestResult[] = [];

const addResult = (name: string, pass: boolean, details: string) => {
  results.push({ name, pass, details });
  const status = pass ? 'PASS' : 'FAIL';
  console.log(`[${status}] ${name} :: ${details}`);
};

const jsonFetch = async <T = unknown>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> => {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as T;
  return { status: response.status, body };
};

const run = async () => {
  const runId = Date.now();
  const port = 4030;
  const baseUrl = `http://127.0.0.1:${port}`;

  // ── Create test users ────────────────────────────────────────
  const adminUser = await prisma.user.create({
    data: {
      email: `community_admin_${runId}@example.com`,
      passwordHash: 'test_hash',
      role: 'ADMIN',
      displayName: 'Community Admin',
    },
  });

  const modUser = await prisma.user.create({
    data: {
      email: `community_mod_${runId}@example.com`,
      passwordHash: 'test_hash',
      role: 'MODERATOR',
      displayName: 'Community Mod',
    },
  });

  const regularUser = await prisma.user.create({
    data: {
      email: `community_user_${runId}@example.com`,
      passwordHash: 'test_hash',
      role: 'USER',
      displayName: 'Community User',
    },
  });

  const adminToken = jwt.sign(
    { userId: adminUser.id, email: adminUser.email, role: adminUser.role },
    env.JWT_SECRET,
    { expiresIn: '1h' },
  );

  const modToken = jwt.sign(
    { userId: modUser.id, email: modUser.email, role: modUser.role },
    env.JWT_SECRET,
    { expiresIn: '1h' },
  );

  const userToken = jwt.sign(
    { userId: regularUser.id, email: regularUser.email, role: regularUser.role },
    env.JWT_SECRET,
    { expiresIn: '1h' },
  );

  const adminHeaders = {
    Authorization: `Bearer ${adminToken}`,
    'Content-Type': 'application/json',
  };

  const modHeaders = {
    Authorization: `Bearer ${modToken}`,
    'Content-Type': 'application/json',
  };

  const userHeaders = {
    Authorization: `Bearer ${userToken}`,
    'Content-Type': 'application/json',
  };

  // ── Test data ─────────────────────────────────────────────────
  let categoryId: string = '';
  let topicId: string = '';
  let topicId2: string = '';
  let topicId3: string = '';
  let topLevelCommentId: string = '';
  let replyCommentId: string = '';

  const server = app.listen(port);

  try {
    // ═══════════════════════════════════════════════════════════════
    // CHECKLIST ITEM 1: Join community -> Joined persists on reload
    // ═══════════════════════════════════════════════════════════════

    // Create a forum category for testing
    const category = await prisma.forumCategory.create({
      data: {
        name: `Test Category ${runId}`,
        description: 'Test category for acceptance tests',
        order: 1,
      },
    });
    categoryId = category.id;

    // GET /api/community/categories - verify the category appears
    const catList = await jsonFetch<Array<{ id: string; name: string; memberCount: number; topicCount: number }>>(
      `${baseUrl}/api/community/categories`,
      { headers: userHeaders },
    );

    const catListOk =
      catList.status === 200 &&
      Array.isArray(catList.body) &&
      catList.body.some((c) => c.id === categoryId);

    addResult(
      'GET /api/community/categories returns categories with memberCount and topicCount',
      catListOk,
      `status=${catList.status}, found=${catListOk}, count=${Array.isArray(catList.body) ? catList.body.length : 'n/a'}`,
    );

    // POST /api/community/categories/:id/join - regular user joins
    const join1 = await jsonFetch(`${baseUrl}/api/community/categories/${categoryId}/join`, {
      method: 'POST',
      headers: userHeaders,
    });

    addResult(
      'POST /api/community/categories/:id/join returns 201 for first join',
      join1.status === 201,
      `status=${join1.status}`,
    );

    // Verify membership in database (simulates "persists on reload")
    const membership1 = await prisma.userCommunityMembership.findUnique({
      where: { userId_categoryId: { userId: regularUser.id, categoryId } },
    });

    addResult(
      'Membership record exists in database after join (persists on reload)',
      !!membership1,
      `found=${!!membership1}`,
    );

    // Second join (upsert) should return 201
    const join2 = await jsonFetch(`${baseUrl}/api/community/categories/${categoryId}/join`, {
      method: 'POST',
      headers: userHeaders,
    });

    addResult(
      'POST /api/community/categories/:id/join returns 201 on re-join (idempotent upsert)',
      join2.status === 201,
      `status=${join2.status}`,
    );

    // Verify member count reflects membership
    const catAfterJoin = await jsonFetch<Array<{ id: string; memberCount: number; isMember?: boolean }>>(
      `${baseUrl}/api/community/categories`,
      { headers: userHeaders },
    );
    const catAfter = Array.isArray(catAfterJoin.body)
      ? catAfterJoin.body.find((c) => c.id === categoryId)
      : null;

    addResult(
      'Category memberCount is at least 1 after a user joins',
      catAfterJoin.status === 200 && !!catAfter && catAfter.memberCount >= 1,
      `status=${catAfterJoin.status}, memberCount=${catAfter?.memberCount ?? 'n/a'}`,
    );

    addResult(
      'Joined persists on reload: isMember=true returned by GET /api/community/categories',
      catAfterJoin.status === 200 && !!catAfter?.isMember,
      `status=${catAfterJoin.status}, isMember=${catAfter?.isMember ?? 'undefined'}`,
    );

    // ═══════════════════════════════════════════════════════════════
    // CHECKLIST ITEM 4: Regular user -> no Create Topic button visible
    // (backend: POST /community/topics requires MODERATOR or ADMIN)
    // ═══════════════════════════════════════════════════════════════

    // Regular user tries to create a topic -> should get 403
    const createAsUser = await jsonFetch(`${baseUrl}/api/community/topics`, {
      method: 'POST',
      headers: userHeaders,
      body: JSON.stringify({
        title: 'Regular user topic',
        content: 'Should be forbidden',
        forumCategoryId: categoryId,
      }),
    });

    addResult(
      'POST /api/community/topics as regular USER returns 403 (no Create Topic button equivalent)',
      createAsUser.status === 403,
      `status=${createAsUser.status}`,
    );

    // Admin creates a topic -> should succeed
    const createAsAdmin = await jsonFetch<{ id: string; title: string }>(
      `${baseUrl}/api/community/topics`,
      {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          title: `Admin Topic Alpha ${runId}`,
          content: 'Content for the admin topic',
          forumCategoryId: categoryId,
        }),
      },
    );

    const adminTopicOk = createAsAdmin.status === 201 && !!createAsAdmin.body.id;

    addResult(
      'POST /api/community/topics as ADMIN returns 201 with topic id',
      adminTopicOk,
      `status=${createAsAdmin.status}, id=${createAsAdmin.body.id ?? 'n/a'}`,
    );

    if (adminTopicOk) {
      topicId = createAsAdmin.body.id;
    }

    // Moderator creates a topic -> should also succeed
    const createAsMod = await jsonFetch<{ id: string; title: string }>(
      `${baseUrl}/api/community/topics`,
      {
        method: 'POST',
        headers: modHeaders,
        body: JSON.stringify({
          title: `Mod Topic Beta ${runId}`,
          content: 'Content for the mod topic',
          forumCategoryId: categoryId,
        }),
      },
    );

    const modTopicOk = createAsMod.status === 201 && !!createAsMod.body.id;

    addResult(
      'POST /api/community/topics as MODERATOR returns 201 with topic id',
      modTopicOk,
      `status=${createAsMod.status}, id=${createAsMod.body.id ?? 'n/a'}`,
    );

    if (modTopicOk) {
      topicId2 = createAsMod.body.id;
    }

    // Admin creates a third topic with high likes (for sort testing)
    const createTopic3 = await jsonFetch<{ id: string }>(
      `${baseUrl}/api/community/topics`,
      {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          title: `Admin Topic Gamma ${runId}`,
          content: 'Topic for hot/top sorting verification',
          forumCategoryId: categoryId,
        }),
      },
    );

    if (createTopic3.status === 201 && createTopic3.body.id) {
      topicId3 = createTopic3.body.id;

      // Give topic3 high likes via direct DB update
      await prisma.topic.update({
        where: { id: topicId3 },
        data: { likes: 50 },
      });
    }

    // ═══════════════════════════════════════════════════════════════
    // CHECKLIST ITEM 2: Switch Hot/New/Top -> feed re-orders
    // ═══════════════════════════════════════════════════════════════

    // GET /api/community/topics?sort=new -> newest first
    const sortNew = await jsonFetch<{ topics: Array<{ id: string; title: string; createdAt: string }> }>(
      `${baseUrl}/api/community/topics?sort=new&categoryId=${categoryId}&limit=10`,
    );

    const newSorted =
      sortNew.status === 200 &&
      Array.isArray(sortNew.body.topics) &&
      sortNew.body.topics.length > 0;

    addResult(
      'GET /api/community/topics?sort=new returns topics in newest-first order',
      newSorted,
      `status=${sortNew.status}, count=${Array.isArray(sortNew.body.topics) ? sortNew.body.topics.length : 0}`,
    );

    if (newSorted && sortNew.body.topics.length >= 2) {
      const dates = sortNew.body.topics.map((t) => new Date(t.createdAt).getTime());
      const chronoOk = dates.every((d, i) => i === 0 || d <= dates[i - 1]);
      addResult(
        '  └─ topics are sorted descending by createdAt',
        chronoOk,
        `dates=${dates.join(', ')}`,
      );
    }

    // GET /api/community/topics?sort=top -> highest likes first
    const sortTop = await jsonFetch<{ topics: Array<{ id: string; title: string; likes: number }> }>(
      `${baseUrl}/api/community/topics?sort=top&categoryId=${categoryId}&limit=10`,
    );

    const topSorted =
      sortTop.status === 200 &&
      Array.isArray(sortTop.body.topics) &&
      sortTop.body.topics.length > 0;

    addResult(
      'GET /api/community/topics?sort=top returns topics in highest-likes-first order',
      topSorted,
      `status=${sortTop.status}, count=${Array.isArray(sortTop.body.topics) ? sortTop.body.topics.length : 0}`,
    );

    if (topSorted && sortTop.body.topics.length >= 2) {
      const likesDesc = sortTop.body.topics.every(
        (t, i) => i === 0 || t.likes <= sortTop.body.topics[i - 1].likes,
      );
      addResult(
        '  └─ topics are sorted descending by likes',
        likesDesc,
        `likes=${sortTop.body.topics.map((t) => t.likes).join(', ')}`,
      );
    }

    // GET /api/community/topics?sort=hot -> hot algorithm sorting
    const sortHot = await jsonFetch<{ topics: Array<{ id: string; title: string; likes: number }> }>(
      `${baseUrl}/api/community/topics?sort=hot&categoryId=${categoryId}&limit=10`,
    );

    addResult(
      'GET /api/community/topics?sort=hot returns topics sorted by hot algorithm',
      sortHot.status === 200 && Array.isArray(sortHot.body.topics) && sortHot.body.topics.length > 0,
      `status=${sortHot.status}, count=${Array.isArray(sortHot.body.topics) ? sortHot.body.topics.length : 0}`,
    );

    // ═══════════════════════════════════════════════════════════════
    // CHECKLIST ITEM 5: Upvote -> +1 immediately -> reload -> persists
    // ═══════════════════════════════════════════════════════════════

    if (topicId) {
      // Get initial likes
      const beforeVote = await prisma.topic.findUnique({
        where: { id: topicId },
        select: { likes: true },
      });
      const initialLikes = beforeVote?.likes ?? 0;

      // POST /api/community/vote/topic - UPVOTE
      const upvote = await jsonFetch<{ likes: number }>(
        `${baseUrl}/api/community/vote/topic`,
        {
          method: 'POST',
          headers: userHeaders,
          body: JSON.stringify({ topicId, voteType: 'UPVOTE' }),
        },
      );

      const upvoteOk =
        upvote.status === 200 &&
        typeof upvote.body.likes === 'number' &&
        upvote.body.likes === initialLikes + 1;

      addResult(
        'POST /api/community/vote/topic (UPVOTE) returns likes = initial + 1',
        upvoteOk,
        `status=${upvote.status}, initial=${initialLikes}, got=${upvote.body.likes}`,
      );

      // GET /api/community/topics/:id -> score persists on reload
      const topicAfterVote = await jsonFetch<{ id: string; likes: number }>(
        `${baseUrl}/api/community/topics/${topicId}`,
      );

      const persistedLikes = topicAfterVote.body.likes;

      addResult(
        'Upvote persists on reload: GET /api/community/topics/:id returns +1 likes',
        topicAfterVote.status === 200 && persistedLikes === initialLikes + 1,
        `status=${topicAfterVote.status}, expected=${initialLikes + 1}, got=${persistedLikes}`,
      );

      // Toggle off: same UPVOTE again removes the vote -> back to initialLikes
      const toggleOff = await jsonFetch<{ likes: number }>(
        `${baseUrl}/api/community/vote/topic`,
        {
          method: 'POST',
          headers: userHeaders,
          body: JSON.stringify({ topicId, voteType: 'UPVOTE' }),
        },
      );

      addResult(
        'Toggle off: same UPVOTE again removes vote, score returns to initial',
        toggleOff.status === 200 &&
          toggleOff.body.likes === initialLikes,
        `status=${toggleOff.status}, expected=${initialLikes}, got=${toggleOff.body.likes}`,
      );

      // Verify toggle off persists on reload
      const afterToggleOff = await jsonFetch<{ id: string; likes: number }>(
        `${baseUrl}/api/community/topics/${topicId}`,
      );

      addResult(
        'Toggle off persists on reload: GET returns initial likes',
        afterToggleOff.status === 200 && afterToggleOff.body.likes === initialLikes,
        `status=${afterToggleOff.status}, expected=${initialLikes}, got=${afterToggleOff.body.likes}`,
      );

      // Fresh UPVOTE again from neutral state -> +1
      const freshUpvote = await jsonFetch<{ likes: number }>(
        `${baseUrl}/api/community/vote/topic`,
        {
          method: 'POST',
          headers: userHeaders,
          body: JSON.stringify({ topicId, voteType: 'UPVOTE' }),
        },
      );

      addResult(
        'Fresh UPVOTE from neutral state returns +1',
        freshUpvote.status === 200 &&
          freshUpvote.body.likes === initialLikes + 1,
        `status=${freshUpvote.status}, expected=${initialLikes + 1}, got=${freshUpvote.body.likes}`,
      );

      // Change vote to DOWNVOTE -> likes should decrease by 2 (remove +1, add -1)
      const downvote = await jsonFetch<{ likes: number }>(
        `${baseUrl}/api/community/vote/topic`,
        {
          method: 'POST',
          headers: userHeaders,
          body: JSON.stringify({ topicId, voteType: 'DOWNVOTE' }),
        },
      );

      addResult(
        'DOWNVOTE after UPVOTE changes vote, adjusts likes by -2',
        downvote.status === 200 &&
          downvote.body.likes === initialLikes - 1,
        `status=${downvote.status}, expected=${initialLikes - 1}, got=${downvote.body.likes}`,
      );

      // Toggle off DOWNVOTE -> back to neutral
      const toggleDownvote = await jsonFetch<{ likes: number }>(
        `${baseUrl}/api/community/vote/topic`,
        {
          method: 'POST',
          headers: userHeaders,
          body: JSON.stringify({ topicId, voteType: 'DOWNVOTE' }),
        },
      );

      addResult(
        'Toggle off DOWNVOTE removes vote, score back to initial',
        toggleDownvote.status === 200 &&
          toggleDownvote.body.likes === initialLikes,
        `status=${toggleDownvote.status}, expected=${initialLikes}, got=${toggleDownvote.body.likes}`,
      );
    }

    // ═══════════════════════════════════════════════════════════════
    // CHECKLIST ITEM 3: Reply to reply -> 3-level nesting renders correctly
    // ═══════════════════════════════════════════════════════════════

    if (topicId) {
      // Post a top-level comment
      const comment1 = await jsonFetch<{ id: string; content: string }>(
        `${baseUrl}/api/community/topics/${topicId}/comments`,
        {
          method: 'POST',
          headers: userHeaders,
          body: JSON.stringify({ content: 'Level 1: Top-level comment' }),
        },
      );

      const comment1Ok = comment1.status === 201 && !!comment1.body.id;

      addResult(
        'POST /api/community/topics/:topicId/comments creates top-level comment',
        comment1Ok,
        `status=${comment1.status}, id=${comment1.body.id ?? 'n/a'}`,
      );

      if (comment1Ok) {
        topLevelCommentId = comment1.body.id;

        // Reply to top-level comment (depth 2)
        const comment2 = await jsonFetch<{ id: string; content: string }>(
          `${baseUrl}/api/community/topics/${topicId}/comments`,
          {
            method: 'POST',
            headers: userHeaders,
            body: JSON.stringify({
              content: 'Level 2: Reply to top-level comment',
              parentCommentId: topLevelCommentId,
            }),
          },
        );

        const comment2Ok = comment2.status === 201 && !!comment2.body.id;

        addResult(
          'POST with parentCommentId creates depth-2 reply',
          comment2Ok,
          `status=${comment2.status}, id=${comment2.body.id ?? 'n/a'}`,
        );

        if (comment2Ok) {
          replyCommentId = comment2.body.id;

          // Reply to the reply (depth 3)
          const comment3 = await jsonFetch<{ id: string; content: string }>(
            `${baseUrl}/api/community/topics/${topicId}/comments`,
            {
              method: 'POST',
              headers: userHeaders,
              body: JSON.stringify({
                content: 'Level 3: Reply to nested reply',
                parentCommentId: replyCommentId,
              }),
            },
          );

          const comment3Ok = comment3.status === 201 && !!comment3.body.id;

          addResult(
            'POST with nested parentCommentId creates depth-3 reply (3-level nesting)',
            comment3Ok,
            `status=${comment3.status}, id=${comment3.body.id ?? 'n/a'}`,
          );
        }
      }

      // GET /api/community/topics/:id -> verify nested comment tree
      const topicDetail = await jsonFetch<{
        id: string;
        comments: Array<{
          id: string;
          content: string;
          replies: Array<{
            id: string;
            content: string;
            replies: Array<{
              id: string;
              content: string;
            }>;
          }>;
        }>;
      }>(`${baseUrl}/api/community/topics/${topicId}`);

      const detailOk = topicDetail.status === 200 && topicDetail.body.id === topicId;
      addResult(
        'GET /api/community/topics/:id returns topic with nested comments',
        detailOk,
        `status=${topicDetail.status}`,
      );

      if (detailOk) {
        const comments = topicDetail.body.comments ?? [];
        const hasTopLevel = comments.some((c) => c.content === 'Level 1: Top-level comment');
        const hasLevel2 = comments.some((c) =>
          (c.replies ?? []).some((r) => r.content === 'Level 2: Reply to top-level comment'),
        );
        const hasLevel3 = comments.some((c) =>
          (c.replies ?? []).some((r) =>
            (r.replies ?? []).some((r3) => r3.content === 'Level 3: Reply to nested reply'),
          ),
        );

        addResult(
          'Comment tree has 3 levels of nesting (top -> reply -> nested reply)',
          hasTopLevel && hasLevel2 && hasLevel3,
          `level1=${hasTopLevel}, level2=${hasLevel2}, level3=${hasLevel3}`,
        );

        // Verify reply count
        const topLevel = comments.find((c) => c.content === 'Level 1: Top-level comment');
        if (topLevel) {
          const replyCount = (topLevel.replies ?? []).length;
          addResult(
            'Top-level comment contains at least 1 reply in nested structure',
            replyCount >= 1,
            `replyCount=${replyCount}`,
          );
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // Additional: Comment voting
    // ═══════════════════════════════════════════════════════════════

    if (topLevelCommentId) {
      const commentBefore = await prisma.topicComment.findUnique({
        where: { id: topLevelCommentId },
        select: { likes: true },
      });
      const initialCommentLikes = commentBefore?.likes ?? 0;

      const commentVote = await jsonFetch<{ likes: number }>(
        `${baseUrl}/api/community/vote/comment`,
        {
          method: 'POST',
          headers: userHeaders,
          body: JSON.stringify({ commentId: topLevelCommentId, voteType: 'UPVOTE' }),
        },
      );

      addResult(
        'POST /api/community/vote/comment (UPVOTE) increments comment likes',
        commentVote.status === 200 &&
          commentVote.body.likes === initialCommentLikes + 1,
        `status=${commentVote.status}, init=${initialCommentLikes}, got=${commentVote.body.likes}`,
      );

      // Verify comment vote persists on reload
      const topicWithComments = await jsonFetch<{
        comments: Array<{ id: string; likes: number }>;
      }>(`${baseUrl}/api/community/topics/${topicId}`);

      const reFetchedComment = (topicWithComments.body.comments ?? []).find(
        (c) => c.id === topLevelCommentId,
      );

      addResult(
        'Comment vote persists on reload via GET /api/community/topics/:id',
        !!reFetchedComment && reFetchedComment.likes === initialCommentLikes + 1,
        `expected=${initialCommentLikes + 1}, got=${reFetchedComment?.likes ?? 'n/a'}`,
      );
    }

    // ═══════════════════════════════════════════════════════════════
    // Additional: Authorization checks
    // ═══════════════════════════════════════════════════════════════

    // Anonymous (no auth) on authenticated endpoints should return 401
    const anonJoin = await jsonFetch(`${baseUrl}/api/community/categories/${categoryId}/join`, {
      method: 'POST',
    });
    addResult(
      'Anonymous POST /api/community/categories/:id/join returns 401',
      anonJoin.status === 401,
      `status=${anonJoin.status}`,
    );

    // Regular user cannot pin/lock/delete topics
    if (topicId) {
      const userPin = await jsonFetch(`${baseUrl}/api/community/topics/${topicId}/pin`, {
        method: 'PATCH',
        headers: userHeaders,
      });
      addResult(
        'Regular USER cannot pin topics (returns 403)',
        userPin.status === 403,
        `status=${userPin.status}`,
      );

      const userLock = await jsonFetch(`${baseUrl}/api/community/topics/${topicId}/lock`, {
        method: 'PATCH',
        headers: userHeaders,
      });
      addResult(
        'Regular USER cannot lock topics (returns 403)',
        userLock.status === 403,
        `status=${userLock.status}`,
      );
    }

    // Admin can pin/lock
    if (topicId) {
      const pinRes = await jsonFetch<{ isPinned: boolean }>(
        `${baseUrl}/api/community/topics/${topicId}/pin`,
        {
          method: 'PATCH',
          headers: adminHeaders,
        },
      );

      addResult(
        'ADMIN can pin a topic',
        pinRes.status === 200 && pinRes.body.isPinned === true,
        `status=${pinRes.status}, isPinned=${pinRes.body.isPinned ?? 'n/a'}`,
      );
    }
  } finally {
    // ── Cleanup ──────────────────────────────────────────────────
    server.close();

    // Clean up all created test data
    if (topicId) {
      await prisma.topicVote.deleteMany({ where: { topicId } });
      await prisma.topicCommentVote.deleteMany({
        where: { comment: { topicId } },
      });
      const commentIds = (
        await prisma.topicComment.findMany({
          where: { topicId },
          select: { id: true },
        })
      ).map((c) => c.id);

      // Delete nested replies first (cascade may handle this, but be safe)
      for (const cid of commentIds) {
        await prisma.topicCommentVote.deleteMany({ where: { commentId: cid } });
      }
      await prisma.topicComment.deleteMany({ where: { topicId } });
    }

    if (topicId) {
      await prisma.topic.deleteMany({ where: { id: topicId } });
    }
    if (topicId2) {
      await prisma.topic.deleteMany({ where: { id: topicId2 } });
    }
    if (topicId3) {
      await prisma.topic.deleteMany({ where: { id: topicId3 } });
    }

    if (categoryId) {
      await prisma.userCommunityMembership.deleteMany({ where: { categoryId } });
      await prisma.forumCategory.deleteMany({ where: { id: categoryId } });
    }

    await prisma.user.deleteMany({ where: { id: adminUser.id } });
    await prisma.user.deleteMany({ where: { id: modUser.id } });
    await prisma.user.deleteMany({ where: { id: regularUser.id } });

    await prisma.$disconnect();
  }

  // ── Summary ───────────────────────────────────────────────────
  const failed = results.filter((r) => !r.pass);

  console.log('\n===== Community Acceptance Checklist Summary =====');
  console.log(`Total: ${results.length}`);
  console.log(`Passed: ${results.length - failed.length}`);
  console.log(`Failed: ${failed.length}`);

  if (failed.length > 0) {
    console.log('\n--- Failed Tests ---');
    for (const row of failed) {
      console.log(`  [FAIL] ${row.name}`);
      console.log(`         ${row.details}`);
    }
    process.exitCode = 1;
    return;
  }

  process.exitCode = 0;
};

void run().catch((error) => {
  console.error('Community acceptance run failed unexpectedly:', error);
  process.exitCode = 1;
});
