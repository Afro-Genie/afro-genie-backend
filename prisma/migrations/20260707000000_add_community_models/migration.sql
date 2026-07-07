-- Create UserCommunityMembership table
CREATE TABLE IF NOT EXISTS "user_community_memberships" (
    "userId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_community_memberships_pkey" PRIMARY KEY ("userId", "categoryId")
);

-- Create TopicVote table
CREATE TABLE IF NOT EXISTS "topic_votes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "voteType" "VoteType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "topic_votes_pkey" PRIMARY KEY ("id")
);

-- Create TopicCommentVote table
CREATE TABLE IF NOT EXISTS "topic_comment_votes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "voteType" "VoteType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "topic_comment_votes_pkey" PRIMARY KEY ("id")
);

-- Unique constraints
CREATE UNIQUE INDEX IF NOT EXISTS "topic_votes_userId_topicId_key" ON "topic_votes"("userId", "topicId");
CREATE UNIQUE INDEX IF NOT EXISTS "topic_comment_votes_userId_commentId_key" ON "topic_comment_votes"("userId", "commentId");

-- Foreign keys (idempotent via DO block)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_community_memberships_userId_fkey') THEN
    ALTER TABLE "user_community_memberships" ADD CONSTRAINT "user_community_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_community_memberships_categoryId_fkey') THEN
    ALTER TABLE "user_community_memberships" ADD CONSTRAINT "user_community_memberships_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ForumCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'topic_votes_userId_fkey') THEN
    ALTER TABLE "topic_votes" ADD CONSTRAINT "topic_votes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'topic_votes_topicId_fkey') THEN
    ALTER TABLE "topic_votes" ADD CONSTRAINT "topic_votes_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'topic_comment_votes_userId_fkey') THEN
    ALTER TABLE "topic_comment_votes" ADD CONSTRAINT "topic_comment_votes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'topic_comment_votes_commentId_fkey') THEN
    ALTER TABLE "topic_comment_votes" ADD CONSTRAINT "topic_comment_votes_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "TopicComment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
