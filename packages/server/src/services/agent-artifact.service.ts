import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  extractAgentDownloadPaths,
  normalizeAgentDownloadPath,
} from '@agent-tower/shared';
import type { NormalizedConversation } from '../output/types.js';
import { sessionMsgStoreManager } from '../output/index.js';
import { SessionContext } from '../types/index.js';
import { prisma } from '../utils/index.js';
import { resolveDataDir } from '../utils/data-dir.js';
import { getWorkspaceWorkingDir } from './workspace-kind.js';

const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
const MAX_DECLARED_ARTIFACTS_PER_TURN = 20;

const MIME_TYPES: Record<string, string> = {
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.wav': 'audio/wav',
  '.webp': 'image/webp',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
};

export type AgentArtifactErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'WORKING_DIR_NOT_FOUND'
  | 'INVALID_ARTIFACT_PATH'
  | 'ARTIFACT_NOT_FOUND'
  | 'ARTIFACT_NOT_FILE'
  | 'ARTIFACT_TOO_LARGE'
  | 'ARTIFACT_STORAGE_INVALID';

export class AgentArtifactError extends Error {
  constructor(
    readonly code: AgentArtifactErrorCode,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'AgentArtifactError';
  }
}

export interface AgentArtifactDownload {
  id: string;
  sourcePath: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  hash: string;
}

