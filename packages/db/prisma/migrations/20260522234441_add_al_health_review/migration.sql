-- CreateTable
CREATE TABLE "ALHealthReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "issueKey" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ALHealthReview_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ALHealthReview_projectId_idx" ON "ALHealthReview"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ALHealthReview_projectId_issueKey_key" ON "ALHealthReview"("projectId", "issueKey");
