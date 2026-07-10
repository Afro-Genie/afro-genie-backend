-- Add imageUrl column to Topic table (schema drift fix)
ALTER TABLE "Topic" ADD COLUMN IF NOT EXISTS "imageUrl" TEXT;

-- Fix FK constraints on community tables: ON DELETE RESTRICT -> CASCADE
-- UserCommunityMembership
ALTER TABLE "user_community_memberships" DROP CONSTRAINT IF EXISTS "user_community_memberships_userId_fkey";
ALTER TABLE "user_community_memberships" ADD CONSTRAINT "user_community_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_community_memberships" DROP CONSTRAINT IF EXISTS "user_community_memberships_categoryId_fkey";
ALTER TABLE "user_community_memberships" ADD CONSTRAINT "user_community_memberships_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ForumCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- TopicVote
ALTER TABLE "topic_votes" DROP CONSTRAINT IF EXISTS "topic_votes_userId_fkey";
ALTER TABLE "topic_votes" ADD CONSTRAINT "topic_votes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "topic_votes" DROP CONSTRAINT IF EXISTS "topic_votes_topicId_fkey";
ALTER TABLE "topic_votes" ADD CONSTRAINT "topic_votes_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- TopicCommentVote
ALTER TABLE "topic_comment_votes" DROP CONSTRAINT IF EXISTS "topic_comment_votes_userId_fkey";
ALTER TABLE "topic_comment_votes" ADD CONSTRAINT "topic_comment_votes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "topic_comment_votes" DROP CONSTRAINT IF EXISTS "topic_comment_votes_commentId_fkey";
ALTER TABLE "topic_comment_votes" ADD CONSTRAINT "topic_comment_votes_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "TopicComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
