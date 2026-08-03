import { describe, expect, it } from 'vitest';
import { AcpProcessManager, type AcpProcessExit } from '../acp/process-manager.js';
import {
  codexAcpMaxStdoutFrameBytes,
  normalizeCodexAcpStdoutFrame,
} from '../acp/agents/codex-frame-normalizer.js';

function managerFor(
  source: string,
  options: Partial<ConstructorParameters<typeof AcpProcessManager>[0]> = {},
) {
  return new AcpProcessManager({
    command: process.execPath,
    args: ['-e', source],
    cwd: process.cwd(),
    env: { ...process.env },
    ...options,
  });
}

function waitForExit(manager: AcpProcessManager): Promise<AcpProcessExit> {
  return new Promise((resolve) => manager.onExit(resolve));
}

describe('AcpProcessManager', () => {
  it('forwards valid NDJSON and bounds/redacts stderr diagnostics', async () => {
    const manager = managerFor([
      "process.stderr.write('authorization: token-secretvalue123\\n')",
      "process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{ok:true}})+'\\n')",
    ].join(';'));
    const streams = await manager.start();
    const exit = waitForExit(manager);
    const reader = streams.output.getReader();
    const decoder = new TextDecoder();
    let output = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += decoder.decode(chunk.value, { stream: true });
    }

    expect(JSON.parse(output.trim())).toMatchObject({ id: 1, result: { ok: true } });
    await expect(exit).resolves.toMatchObject({
      exitCode: 0,
      stderrExcerpt: expect.stringContaining('[REDACTED]'),
    });
  });

  it('rejects malformed ACP stdout frames', async () => {
    const manager = managerFor("process.stdout.write('not-json\\n')");
    const streams = await manager.start();
    const reader = streams.output.getReader();

    await expect(reader.read()).rejects.toMatchObject({ code: 'protocol_violation' });
    await waitForExit(manager);
  });

  it('keeps the default one MiB limit for agents without a frame normalizer', async () => {
    const manager = managerFor([
      "const output='x'.repeat(600*1024)",
      "const update={rawOutput:{formatted_output:output},_meta:{terminal_output_delta:{data:output}}}",
      "process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{update}})+'\\n')",
    ].join(';'));
    const streams = await manager.start();

    await expect(streams.output.getReader().read()).rejects.toMatchObject({ code: 'protocol_violation' });
    await manager.stop();
  });

  it('normalizes duplicated Codex command output before enforcing the SDK frame limit', async () => {
    const manager = managerFor([
      "const output='x'.repeat(600*1024)",
      "const update={sessionUpdate:'tool_call_update',toolCallId:'tool-1',status:'completed',rawOutput:{formatted_output:output,exit_code:0},_meta:{terminal_output_delta:{data:output,terminal_id:'tool-1'}}}",
      "process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'session-1',update}})+'\\n')",
    ].join(';'), {
      maxStdoutFrameBytes: codexAcpMaxStdoutFrameBytes,
      transformStdoutFrame: normalizeCodexAcpStdoutFrame,
    });
    const streams = await manager.start();
    const exit = waitForExit(manager);
    const reader = streams.output.getReader();
    const decoder = new TextDecoder();
    let output = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += decoder.decode(chunk.value, { stream: true });
    }

    const frame = JSON.parse(output.trim());
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThan(1024 * 1024);
    expect(frame.params.update.rawOutput.formatted_output).toContain('[TRUNCATED]');
    expect(frame.params.update.rawOutput.formatted_output.length).toBeLessThanOrEqual(32 * 1024);
    expect(frame.params.update._meta).not.toHaveProperty('terminal_output_delta');
    await expect(exit).resolves.toMatchObject({ exitCode: 0 });
  });

  it('terminates the detached adapter process on stop', async () => {
    const manager = managerFor("process.on('SIGTERM',()=>process.exit(0));process.stdout.write('{}\\n');setInterval(()=>{},1000)");
    const streams = await manager.start();
    await streams.output.getReader().read();

    await expect(manager.stop()).resolves.toMatchObject({ exitCode: 0 });
  });
});
