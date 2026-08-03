import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { NormalizedConversation } from '../output/types.js';
import { sessionMsgStoreManager } from '../output/index.js';
import { getProviderById } from '../executors/index.js';
import { AgentType } from '../types/index.js';
import { prisma } from '../utils/index.js';

const VISUALIZATION_FILE_NAME = /^[a-z0-9][a-z0-9-]*\.html$/;
const THREAD_DIRECTORY_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const DATE_DIRECTORY_PARTS = [/^\d{4}$/, /^(0[1-9]|1[0-2])$/, /^(0[1-9]|[12]\d|3[01])$/];
const MAX_VISUALIZATION_BYTES = 2 * 1024 * 1024;

export type AgentVisualizationErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'NOT_CODEX_SESSION'
  | 'AGENT_SESSION_ID_NOT_FOUND'
  | 'INVALID_VISUALIZATION_FILE'
  | 'VISUALIZATION_NOT_FOUND'
  | 'VISUALIZATION_TOO_LARGE';

export class AgentVisualizationError extends Error {
  constructor(
    readonly code: AgentVisualizationErrorCode,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'AgentVisualizationError';
  }
}

function isSameOrChildPath(candidate: string, base: string): boolean {
  const relative = path.relative(base, candidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function agentSessionIdFromSnapshot(sessionId: string, logSnapshot: string | null): string | null {
  const liveSnapshot = sessionMsgStoreManager.get(sessionId)?.getSnapshot();
  if (liveSnapshot?.sessionId) return liveSnapshot.sessionId;

  if (!logSnapshot) return null;
  try {
    return (JSON.parse(logSnapshot) as NormalizedConversation).sessionId ?? null;
  } catch {
    return null;
  }
}

function resolveCodexHome(providerId: string | null): string {
  const providerEnv = providerId ? getProviderById(providerId)?.env ?? {} : {};
  const effectiveEnv = { ...process.env, ...providerEnv };
  return effectiveEnv.CODEX_HOME
    || path.join(effectiveEnv.HOME || effectiveEnv.USERPROFILE || os.homedir(), '.codex');
}

async function childDirectoryNames(parent: string, pattern: RegExp): Promise<string[]> {
  try {
    const entries = await fs.readdir(parent, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export async function findVisualizationFile(
  codexHome: string,
  threadId: string,
  fileName: string,
): Promise<string | null> {
  if (!THREAD_DIRECTORY_NAME.test(threadId) || !VISUALIZATION_FILE_NAME.test(fileName)) return null;

  const visualizationRoot = path.join(codexHome, 'visualizations');
  let rootReal: string;
  try {
    rootReal = await fs.realpath(visualizationRoot);
  } catch {
    return null;
  }

  const matches: Array<{ path: string; modifiedAt: number }> = [];
  const years = await childDirectoryNames(rootReal, DATE_DIRECTORY_PARTS[0]);
  for (const year of years) {
    const yearDir = path.join(rootReal, year);
    const months = await childDirectoryNames(yearDir, DATE_DIRECTORY_PARTS[1]);
    for (const month of months) {
      const monthDir = path.join(yearDir, month);
      const days = await childDirectoryNames(monthDir, DATE_DIRECTORY_PARTS[2]);
      for (const day of days) {
        const threadDirectory = path.join(monthDir, day, threadId);
        const candidate = path.join(threadDirectory, fileName);
        try {
          const threadStat = await fs.lstat(threadDirectory);
          if (!threadStat.isDirectory() || threadStat.isSymbolicLink()) continue;
          const threadReal = await fs.realpath(threadDirectory);
          if (!isSameOrChildPath(threadReal, rootReal)) continue;

          const candidateStat = await fs.lstat(candidate);
          if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) continue;
          const fileReal = await fs.realpath(candidate);
          if (!isSameOrChildPath(fileReal, threadReal)) continue;
          const stat = await fs.stat(fileReal);
          if (stat.isFile()) matches.push({ path: fileReal, modifiedAt: stat.mtimeMs });
        } catch {
          // A thread may not have produced a visualization on this date.
        }
      }
    }
  }

  matches.sort((left, right) => right.modifiedAt - left.modifiedAt);
  return matches[0]?.path ?? null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function wrapVisualizationFragment(fragment: string, fileName: string): string {
  const title = escapeHtml(fileName.replace(/\.html$/, '').replaceAll('-', ' '));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root {
      color-scheme: light;
      --font-size-base: 14px;
      --background: #ffffff;
      --foreground: #171717;
      --card: #ffffff;
      --card-foreground: #171717;
      --popover: #ffffff;
      --popover-foreground: #171717;
      --primary: #171717;
      --primary-foreground: #ffffff;
      --secondary: #f5f5f5;
      --secondary-foreground: #262626;
      --muted: #f5f5f5;
      --muted-foreground: #737373;
      --accent: #f5f5f5;
      --accent-foreground: #171717;
      --destructive: #dc2626;
      --border: #e5e5e5;
      --input: #d4d4d4;
      --ring: #a3a3a3;
      --viz-series-1: #2563eb;
      --viz-series-2: #059669;
      --viz-series-3: #9333ea;
      --viz-series-4: #d97706;
      --viz-series-5: #dc2626;
      --viz-series-6: #0891b2;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        color-scheme: dark;
        --background: #171717;
        --foreground: #f5f5f5;
        --card: #262626;
        --card-foreground: #f5f5f5;
        --popover: #262626;
        --popover-foreground: #f5f5f5;
        --primary: #f5f5f5;
        --primary-foreground: #171717;
        --secondary: #262626;
        --secondary-foreground: #f5f5f5;
        --muted: #262626;
        --muted-foreground: #a3a3a3;
        --accent: #404040;
        --accent-foreground: #fafafa;
        --destructive: #f87171;
        --border: #404040;
        --input: #525252;
        --ring: #737373;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 20px;
      background: var(--background);
      color: var(--foreground);
      font: 400 var(--font-size-base)/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    button, input, select, textarea { font: inherit; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .card { border: 1px solid var(--border); border-radius: 8px; background: var(--card); color: var(--card-foreground); padding: 16px; }
    .viz-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
    .viz-row, .viz-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .viz-stat-value { font-size: 1.5em; font-weight: 500; }
    .viz-badge { display: inline-flex; align-items: center; border-radius: 999px; background: var(--accent); color: var(--accent-foreground); padding: 2px 8px; }
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 1px solid var(--border); border-radius: 6px; background: var(--secondary); color: var(--secondary-foreground); padding: 6px 10px; cursor: pointer; }
    .btn-primary { background: var(--primary); color: var(--primary-foreground); }
    .btn-ghost { border-color: transparent; background: transparent; }
    .btn-block { width: 100%; }
    .form-label { display: grid; gap: 4px; }
    .form-control, .form-select { min-height: 34px; border: 1px solid var(--input); border-radius: 6px; background: var(--background); color: var(--foreground); padding: 6px 8px; }
    .form-check { display: inline-flex; align-items: center; gap: 6px; }
    .form-range { width: 100%; }
    .text-small { font-size: 0.8em; }
    .text-muted { color: var(--muted-foreground); }
    .text-destructive { color: var(--destructive); }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    [data-lucide] { width: 16px; height: 16px; }
  </style>
</head>
<body>
${fragment}
  <script src="https://unpkg.com/lucide@0.563.0/dist/umd/lucide.js"></script>
  <script>window.lucide?.createIcons({ attrs: { width: 16, height: 16 } });</script>
</body>
</html>`;
}

export class AgentVisualizationService {
  async read(sessionId: string, fileName: string): Promise<string> {
    if (!VISUALIZATION_FILE_NAME.test(fileName)) {
      throw new AgentVisualizationError(
        'INVALID_VISUALIZATION_FILE',
        400,
        'Visualization file must be a lowercase hyphenated HTML filename',
      );
    }

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { agentType: true, providerId: true, logSnapshot: true },
    });
    if (!session) {
      throw new AgentVisualizationError('SESSION_NOT_FOUND', 404, 'Session not found');
    }
    if (session.agentType !== AgentType.CODEX) {
      throw new AgentVisualizationError('NOT_CODEX_SESSION', 400, 'Session is not a Codex session');
    }

    const threadId = agentSessionIdFromSnapshot(sessionId, session.logSnapshot);
    if (!threadId || !THREAD_DIRECTORY_NAME.test(threadId)) {
      throw new AgentVisualizationError(
        'AGENT_SESSION_ID_NOT_FOUND',
        409,
        'Codex thread ID is not available for this session',
      );
    }

    const filePath = await findVisualizationFile(resolveCodexHome(session.providerId), threadId, fileName);
    if (!filePath) {
      throw new AgentVisualizationError('VISUALIZATION_NOT_FOUND', 404, 'Visualization not found');
    }

    const stat = await fs.stat(filePath);
    if (stat.size > MAX_VISUALIZATION_BYTES) {
      throw new AgentVisualizationError(
        'VISUALIZATION_TOO_LARGE',
        413,
        'Visualization exceeds the 2 MB limit',
      );
    }

    return wrapVisualizationFragment(await fs.readFile(filePath, 'utf8'), fileName);
  }
}
