import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentCliExecFile } from '../command-runner.js';
import { findWindowsCommandOnPath, runAgentCliCommand } from '../command-runner.js';

describe('runAgentCliCommand', () => {
  it('resolves Windows commands with where and executes .cmd shims through cmd.exe', async () => {
    const execFileImpl = vi.fn<AgentCliExecFile>(async (command) => {
      if (command === 'where') {
        return {
          stdout: 'C:\\Users\\alice\\AppData\\Roaming\\npm\\codex.cmd\r\n',
          stderr: '',
        };
      }
      return { stdout: 'codex 1.2.3', stderr: '' };
    });

    await runAgentCliCommand(
      { command: 'codex', args: ['--version'], timeoutMs: 5000 },
      {
        platform: 'win32',
        env: {
          PATH: 'C:\\Windows\\System32',
          COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
        },
        execFileImpl,
      }
    );

    expect(execFileImpl).toHaveBeenNthCalledWith(
      1,
      'where',
      ['codex'],
      expect.objectContaining({ shell: false, windowsHide: true })
    );
    expect(execFileImpl).toHaveBeenNthCalledWith(
      2,
      'C:\\Windows\\System32\\cmd.exe',
      [
        '/d',
        '/s',
        '/c',
        '"C:\\Users\\alice\\AppData\\Roaming\\npm\\codex.cmd --version"',
      ],
      expect.objectContaining({
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: true,
      })
    );
  });

  it.skipIf(process.platform !== 'win32')(
    'executes a resolved .cmd shim from a path containing spaces',
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'agent-cli-command-runner-'));
      const binDir = path.join(root, 'Codex CLI');
      const shimPath = path.join(binDir, 'codex.cmd');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(shimPath, '@echo off\r\necho codex-cli 9.8.7\r\n', 'utf8');

      try {
        const result = await runAgentCliCommand(
          { command: shimPath, args: ['--version'], timeoutMs: 5000 },
          {
            platform: 'win32',
            env: {
              PATH: `${process.env.SystemRoot}\\System32`,
              SystemRoot: process.env.SystemRoot,
              ComSpec: process.env.ComSpec,
              PATHEXT: process.env.PATHEXT,
            },
          }
        );

        expect(result.stdout.trim()).toBe('codex-cli 9.8.7');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it('maps Windows lookup failures to command missing', async () => {
    const execFileImpl = vi.fn<AgentCliExecFile>(async () => {
      throw Object.assign(new Error('where exited 1'), { code: 1 });
    });

    await expect(runAgentCliCommand(
      { command: 'missing-tool', args: ['--version'], timeoutMs: 5000 },
      { platform: 'win32', env: { PATH: 'C:\\Windows\\System32' }, execFileImpl }
    )).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('falls back to directly resolving an npm .cmd shim from Windows PATH when where fails', async () => {
    const npmDirectory = 'C:\\Users\\alice user\\AppData\\Roaming\\npm';
    const shimPath = `${npmDirectory}\\codex.cmd`;
    const execFileImpl = vi.fn<AgentCliExecFile>(async (command) => {
      if (command === 'where') {
        throw Object.assign(new Error('where exited 1'), { code: 1 });
      }
      return { stdout: 'codex-cli 1.2.3', stderr: '' };
    });

    const result = await runAgentCliCommand(
      { command: 'codex', args: ['--version'], timeoutMs: 5000 },
      {
        platform: 'win32',
        env: {
          PATH: `C:\\Windows\\System32;"${npmDirectory}"`,
          COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
        },
        execFileImpl,
        windowsFileExists: (candidate) => candidate.toLowerCase() === shimPath.toLowerCase(),
      }
    );

    expect(result.stdout).toBe('codex-cli 1.2.3');
    const escapedShimPath = shimPath.replace(/\\/g, '\\\\');
    expect(execFileImpl).toHaveBeenNthCalledWith(2,
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', `""${escapedShimPath}" --version"`],
      expect.objectContaining({ windowsVerbatimArguments: true })
    );
  });

  it('resolves quoted Windows PATH entries without invoking a subprocess', () => {
    const expected = 'C:\\Program Files\\Codex CLI\\codex.exe';
    expect(findWindowsCommandOnPath(
      'codex',
      { PATH: 'C:\\Windows\\System32;"C:\\Program Files\\Codex CLI"' },
      (candidate) => candidate === expected
    )).toBe(expected);
  });

  it('finds Codex in the official Windows installer directory without restarting', async () => {
    const codexBin = 'C:\\Users\\alice\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin';
    const execFileImpl = vi.fn<AgentCliExecFile>(async (command, _args, options) => {
      if (command === 'where') {
        expect(options.env.PATH?.split(';')).toContain(codexBin);
        return {
          stdout: `${codexBin}\\codex.exe\r\n`,
          stderr: '',
        };
      }
      return { stdout: 'codex-cli 0.144.5', stderr: '' };
    });

    await runAgentCliCommand(
      { command: 'codex', args: ['--version'], timeoutMs: 5000 },
      {
        platform: 'win32',
        env: {
          PATH: 'C:\\Windows\\System32',
          COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
          LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
        },
        execFileImpl,
      }
    );

    expect(execFileImpl).toHaveBeenLastCalledWith(
      `${codexBin}\\codex.exe`,
      ['--version'],
      expect.objectContaining({ shell: false, windowsHide: true })
    );
  });

  it('adds the Cursor official install directory to Windows lookup PATH for verify', async () => {
    const execFileImpl = vi.fn<AgentCliExecFile>(async (command, _args, options) => {
      if (command === 'where') {
        expect(options.env.PATH).toContain('C:\\Users\\alice\\AppData\\Local\\cursor-agent');
        return {
          stdout: 'C:\\Users\\alice\\AppData\\Local\\cursor-agent\\agent.cmd\r\n',
          stderr: '',
        };
      }
      return { stdout: 'agent 1.0.0', stderr: '' };
    });

    await runAgentCliCommand(
      { command: 'agent', args: ['--version'], timeoutMs: 5000 },
      {
        platform: 'win32',
        env: {
          PATH: 'C:\\Windows\\System32',
          COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
          LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
        },
        execFileImpl,
      }
    );

    expect(execFileImpl).toHaveBeenLastCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      [
        '/d',
        '/s',
        '/c',
        '"C:\\Users\\alice\\AppData\\Local\\cursor-agent\\agent.cmd --version"',
      ],
      expect.objectContaining({ shell: false, windowsHide: true })
    );
  });

  it('adds macOS user CLI directories when launched without a shell PATH', async () => {
    const execFileImpl = vi.fn<AgentCliExecFile>(async (_command, _args, options) => {
      expect(options.env.PATH).toContain('/Users/alice/.local/bin');
      expect(options.env.PATH).toContain('/Users/alice/.npm-global/bin');
      expect(options.env.PATH).toContain('/opt/homebrew/bin');
      return { stdout: 'codex 1.2.3', stderr: '' };
    });

    await runAgentCliCommand(
      { command: 'codex', args: ['--version'], timeoutMs: 5000 },
      {
        platform: 'darwin',
        env: {
          PATH: '/usr/bin:/bin',
          HOME: '/Users/alice',
        },
        execFileImpl,
      }
    );

    expect(execFileImpl).toHaveBeenCalledWith(
      'codex',
      ['--version'],
      expect.objectContaining({ shell: false, windowsHide: true })
    );
  });
});
