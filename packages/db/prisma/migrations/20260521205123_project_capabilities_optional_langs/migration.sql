-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "customerId" TEXT,
    "capabilities" TEXT NOT NULL DEFAULT 'translation',
    "connectionId" TEXT,
    "adoProjectName" TEXT,
    "adoAccessScope" TEXT NOT NULL DEFAULT 'org',
    "adoRepoName" TEXT,
    "defaultBranch" TEXT,
    "sourceLanguage" TEXT,
    "targetLanguage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Project_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Project" ("adoAccessScope", "adoProjectName", "adoRepoName", "connectionId", "createdAt", "customerId", "defaultBranch", "description", "id", "name", "sourceLanguage", "targetLanguage", "updatedAt") SELECT "adoAccessScope", "adoProjectName", "adoRepoName", "connectionId", "createdAt", "customerId", "defaultBranch", "description", "id", "name", "sourceLanguage", "targetLanguage", "updatedAt" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE INDEX "Project_customerId_idx" ON "Project"("customerId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
