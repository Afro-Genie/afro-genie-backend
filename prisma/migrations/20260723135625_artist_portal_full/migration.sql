-- CreateEnum
CREATE TYPE "ReleaseType" AS ENUM ('SINGLE', 'EP', 'ALBUM');

-- CreateEnum
CREATE TYPE "ReleaseStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'PUBLISHED');

-- AlterTable: Artist
ALTER TABLE "Artist" ADD COLUMN "userId" TEXT,
ADD COLUMN "profileImageUrl" TEXT,
ADD COLUMN "bannerImageUrl" TEXT,
ADD COLUMN "socialLinks" JSONB,
ADD COLUMN "spotifyArtistId" TEXT,
ADD COLUMN "suspended" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "isFeatured" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: ArtistApplication
ALTER TABLE "ArtistApplication" ADD COLUMN "rejectionReason" TEXT,
ADD COLUMN "reviewedByUserId" TEXT,
ADD COLUMN "reviewedAt" TIMESTAMP(3);

-- AlterTable: Song
ALTER TABLE "Song" ADD COLUMN "releaseId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Artist_userId_key" ON "Artist"("userId");

-- CreateIndex
CREATE INDEX "Artist_suspended_idx" ON "Artist"("suspended");

-- CreateIndex
CREATE INDEX "Artist_isFeatured_idx" ON "Artist"("isFeatured");

-- CreateIndex
CREATE INDEX "Artist_userId_idx" ON "Artist"("userId");

-- CreateIndex
CREATE INDEX "Song_releaseId_idx" ON "Song"("releaseId");

-- CreateIndex
CREATE INDEX "ArtistApplication_reviewedByUserId_idx" ON "ArtistApplication"("reviewedByUserId");

-- CreateTable
CREATE TABLE "Release" (
    "id" TEXT NOT NULL,
    "artistId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "ReleaseType" NOT NULL,
    "coverImageUrl" TEXT,
    "releaseDate" TIMESTAMP(3) NOT NULL,
    "status" "ReleaseStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Release_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Release_artistId_idx" ON "Release"("artistId");

-- CreateIndex
CREATE INDEX "Release_status_idx" ON "Release"("status");

-- CreateIndex
CREATE INDEX "Release_releaseDate_idx" ON "Release"("releaseDate");

-- CreateTable
CREATE TABLE "ArtistAnalyticsDaily" (
    "id" TEXT NOT NULL,
    "artistId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "plays" INTEGER NOT NULL DEFAULT 0,
    "translationViews" INTEGER NOT NULL DEFAULT 0,
    "uniqueListeners" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArtistAnalyticsDaily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ArtistAnalyticsDaily_artistId_date_key" ON "ArtistAnalyticsDaily"("artistId", "date");

-- CreateIndex
CREATE INDEX "ArtistAnalyticsDaily_artistId_idx" ON "ArtistAnalyticsDaily"("artistId");

-- CreateIndex
CREATE INDEX "ArtistAnalyticsDaily_date_idx" ON "ArtistAnalyticsDaily"("date");

-- CreateTable
CREATE TABLE "ArtistNotification" (
    "id" TEXT NOT NULL,
    "artistId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArtistNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ArtistNotification_artistId_idx" ON "ArtistNotification"("artistId");

-- CreateIndex
CREATE INDEX "ArtistNotification_isRead_idx" ON "ArtistNotification"("isRead");

-- CreateIndex
CREATE INDEX "ArtistNotification_createdAt_idx" ON "ArtistNotification"("createdAt");

-- AddForeignKey
ALTER TABLE "Artist" ADD CONSTRAINT "Artist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistApplication" ADD CONSTRAINT "ArtistApplication_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Song" ADD CONSTRAINT "Song_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "Release"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Release" ADD CONSTRAINT "Release_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistAnalyticsDaily" ADD CONSTRAINT "ArtistAnalyticsDaily_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistNotification" ADD CONSTRAINT "ArtistNotification_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE CASCADE ON UPDATE CASCADE;
