import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Transform, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { AgentRuntimeError } from '../errors.js';
import type { AcpStdoutFrameTransform } from './agents/types.js';

const MAX_STDOUT_LINE_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const DEFAULT_KILL_GRACE_MS = 2_000;

export interface AcpProcessExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderrExcerpt: string;
}

export interface AcpProcessStreams {
  pid: number;
  input: WritableStream<Uint8Array>;
  output: ReadableStream<Uint8Array>;
}

export class AcpProcessManager {
  private child?: ChildProcessWithoutNullStreams;
  private exitPromise?: Promise<AcpProcessExit>;
  private resolveExit?: (exit: AcpProcessExit) => void;
  private settled?: AcpProcessExit;
  private stopPromise?: Promise<AcpProcessExit | undefined>;
  private stderr = '';
  private readonly exitListeners = new Set<(exit: AcpProcessExit) => void>();

  constructor(private readonly launch: {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    maxStdoutFrameBytes?: number;
    transformStdoutFrame?: AcpStdoutFrameTransform;
  }) {}

  async start(): Promise<AcpProcessStreams> {
    if (this.child) {
      throw new AgentRuntimeError('spawn_failed', 'spawn', 'ACP adapter is already running', false);
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.launch.command, this.launch.args, {
        cwd: this.launch.cwd,
        env: this.launch.env,
        detached: process.platform !== 'win32',
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new AgentRuntimeError('spawn_failed', 'spawn', 'Could not start the ACP adapter', true, { cause: error });
    }
    this.child = child;
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderr = appendBounded(this.stderr, sanitizeDiagnostic(chunk), MAX_STDERR_BYTES);
    });

    await new Promise<void>((resolve, reject) => {
      let spawned = false;
      child.once('spawn', () => {
        spawned = true;
        resolve();
      });
      child.once('error', (error) => {
        this.settle({ exitCode: null, signal: null, stderrExcerpt: this.stderr });
        if (!spawned) {
          reject(new AgentRuntimeError('spawn_failed', 'spawn', 'Could not start the ACP adapter', true, { cause: error }));
        }
      });
      child.once('close', (exitCode, signal) => {
        this.settle({ exitCode, signal, stderrExcerpt: this.stderr });
      });
    });

    if (!child.pid) {
      await this.stop();
      throw new AgentRuntimeError('spawn_failed', 'spawn', 'ACP adapter did not report a process id', true);
    }
    const validatedOutput = createValidatedOutput(child.stdout, {
      maxInputFrameBytes: this.launch.maxStdoutFrameBytes ?? MAX_STDOUT_LINE_BYTES,
      transformFrame: this.launch.transformStdoutFrame,
    });
    return {
      pid: child.pid,
      input: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      output: Readable.toWeb(validatedOutput) as ReadableStream<Uint8Array>,
    };
  }

  onExit(listener: (exit: AcpProcessExit) => void): () => void {
    this.exitListeners.add(listener);
    if (this.settled) listener(this.settled);
    return () => this.exitListeners.delete(listener);
  }

  async stop(): Promise<AcpProcessExit | undefined> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<AcpProcessExit | undefined> {
    if (!this.child || !this.exitPromise) return undefined;
    if (this.settled) return this.settled;
    this.signal('SIGTERM');
    const graceful = await within(this.exitPromise, DEFAULT_KILL_GRACE_MS);
    if (graceful) return graceful;
    this.signal('SIGKILL');
    const forced = await within(this.exitPromise, DEFAULT_KILL_GRACE_MS);
    if (forced) return forced;
    throw new AgentRuntimeError(
      'process_exit_timeout',
      'close',
      'ACP adapter did not confirm termination before the shutdown deadline',
      true,
    );
  }

  private signal(signal: NodeJS.Signals): void {
    const child = this.child;
    if (!child?.pid || this.settled) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // A concurrent close event will settle the process.
      }
    }
  }

  private settle(exit: AcpProcessExit): void {
    if (this.settled) return;
    this.settled = { ...exit, stderrExcerpt: this.stderr };
    this.resolveExit?.(this.settled);
    for (const listener of [...this.exitListeners]) listener(this.settled);
  }
}

function createValidatedOutput(
  input: Readable,
  options: {
    maxInputFrameBytes: number;
    transformFrame?: AcpStdoutFrameTransform;
  },
): Readable {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const validator = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        pending += decoder.write(chunk);
        let newlineIndex = pending.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = pending.slice(0, newlineIndex);
          pending = pending.slice(newlineIndex + 1);
          const frame = processFrame(line, options);
          if (frame) this.push(`${frame}\n`);
          newlineIndex = pending.indexOf('\n');
        }
        assertFrameSize(pending, options.maxInputFrameBytes);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback) {
      try {
        pending += decoder.end();
        const frame = processFrame(pending, options);
        if (frame) this.push(frame);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
  input.pipe(validator);
  return validator;
}

function processFrame(
  line: string,
  options: {
    maxInputFrameBytes: number;
    transformFrame?: AcpStdoutFrameTransform;
  },
): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  assertFrameSize(trimmed, options.maxInputFrameBytes);
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    throw new AgentRuntimeError('protocol_violation', 'protocol', 'ACP stdout contained malformed JSON', false, { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentRuntimeError('protocol_violation', 'protocol', 'ACP stdout contained a non-object JSON value', false);
  }
  const normalized = options.transformFrame
    ? options.transformFrame(value as Record<string, unknown>)
    : value as Record<string, unknown>;
  const serialized = JSON.stringify(normalized);
  assertFrameSize(serialized, MAX_STDOUT_LINE_BYTES);
  return serialized;
}

function assertFrameSize(value: string, maxBytes: number): void {
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new AgentRuntimeError('protocol_violation', 'protocol', 'ACP stdout line exceeded the size limit', false);
  }
}

function appendBounded(current: string, next: string, maxBytes: number): string {
  const combined = `${current}${next}`;
  const bytes = Buffer.from(combined, 'utf8');
  if (bytes.length <= maxBytes) return combined;
  return `[TRUNCATED]\n${bytes.subarray(bytes.length - maxBytes + 12).toString('utf8')}`;
}

function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/\b(?:sk|key|token|secret)-[A-Za-z0-9._-]{8,}\b/gi, '[REDACTED]')
    .replace(/(authorization\s*[:=]\s*)([^\s]+)/gi, '$1[REDACTED]');
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
