-- CreateEnum
CREATE TYPE "RoleRequestStatus" AS ENUM ('PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED');

-- DropForeignKey
ALTER TABLE "StorePurchase" DROP CONSTRAINT "StorePurchase_itemId_fkey";

-- DropForeignKey
ALTER TABLE "topic_comment_votes" DROP CONSTRAINT "topic_comment_votes_commentId_fkey";

-- DropForeignKey
ALTER TABLE "topic_comment_votes" DROP CONSTRAINT "topic_comment_votes_userId_fkey";

-- DropForeignKey
ALTER TABLE "topic_votes" DROP CONSTRAINT "topic_votes_topicId_fkey";

-- DropForeignKey
ALTER TABLE "topic_votes" DROP CONSTRAINT "topic_votes_userId_fkey";

-- DropForeignKey
ALTER TABLE "user_community_memberships" DROP CONSTRAINT "user_community_memberships_categoryId_fkey";

-- DropForeignKey
ALTER TABLE "user_community_memberships" DROP CONSTRAINT "user_community_memberships_userId_fkey";

-- DropIndex
DROP INDEX "Lyric_songId_idx";

-- DropIndex
DROP INDEX "Song_albumId_idx";

-- DropIndex
DROP INDEX "StorePurchase_createdAt_idx";

-- DropIndex
DROP INDEX "StorePurchase_userId_idx";

-- DropIndex
DROP INDEX "StorePurchase_userId_itemId_createdAt_key";

-- DropIndex
DROP INDEX "User_referredByUserId_idx";

-- AlterTable
ALTER TABLE "Album" ALTER COLUMN "genres" DROP DEFAULT;

-- AlterTable
ALTER TABLE "ArtistApplication" ADD COLUMN     "imageUrl" TEXT,
ADD COLUMN     "spotifyArtistId" TEXT;

-- AlterTable
ALTER TABLE "ContentReport" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "ForumCategory" ADD COLUMN     "isModeratorOnly" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Guideline" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "ModPool" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "StoreItem" ALTER COLUMN "category" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Topic" ADD COLUMN     "isModeratorOnly" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "viewCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Translation" ADD COLUMN     "correctedAt" TIMESTAMP(3),
ADD COLUMN     "corrected_by_id" TEXT,
ADD COLUMN     "correctionRequestId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "moderatorPinnedAt" TIMESTAMP(3);

-- DropTable
DROP TABLE "topic_comment_votes";

-- DropTable
DROP TABLE "topic_votes";

-- DropTable
DROP TABLE "user_community_memberships";

