-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "customerId" TEXT,
    "projectId" TEXT,
    "modelProvider" TEXT NOT NULL DEFAULT 'github-models',
    "systemPrompt" TEXT,
    "triggerType" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "builtIn" BOOLEAN NOT NULL DEFAULT false,
    "type" TEXT NOT NULL DEFAULT 'prompt',
    "promptTemplate" TEXT,
    "inputSchema" TEXT,
    "outputSchema" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AgentSkill" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentSkill_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentSkill_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MCPConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "customerId" TEXT,
    "projectId" TEXT,
    "type" TEXT NOT NULL,
    "baseUrl" TEXT,
    "authType" TEXT NOT NULL DEFAULT 'pat',
    "encryptedCredential" TEXT,
    "credentialIv" TEXT,
    "credentialTag" TEXT,
    "capabilities" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AgentMCPConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "mcpConnectionId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentMCPConnection_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentMCPConnection_mcpConnectionId_fkey" FOREIGN KEY ("mcpConnectionId") REFERENCES "MCPConnection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "input" TEXT,
    "output" TEXT,
    "logs" TEXT,
    "error" TEXT,
    "startedAt" DATETIME,
    "endedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentRun_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Agent_customerId_idx" ON "Agent"("customerId");

-- CreateIndex
CREATE INDEX "Agent_projectId_idx" ON "Agent"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Skill_name_builtIn_key" ON "Skill"("name", "builtIn");

-- CreateIndex
CREATE INDEX "AgentSkill_agentId_idx" ON "AgentSkill"("agentId");

-- CreateIndex
CREATE INDEX "AgentSkill_skillId_idx" ON "AgentSkill"("skillId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentSkill_agentId_skillId_key" ON "AgentSkill"("agentId", "skillId");

-- CreateIndex
CREATE INDEX "MCPConnection_customerId_idx" ON "MCPConnection"("customerId");

-- CreateIndex
CREATE INDEX "MCPConnection_projectId_idx" ON "MCPConnection"("projectId");

-- CreateIndex
CREATE INDEX "AgentMCPConnection_agentId_idx" ON "AgentMCPConnection"("agentId");

-- CreateIndex
CREATE INDEX "AgentMCPConnection_mcpConnectionId_idx" ON "AgentMCPConnection"("mcpConnectionId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentMCPConnection_agentId_mcpConnectionId_key" ON "AgentMCPConnection"("agentId", "mcpConnectionId");

-- CreateIndex
CREATE INDEX "AgentRun_agentId_idx" ON "AgentRun"("agentId");

-- CreateIndex
CREATE INDEX "AgentRun_status_idx" ON "AgentRun"("status");
