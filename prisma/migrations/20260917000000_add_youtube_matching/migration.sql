-- AlterTable
ALTER TABLE "Song" ADD COLUMN     "youtubeVideoId" TEXT,
ADD COLUMN     "youtubeMatchedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Song_youtubeVideoId_idx" ON "Song"("youtubeVideoId");