-- CreateTable
CREATE TABLE "CorrectionRequest" (
    "id" TEXT NOT NULL,
    "songId" TEXT NOT NULL,
    "translationId" TEXT,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "CorrectionStatus" NOT NULL DEFAULT 'PENDING',
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "moderatorNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CorrectionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TopicVote" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "voteType" "VoteType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TopicVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TopicView" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "userId" TEXT,
    "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TopicView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserListeningPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "genreIds" TEXT[],
    "languageCodes" TEXT[],
    "listenedArtistIds" TEXT[],
    "lastComputedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserListeningPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Playlist" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "songIds" TEXT[],
    "createdBy" TEXT NOT NULL,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Playlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlaylistLike" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "playlistId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlaylistLike_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TopicCommentVote" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "voteType" "VoteType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TopicCommentVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserCommunityMembership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserCommunityMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenReward" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenReward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoleRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "status" "RoleRequestStatus" NOT NULL DEFAULT 'PENDING',
    "fields" JSONB NOT NULL,
    "notes" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoleRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SongPlay" (
    "id" TEXT NOT NULL,
    "songId" TEXT NOT NULL,
    "playedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "country" TEXT,
    "city" TEXT,

    CONSTRAINT "SongPlay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtistListenerRegion" (
    "id" TEXT NOT NULL,
    "artistId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "country" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "listeners" INTEGER NOT NULL DEFAULT 0,
    "plays" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArtistListenerRegion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,
    "songsAdded" INTEGER NOT NULL DEFAULT 0,
    "artistsUpdated" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModActionLog" (
    "id" TEXT NOT NULL,
    "moderatorId" TEXT,
    "actionType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "details" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModActionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunityGuideline" (
    "id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunityGuideline_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CorrectionRequest_songId_idx" ON "CorrectionRequest"("songId");

-- CreateIndex
CREATE INDEX "CorrectionRequest_userId_idx" ON "CorrectionRequest"("userId");

-- CreateIndex
CREATE INDEX "CorrectionRequest_status_idx" ON "CorrectionRequest"("status");

-- CreateIndex
CREATE INDEX "CorrectionRequest_translationId_idx" ON "CorrectionRequest"("translationId");

-- CreateIndex
CREATE UNIQUE INDEX "CorrectionRequest_songId_userId_title_key" ON "CorrectionRequest"("songId", "userId", "title");

-- CreateIndex
CREATE INDEX "TopicVote_userId_idx" ON "TopicVote"("userId");

-- CreateIndex
CREATE INDEX "TopicVote_topicId_idx" ON "TopicVote"("topicId");

-- CreateIndex
CREATE UNIQUE INDEX "TopicVote_userId_topicId_key" ON "TopicVote"("userId", "topicId");

-- CreateIndex
CREATE INDEX "TopicView_topicId_idx" ON "TopicView"("topicId");

-- CreateIndex
CREATE INDEX "TopicView_userId_idx" ON "TopicView"("userId");

-- CreateIndex
CREATE INDEX "TopicView_viewedAt_idx" ON "TopicView"("viewedAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserListeningPreference_userId_key" ON "UserListeningPreference"("userId");

-- CreateIndex
CREATE INDEX "UserListeningPreference_userId_idx" ON "UserListeningPreference"("userId");

-- CreateIndex
CREATE INDEX "Playlist_createdBy_idx" ON "Playlist"("createdBy");

-- CreateIndex
CREATE INDEX "Playlist_isPublic_idx" ON "Playlist"("isPublic");

-- CreateIndex
CREATE INDEX "Playlist_likeCount_idx" ON "Playlist"("likeCount");

-- CreateIndex
CREATE INDEX "Playlist_createdAt_idx" ON "Playlist"("createdAt");

-- CreateIndex
CREATE INDEX "PlaylistLike_userId_idx" ON "PlaylistLike"("userId");

-- CreateIndex
CREATE INDEX "PlaylistLike_playlistId_idx" ON "PlaylistLike"("playlistId");

-- CreateIndex
CREATE UNIQUE INDEX "PlaylistLike_userId_playlistId_key" ON "PlaylistLike"("userId", "playlistId");

-- CreateIndex
CREATE INDEX "TopicCommentVote_userId_idx" ON "TopicCommentVote"("userId");

-- CreateIndex
CREATE INDEX "TopicCommentVote_commentId_idx" ON "TopicCommentVote"("commentId");

-- CreateIndex
CREATE UNIQUE INDEX "TopicCommentVote_userId_commentId_key" ON "TopicCommentVote"("userId", "commentId");

-- CreateIndex
CREATE INDEX "UserCommunityMembership_userId_idx" ON "UserCommunityMembership"("userId");

-- CreateIndex
CREATE INDEX "UserCommunityMembership_categoryId_idx" ON "UserCommunityMembership"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "UserCommunityMembership_userId_categoryId_key" ON "UserCommunityMembership"("userId", "categoryId");

-- CreateIndex
CREATE INDEX "TokenReward_userId_idx" ON "TokenReward"("userId");

-- CreateIndex
CREATE INDEX "TokenReward_createdAt_idx" ON "TokenReward"("createdAt");

-- CreateIndex
CREATE INDEX "TokenReward_reason_idx" ON "TokenReward"("reason");

-- CreateIndex
CREATE UNIQUE INDEX "TokenReward_idempotencyKey_key" ON "TokenReward"("idempotencyKey");

-- CreateIndex
CREATE INDEX "RoleRequest_userId_idx" ON "RoleRequest"("userId");

-- CreateIndex
CREATE INDEX "RoleRequest_role_idx" ON "RoleRequest"("role");

-- CreateIndex
CREATE INDEX "RoleRequest_status_idx" ON "RoleRequest"("status");

-- CreateIndex
CREATE INDEX "RoleRequest_createdAt_idx" ON "RoleRequest"("createdAt");

-- CreateIndex
CREATE INDEX "SongPlay_songId_playedAt_idx" ON "SongPlay"("songId", "playedAt");

-- CreateIndex
CREATE INDEX "SongPlay_playedAt_idx" ON "SongPlay"("playedAt");

-- CreateIndex
CREATE INDEX "SongPlay_userId_idx" ON "SongPlay"("userId");

-- CreateIndex
CREATE INDEX "SongPlay_country_idx" ON "SongPlay"("country");

-- CreateIndex
CREATE INDEX "ArtistListenerRegion_artistId_idx" ON "ArtistListenerRegion"("artistId");

-- CreateIndex
CREATE INDEX "ArtistListenerRegion_date_idx" ON "ArtistListenerRegion"("date");

-- CreateIndex
CREATE INDEX "ArtistListenerRegion_country_idx" ON "ArtistListenerRegion"("country");

-- CreateIndex
CREATE UNIQUE INDEX "ArtistListenerRegion_artistId_date_country_city_key" ON "ArtistListenerRegion"("artistId", "date", "country", "city");

-- CreateIndex
CREATE INDEX "SyncRun_type_idx" ON "SyncRun"("type");

-- CreateIndex
CREATE INDEX "SyncRun_startedAt_idx" ON "SyncRun"("startedAt");

-- CreateIndex
CREATE INDEX "SyncRun_createdAt_idx" ON "SyncRun"("createdAt");

-- CreateIndex
CREATE INDEX "ModActionLog_moderatorId_idx" ON "ModActionLog"("moderatorId");

-- CreateIndex
CREATE INDEX "ModActionLog_actionType_idx" ON "ModActionLog"("actionType");

-- CreateIndex
CREATE INDEX "ModActionLog_targetId_targetType_idx" ON "ModActionLog"("targetId", "targetType");

-- CreateIndex
CREATE INDEX "ModActionLog_createdAt_idx" ON "ModActionLog"("createdAt");

-- CreateIndex
CREATE INDEX "Album_spotifyId_idx" ON "Album"("spotifyId");

-- CreateIndex
CREATE INDEX "SeasonalSnapshot_period_idx" ON "SeasonalSnapshot"("period");

-- CreateIndex
CREATE INDEX "Song_previewAvailable_idx" ON "Song"("previewAvailable");

-- CreateIndex
CREATE UNIQUE INDEX "Translation_correctionRequestId_key" ON "Translation"("correctionRequestId");

-- AddForeignKey
ALTER TABLE "Album" ADD CONSTRAINT "Album_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Song" ADD CONSTRAINT "Song_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "Album"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Translation" ADD CONSTRAINT "Translation_corrected_by_id_fkey" FOREIGN KEY ("corrected_by_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Translation" ADD CONSTRAINT "Translation_correctionRequestId_fkey" FOREIGN KEY ("correctionRequestId") REFERENCES "CorrectionRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorrectionRequest" ADD CONSTRAINT "CorrectionRequest_songId_fkey" FOREIGN KEY ("songId") REFERENCES "Song"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorrectionRequest" ADD CONSTRAINT "CorrectionRequest_translationId_fkey" FOREIGN KEY ("translationId") REFERENCES "Translation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorrectionRequest" ADD CONSTRAINT "CorrectionRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorrectionRequest" ADD CONSTRAINT "CorrectionRequest_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopicVote" ADD CONSTRAINT "TopicVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopicVote" ADD CONSTRAINT "TopicVote_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopicView" ADD CONSTRAINT "TopicView_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopicView" ADD CONSTRAINT "TopicView_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserListeningPreference" ADD CONSTRAINT "UserListeningPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Playlist" ADD CONSTRAINT "Playlist_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaylistLike" ADD CONSTRAINT "PlaylistLike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaylistLike" ADD CONSTRAINT "PlaylistLike_playlistId_fkey" FOREIGN KEY ("playlistId") REFERENCES "Playlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopicCommentVote" ADD CONSTRAINT "TopicCommentVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopicCommentVote" ADD CONSTRAINT "TopicCommentVote_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "TopicComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCommunityMembership" ADD CONSTRAINT "UserCommunityMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCommunityMembership" ADD CONSTRAINT "UserCommunityMembership_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ForumCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenReward" ADD CONSTRAINT "TokenReward_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleRequest" ADD CONSTRAINT "RoleRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SongPlay" ADD CONSTRAINT "SongPlay_songId_fkey" FOREIGN KEY ("songId") REFERENCES "Song"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SongPlay" ADD CONSTRAINT "SongPlay_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistListenerRegion" ADD CONSTRAINT "ArtistListenerRegion_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModActionLog" ADD CONSTRAINT "ModActionLog_moderatorId_fkey" FOREIGN KEY ("moderatorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorePurchase" ADD CONSTRAINT "StorePurchase_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "StoreItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
