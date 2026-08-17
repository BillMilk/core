-- Keep the legacy Kanban status untouched while adding an explicit
-- orchestration state and lease fields for dependency-aware workers.
ALTER TABLE "Task" ADD COLUMN "orchestrationStatus" TEXT NOT NULL DEFAULT 'BACKLOG';
ALTER TABLE "Task" ADD COLUMN "orchestrationClaimedBy" TEXT;
ALTER TABLE "Task" ADD COLUMN "orchestrationClaimedAt" DATETIME;
ALTER TABLE "Task" ADD COLUMN "orchestrationHeartbeatAt" DATETIME;
ALTER TABLE "Task" ADD COLUMN "orchestrationAttemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Task" ADD COLUMN "orchestrationLastError" TEXT;

-- Backfill tasks created before orchestration was introduced. Existing DONE
-- tasks are already complete; active tasks can be picked up as RUNNING, while
-- untouched tasks remain in BACKLOG until a Director marks them READY.
UPDATE "Task"
SET "orchestrationStatus" = CASE
  WHEN "status" = 'DONE' THEN 'DONE'
  WHEN "status" = 'IN_PROGRESS' THEN 'RUNNING'
  WHEN "status" = 'IN_REVIEW' THEN 'REVIEW'
  WHEN "status" = 'CANCELLED' THEN 'CANCELLED'
  ELSE 'BACKLOG'
END;

CREATE TABLE "TaskDependency" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "dependsOnTaskId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TaskDependency_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TaskDependency_dependsOnTaskId_fkey" FOREIGN KEY ("dependsOnTaskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "TaskDependency_taskId_dependsOnTaskId_key"
ON "TaskDependency"("taskId", "dependsOnTaskId");
CREATE INDEX "TaskDependency_taskId_idx" ON "TaskDependency"("taskId");
CREATE INDEX "TaskDependency_dependsOnTaskId_idx" ON "TaskDependency"("dependsOnTaskId");

CREATE TABLE "TaskEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "actorType" TEXT NOT NULL DEFAULT 'SYSTEM',
    "actorId" TEXT,
    "payload" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TaskEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TaskEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "TaskEvent_idempotencyKey_key" ON "TaskEvent"("idempotencyKey");
CREATE INDEX "TaskEvent_taskId_createdAt_idx" ON "TaskEvent"("taskId", "createdAt");
CREATE INDEX "TaskEvent_projectId_createdAt_idx" ON "TaskEvent"("projectId", "createdAt");
CREATE INDEX "TaskEvent_type_createdAt_idx" ON "TaskEvent"("type", "createdAt");

CREATE INDEX "Task_projectId_deletedAt_orchestrationStatus_priority_position_idx"
ON "Task"("projectId", "deletedAt", "orchestrationStatus", "priority", "position");
CREATE INDEX "Task_orchestrationStatus_orchestrationHeartbeatAt_idx"
ON "Task"("orchestrationStatus", "orchestrationHeartbeatAt");
