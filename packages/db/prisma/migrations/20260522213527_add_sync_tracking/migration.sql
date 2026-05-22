-- AlterTable
ALTER TABLE "Translation" ADD COLUMN "syncChangeType" TEXT;
ALTER TABLE "Translation" ADD COLUMN "syncChangedAt" DATETIME;

-- AlterTable
ALTER TABLE "XliffFile" ADD COLUMN "lastSyncAt" DATETIME;

-- CreateIndex
CREATE INDEX "Translation_syncChangedAt_idx" ON "Translation"("syncChangedAt");
