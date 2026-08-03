-- CreateTable
CREATE TABLE "AgentArtifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "sourcePath" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentArtifact_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentArtifact_sessionId_sourcePath_key" ON "AgentArtifact"("sessionId", "sourcePath");

-- CreateIndex
CREATE INDEX "AgentArtifact_sessionId_idx" ON "AgentArtifact"("sessionId");

-- CreateIndex
CREATE INDEX "AgentArtifact_hash_idx" ON "AgentArtifact"("hash");
