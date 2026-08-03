const MAX_CODEX_RAW_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_TOOL_OUTPUT_PREVIEW_CHARS = 32 * 1024;
const MAX_TERMINAL_DELTA_CHARS = 64 * 1024;
const TRUNCATED_MARKER = '\n[TRUNCATED]\n';

export const codexAcpMaxStdoutFrameBytes = MAX_CODEX_RAW_FRAME_BYTES;

/** Bounds codex-acp's duplicated aggregate command output before it reaches the ACP SDK. */
export function normalizeCodexAcpStdoutFrame(
  frame: Record<string, unknown>,
): Record<string, unknown> {
  if (frame.method !== 'session/update') return frame;
  const params = asRecord(frame.params);
  const update = asRecord(params?.update);
  if (!update || update.sessionUpdate !== 'tool_call_update') return frame;

  const rawOutput = asRecord(update.rawOutput);
  const formattedOutput = rawOutput?.formatted_output;
  if (rawOutput && typeof formattedOutput === 'string') {
    rawOutput.formatted_output = boundedPreview(formattedOutput, MAX_TOOL_OUTPUT_PREVIEW_CHARS);
  }

  const meta = asRecord(update._meta);
  if (!meta) return frame;
  const terminalKeys = ['terminal_output_delta', 'terminal_output'] as const;
  for (const key of terminalKeys) {
    const terminalOutput = asRecord(meta[key]);
    if (!terminalOutput || typeof terminalOutput.data !== 'string') continue;

    if (isTerminalStatus(update.status) && typeof formattedOutput === 'string') {
      delete meta[key];
      continue;
    }
    terminalOutput.data = boundedPreview(terminalOutput.data, MAX_TERMINAL_DELTA_CHARS);
  }
  return frame;
}

function isTerminalStatus(value: unknown): boolean {
  return value === 'completed' || value === 'failed';
}

function boundedPreview(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const available = maxLength - TRUNCATED_MARKER.length;
  const headLength = Math.floor(available * 0.75);
  const tailLength = available - headLength;
  return `${value.slice(0, headLength)}${TRUNCATED_MARKER}${value.slice(-tailLength)}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
