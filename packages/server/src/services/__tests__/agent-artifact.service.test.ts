import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentArtifactService as AgentArtifactServiceType } from '../agent-artifact.service.js';

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-tower-artifacts-'));
const dataDir = path.join(testRoot, 'data');
const dbPath = path.join(dataDir, 'test.db');
const workspaceDir = path.join(testRoot, 'workspace');
process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;
process.env.AGENT_TOWER_DATA_DIR = dataDir;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, '../../..');
const schemaPath = path.join(serverRoot, 'prisma/schema.prisma');

let prisma: PrismaClient;
let service: AgentArtifactServiceType;

async function seedSession() {
  const project = await prisma.project.create({
    data: { name: 'Artifacts', repoPath: workspaceDir },
  });
  const task = await prisma.task.create({
    data: { title: 'Create deliverable', projectId: project.id },
  });
  const workspace = await prisma.workspace.create({
    data: {
      taskId: task.id,
      branchName: 'feature/artifacts',
      worktreePath: workspaceDir,
      workingDir: workspaceDir,
    },
  });
  return prisma.session.create({
    data: {
      workspaceId: workspace.id,
      agentType: 'CODEX',
      prompt: 'Create the report',
    },
  });
}

describe('AgentArtifactService', () => {
  beforeAll(async () => {
    await fs.mkdir(dataDir, { recursive: true });
    execFileSync(
      'pnpm',
      ['exec', 'prisma', 'db', 'push', '--skip-generate', `--schema=${schemaPath}`],
      {
        cwd: serverRoot,
        env: { ...process.env, AGENT_TOWER_DATABASE_URL: `file:${dbPath}` },
        stdio: 'pipe',
      },
    );
    const [{ AgentArtifactService }, utils] = await Promise.all([
      import('../agent-artifact.service.js'),
      import('../../utils/index.js'),
    ]);
    prisma = utils.prisma;
    service = new AgentArtifactService(dataDir);
  });

  beforeEach(async () => {
    await prisma.agentArtifact.deleteMany();
    await prisma.session.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.task.deleteMany();
    await prisma.project.deleteMany();
    await fs.rm(workspaceDir, { recursive: true, force: true });
    await fs.rm(path.join(dataDir, 'artifacts'), { recursive: true, force: true });
    await fs.mkdir(workspaceDir, { recursive: true });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  it('keeps a verified published copy after the workspace file is removed', async () => {
    const session = await seedSession();
    const outputDir = path.join(workspaceDir, 'output');
    await fs.mkdir(outputDir);
    await fs.writeFile(path.join(outputDir, 'report.txt'), 'final report');

    const published = await service.publish(session.id, 'output/report.txt');
    await fs.rm(workspaceDir, { recursive: true, force: true });
    const downloadable = await service.findOrPublish(session.id, 'output/report.txt');

    expect(downloadable.id).toBe(published.id);
    expect(downloadable.mimeType).toBe('text/plain');
    expect(downloadable.sizeBytes).toBe(Buffer.byteLength('final report'));
    await expect(fs.readFile(downloadable.storagePath, 'utf8')).resolves.toBe('final report');
  });

  it('rejects traversal and symlinks instead of reading outside the working directory', async () => {
    const session = await seedSession();
    const outsideFile = path.join(testRoot, 'secret.txt');
    await fs.writeFile(outsideFile, 'secret');
    await fs.symlink(outsideFile, path.join(workspaceDir, 'linked-secret.txt'));

    await expect(service.publish(session.id, '../secret.txt')).rejects.toMatchObject({
      code: 'INVALID_ARTIFACT_PATH',
    });
    await expect(service.publish(session.id, 'linked-secret.txt')).rejects.toMatchObject({
      code: 'INVALID_ARTIFACT_PATH',
    });
  });

  it('publishes files declared by assistant output before workspace cleanup', async () => {
    const session = await seedSession();
    await fs.mkdir(path.join(workspaceDir, 'output'));
    await fs.writeFile(path.join(workspaceDir, 'output', 'summary.csv'), 'name,value\nready,1\n');
    await prisma.session.update({
      where: { id: session.id },
      data: {
        logSnapshot: JSON.stringify({
          entries: [{
            id: 'assistant-1',
            timestamp: Date.now(),
            entryType: 'assistant_message',
            content: 'Ready.\n::agent-download{file="output/summary.csv"}',
          }],
        }),
      },
    });

    await expect(service.publishDeclaredArtifacts(session.id)).resolves.toEqual({
      published: 1,
      failed: 0,
    });
    await fs.rm(workspaceDir, { recursive: true, force: true });
    const downloadable = await service.findOrPublish(session.id, 'output/summary.csv');

    expect(downloadable.mimeType).toBe('text/csv');
    await expect(fs.readFile(downloadable.storagePath, 'utf8')).resolves.toBe('name,value\nready,1\n');
  });

  it('detects a modified managed copy before download', async () => {
    const session = await seedSession();
    await fs.writeFile(path.join(workspaceDir, 'result.txt'), 'original');
    const published = await service.publish(session.id, 'result.txt');
    await fs.writeFile(published.storagePath, 'tampered');
    await fs.rm(workspaceDir, { recursive: true, force: true });

    await expect(service.findOrPublish(session.id, 'result.txt')).rejects.toMatchObject({
      code: 'WORKING_DIR_NOT_FOUND',
    });
  });
});
