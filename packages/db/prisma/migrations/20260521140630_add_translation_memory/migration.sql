-- CreateTable
CREATE TABLE "TranslationMemory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "sourceLanguage" TEXT NOT NULL,
    "targetLanguage" TEXT NOT NULL,
    "projectId" TEXT,
    "usageCount" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TranslationMemory_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "TranslationMemory_sourceLanguage_targetLanguage_idx" ON "TranslationMemory"("sourceLanguage", "targetLanguage");

-- CreateIndex
CREATE INDEX "TranslationMemory_projectId_idx" ON "TranslationMemory"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "TranslationMemory_source_sourceLanguage_targetLanguage_projectId_key" ON "TranslationMemory"("source", "sourceLanguage", "targetLanguage", "projectId");
