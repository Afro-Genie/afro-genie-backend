CREATE TABLE IF NOT EXISTS "UploadedFile" (
  "filename" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "data" BYTEA NOT NULL,
  "checksum" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UploadedFile_pkey" PRIMARY KEY ("filename")
);

CREATE INDEX IF NOT EXISTS "UploadedFile_kind_createdAt_idx" ON "UploadedFile"("kind", "createdAt");
