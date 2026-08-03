import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  findVisualizationFile,
  wrapVisualizationFragment,
} from '../agent-visualization.service.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-tower-visualization-'));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('agent visualization service helpers', () => {
  it('finds a visualization only inside the matching Codex thread directory', async () => {
    const codexHome = await makeTempDir();
    const threadId = '019f69e3-92e6-7a92-86a6-34b9e8865591';
    const threadDir = path.join(codexHome, 'visualizations', '2026', '07', '21', threadId);
    const filePath = path.join(threadDir, 'agent-tower-architecture.html');
    await fs.mkdir(threadDir, { recursive: true });
    await fs.writeFile(filePath, '<div>Architecture</div>');

    await expect(findVisualizationFile(codexHome, threadId, 'agent-tower-architecture.html'))
      .resolves.toBe(await fs.realpath(filePath));
    await expect(findVisualizationFile(codexHome, threadId, '../secret.html'))
      .resolves.toBeNull();
  });

  it('rejects a visualization symlink that escapes the Codex visualization root', async () => {
    const codexHome = await makeTempDir();
    const outside = await makeTempDir();
    const threadId = 'thread-1';
    const dateDir = path.join(codexHome, 'visualizations', '2026', '07', '21');
    await fs.mkdir(dateDir, { recursive: true });
    await fs.writeFile(path.join(outside, 'escape.html'), '<div>secret</div>');
    await fs.symlink(outside, path.join(dateDir, threadId));

    await expect(findVisualizationFile(codexHome, threadId, 'escape.html')).resolves.toBeNull();
  });

  it('rejects a file symlink into a different Codex thread', async () => {
    const codexHome = await makeTempDir();
    const dateDir = path.join(codexHome, 'visualizations', '2026', '07', '21');
    const sourceThreadDir = path.join(dateDir, 'thread-1');
    const otherThreadDir = path.join(dateDir, 'thread-2');
    await fs.mkdir(sourceThreadDir, { recursive: true });
    await fs.mkdir(otherThreadDir, { recursive: true });
    await fs.writeFile(path.join(otherThreadDir, 'result.html'), '<div>other thread</div>');
    await fs.symlink(
      path.join(otherThreadDir, 'result.html'),
      path.join(sourceThreadDir, 'result.html'),
    );

    await expect(findVisualizationFile(codexHome, 'thread-1', 'result.html')).resolves.toBeNull();
  });

  it('wraps a Codex fragment in the Preview runtime document', () => {
    const html = wrapVisualizationFragment('<div id="visual">Result</div>', 'result.html');

    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<div id="visual">Result</div>');
    expect(html).toContain('--viz-series-1');
    expect(html).toContain('lucide@0.563.0');
  });
});
