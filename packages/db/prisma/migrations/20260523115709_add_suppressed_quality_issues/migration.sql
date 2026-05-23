-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Translation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "xliffFileId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "target" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT 'needs-translation',
    "note" TEXT,
    "developerNote" TEXT,
    "syncChangedAt" DATETIME,
    "syncChangeType" TEXT,
    "suppressedQualityIssues" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Translation_xliffFileId_fkey" FOREIGN KEY ("xliffFileId") REFERENCES "XliffFile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Translation" ("createdAt", "developerNote", "id", "note", "projectId", "source", "state", "syncChangeType", "syncChangedAt", "target", "unitId", "updatedAt", "xliffFileId") SELECT "createdAt", "developerNote", "id", "note", "projectId", "source", "state", "syncChangeType", "syncChangedAt", "target", "unitId", "updatedAt", "xliffFileId" FROM "Translation";
DROP TABLE "Translation";
ALTER TABLE "new_Translation" RENAME TO "Translation";
CREATE INDEX "Translation_projectId_idx" ON "Translation"("projectId");
CREATE INDEX "Translation_state_idx" ON "Translation"("state");
CREATE INDEX "Translation_syncChangedAt_idx" ON "Translation"("syncChangedAt");
CREATE UNIQUE INDEX "Translation_xliffFileId_unitId_key" ON "Translation"("xliffFileId", "unitId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