function isSameOrChildPath(candidate: string, base: string): boolean {
  const relative = path.relative(base, candidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

function mimeTypeFor(fileName: string): string {
  return MIME_TYPES[path.extname(fileName).toLowerCase()] ?? 'application/octet-stream';
}

function snapshotForSession(sessionId: string, serialized: string | null): NormalizedConversation | null {
  const live = sessionMsgStoreManager.get(sessionId)?.getSnapshot();
  if (live) return live;
  if (!serialized) return null;
  try {
    return JSON.parse(serialized) as NormalizedConversation;
  } catch {
    return null;
  }
}

function latestTurnAssistantContents(snapshot: NormalizedConversation): string[] {
  let latestUserIndex = -1;
  for (let index = snapshot.entries.length - 1; index >= 0; index--) {
    if (snapshot.entries[index]?.entryType === 'user_message') {
      latestUserIndex = index;
      break;
    }
  }
  return snapshot.entries
    .slice(latestUserIndex + 1)
    .filter((entry) => entry.entryType === 'assistant_message')
    .map((entry) => entry.content);
}

export class AgentArtifactService {
  private readonly storageRoot: string;

  constructor(dataDir = resolveDataDir()) {
    this.storageRoot = path.join(dataDir, 'artifacts');
  }

  async publish(sessionId: string, requestedPath: string): Promise<AgentArtifactDownload> {
    const sourcePath = normalizeAgentDownloadPath(requestedPath);
    if (!sourcePath) {
      throw new AgentArtifactError(
        'INVALID_ARTIFACT_PATH',
        400,
        'Artifact path must be a safe path relative to the session working directory',
      );
    }

    const workingDir = await this.findSessionWorkingDir(sessionId);
    let workingDirReal: string;
    try {
      workingDirReal = await fs.realpath(workingDir);
    } catch {
      throw new AgentArtifactError('WORKING_DIR_NOT_FOUND', 404, 'Session working directory not found');
    }

    const candidate = path.resolve(workingDirReal, ...sourcePath.split('/'));
    if (!isSameOrChildPath(candidate, workingDirReal)) {
      throw new AgentArtifactError('INVALID_ARTIFACT_PATH', 400, 'Artifact path is outside the session working directory');
    }

    let sourceReal: string;
    let sourceStat;
    try {
      const sourceLinkStat = await fs.lstat(candidate);
      if (sourceLinkStat.isSymbolicLink()) {
        throw new AgentArtifactError('INVALID_ARTIFACT_PATH', 400, 'Artifact cannot be a symbolic link');
      }
      sourceReal = await fs.realpath(candidate);
      if (!isSameOrChildPath(sourceReal, workingDirReal)) {
        throw new AgentArtifactError('INVALID_ARTIFACT_PATH', 400, 'Artifact path is outside the session working directory');
      }
      sourceStat = await fs.stat(sourceReal);
    } catch (error) {
      if (error instanceof AgentArtifactError) throw error;
      throw new AgentArtifactError('ARTIFACT_NOT_FOUND', 404, 'Artifact file not found');
    }

    if (!sourceStat.isFile()) {
      throw new AgentArtifactError('ARTIFACT_NOT_FILE', 400, 'Artifact path is not a file');
    }
    if (sourceStat.size > MAX_ARTIFACT_BYTES) {
      throw new AgentArtifactError('ARTIFACT_TOO_LARGE', 413, 'Artifact exceeds the 50 MB limit');
    }

    const tempDir = path.join(this.storageRoot, '.tmp');
    await fs.mkdir(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, randomUUID());
    try {
      await fs.copyFile(sourceReal, tempPath, fsConstants.COPYFILE_EXCL);
      const copiedStat = await fs.stat(tempPath);
      if (!copiedStat.isFile()) {
        throw new AgentArtifactError('ARTIFACT_NOT_FILE', 400, 'Artifact path is not a file');
      }
      if (copiedStat.size > MAX_ARTIFACT_BYTES) {
        throw new AgentArtifactError('ARTIFACT_TOO_LARGE', 413, 'Artifact exceeds the 50 MB limit');
      }

      const hash = await hashFile(tempPath);
      const artifactDir = path.join(this.storageRoot, hash.slice(0, 2));
      const storagePath = path.join(artifactDir, hash);
      await fs.mkdir(artifactDir, { recursive: true });
      try {
        await fs.copyFile(tempPath, storagePath, fsConstants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }

      const originalName = path.posix.basename(sourcePath);
      return prisma.agentArtifact.upsert({
        where: { sessionId_sourcePath: { sessionId, sourcePath } },
        create: {
          sessionId,
          sourcePath,
          originalName,
          mimeType: mimeTypeFor(originalName),
          sizeBytes: copiedStat.size,
          storagePath,
          hash,
        },
        update: {
          originalName,
          mimeType: mimeTypeFor(originalName),
          sizeBytes: copiedStat.size,
          storagePath,
          hash,
        },
      });
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  async findOrPublish(sessionId: string, requestedPath: string): Promise<AgentArtifactDownload> {
    const sourcePath = normalizeAgentDownloadPath(requestedPath);
    if (!sourcePath) {
      throw new AgentArtifactError(
        'INVALID_ARTIFACT_PATH',
        400,
        'Artifact path must be a safe path relative to the session working directory',
      );
    }

    const existing = await prisma.agentArtifact.findUnique({
      where: { sessionId_sourcePath: { sessionId, sourcePath } },
    });
    if (existing) {
      try {
        await this.verifyStoredArtifact(existing);
        return existing;
      } catch (error) {
        if (!(error instanceof AgentArtifactError)) throw error;
      }
    }

    return this.publish(sessionId, sourcePath);
  }

  async publishDeclaredArtifacts(sessionId: string): Promise<{ published: number; failed: number }> {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { logSnapshot: true },
    });
    if (!session) return { published: 0, failed: 0 };

    const contents: string[] = [];
    const snapshot = snapshotForSession(sessionId, session.logSnapshot);
    if (snapshot) {
      contents.push(...latestTurnAssistantContents(snapshot));
    }

    const invocations = await prisma.agentInvocation.findMany({
      where: { sessionId },
      select: { id: true },
    });
    if (invocations.length > 0) {
      const roomMessages = await prisma.roomMessage.findMany({
        where: { senderInvocationId: { in: invocations.map((invocation) => invocation.id) } },
        select: { content: true },
      });
      contents.push(...roomMessages.map((message) => message.content));
    }

    const paths = [...new Set(contents.flatMap(extractAgentDownloadPaths))]
      .slice(0, MAX_DECLARED_ARTIFACTS_PER_TURN);
    let published = 0;
    let failed = 0;
    for (const sourcePath of paths) {
      try {
        await this.publish(sessionId, sourcePath);
        published++;
      } catch {
        failed++;
      }
    }
    return { published, failed };
  }

  private async findSessionWorkingDir(sessionId: string): Promise<string> {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: {
        context: true,
        conversationId: true,
        workspace: { select: { workspaceKind: true, workingDir: true, worktreePath: true } },
        conversation: { select: { workingDir: true, deletedAt: true } },
      },
    });
    if (!session) {
      throw new AgentArtifactError('SESSION_NOT_FOUND', 404, 'Session not found');
    }

    if (session.context === SessionContext.CONVERSATION || session.conversationId) {
      if (!session.conversation || session.conversation.deletedAt) {
        throw new AgentArtifactError('WORKING_DIR_NOT_FOUND', 404, 'Session working directory not found');
      }
      return session.conversation.workingDir;
    }
    if (!session.workspace) {
      throw new AgentArtifactError('WORKING_DIR_NOT_FOUND', 404, 'Session working directory not found');
    }
    return getWorkspaceWorkingDir(session.workspace);
  }

  private async verifyStoredArtifact(artifact: AgentArtifactDownload): Promise<void> {
    let storageRootReal: string;
    let fileReal: string;
    let stat;
    try {
      storageRootReal = await fs.realpath(this.storageRoot);
      const linkStat = await fs.lstat(artifact.storagePath);
      if (linkStat.isSymbolicLink()) throw new Error('symbolic link');
      fileReal = await fs.realpath(artifact.storagePath);
      stat = await fs.stat(fileReal);
    } catch {
      throw new AgentArtifactError('ARTIFACT_STORAGE_INVALID', 404, 'Published artifact is unavailable');
    }

    if (!isSameOrChildPath(fileReal, storageRootReal) || !stat.isFile() || stat.size !== artifact.sizeBytes) {
      throw new AgentArtifactError('ARTIFACT_STORAGE_INVALID', 404, 'Published artifact is unavailable');
    }
    if (await hashFile(fileReal) !== artifact.hash) {
      throw new AgentArtifactError('ARTIFACT_STORAGE_INVALID', 404, 'Published artifact failed integrity verification');
    }
  }
}
