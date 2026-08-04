const MAX_CODEX_RAW_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_TOOL_OUTPUT_PREVIEW_CHARS = 32 * 1024;
const MAX_TERMINAL_DELTA_CHARS = 32 * 1024;
const MAX_TOOL_META_PREVIEW_CHARS = 64 * 1024;
const TRUNCATED_MARKER = '\n[TRUNCATED]\n';
const TERMINAL_META_KEYS = [
  'terminal_output_delta',
  'terminal_output',
  'terminal_exit',
  'terminal_info',
] as const;

export const codexAcpMaxStdoutFrameBytes = MAX_CODEX_RAW_FRAME_BYTES;

/** Bounds untrusted Codex tool payloads before they reach the shared ACP SDK. */
export function normalizeCodexAcpStdoutFrame(
  frame: Record<string, unknown>,
): Record<string, unknown> {
  if (frame.method !== 'session/update') return frame;
  const params = asRecord(frame.params);
  const update = asRecord(params?.update);
  if (!update || !isToolUpdate(update.sessionUpdate)) return frame;

  boundStringField(update, 'title', 4_096);
  boundStringField(update, 'toolCallId', 4_096);
  boundOpaqueField(update, 'rawInput', MAX_TOOL_OUTPUT_PREVIEW_CHARS);

  const rawOutput = asRecord(update.rawOutput);
  const formattedOutput = rawOutput?.formatted_output;
  if (rawOutput && typeof formattedOutput === 'string') {
    update.rawOutput = {
      formatted_output: boundedPreview(formattedOutput, MAX_TOOL_OUTPUT_PREVIEW_CHARS),
      ...(typeof rawOutput.exit_code === 'number' ? { exit_code: rawOutput.exit_code } : {}),
    };
  } else {
    boundOpaqueField(update, 'rawOutput', MAX_TOOL_OUTPUT_PREVIEW_CHARS);
  }

  if (Array.isArray(update.content)) {
    const normalizedContent = boundedOpaqueValue(update.content, MAX_TOOL_OUTPUT_PREVIEW_CHARS);
    if (normalizedContent !== update.content) {
      update.content = [{
        type: 'content',
        content: {
          type: 'text',
          text: JSON.stringify(normalizedContent),
        },
      }];
    }
  }
  boundOpaqueField(update, 'locations', MAX_TOOL_OUTPUT_PREVIEW_CHARS);

  const meta = asRecord(update._meta);
  if (!meta) return frame;
  for (const key of ['terminal_output_delta', 'terminal_output'] as const) {
    const terminalOutput = asRecord(meta[key]);
    if (!terminalOutput) continue;
    boundStringField(terminalOutput, 'terminal_id', 4_096);
    if (typeof terminalOutput.data !== 'string') continue;

    if (isTerminalStatus(update.status) && typeof formattedOutput === 'string') {
      delete meta[key];
      continue;
    }
    terminalOutput.data = boundedPreview(terminalOutput.data, MAX_TERMINAL_DELTA_CHARS);
  }
  boundToolMeta(update, meta);
  return frame;
}

function isToolUpdate(value: unknown): boolean {
  return value === 'tool_call' || value === 'tool_call_update';
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

function boundStringField(
  target: Record<string, unknown>,
  key: string,
  maxLength: number,
): void {
  const value = target[key];
  if (typeof value === 'string') target[key] = boundedPreview(value, maxLength);
}

function boundOpaqueField(
  target: Record<string, unknown>,
  key: string,
  maxLength: number,
): void {
  if (!Object.prototype.hasOwnProperty.call(target, key)) return;
  target[key] = boundedOpaqueValue(target[key], maxLength);
}

function boundToolMeta(update: Record<string, unknown>, meta: Record<string, unknown>): void {
  if (boundedOpaqueValue(meta, MAX_TOOL_META_PREVIEW_CHARS) === meta) return;
  const boundedMeta: Record<string, unknown> = { _truncated: true };
  for (const key of TERMINAL_META_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(meta, key)) continue;
    boundedMeta[key] = boundedOpaqueValue(
      meta[key],
      key === 'terminal_output_delta' || key === 'terminal_output'
        ? 256 * 1024
        : 4_096,
    );
  }
  update._meta = boundedMeta;
}

function boundedOpaqueValue(value: unknown, maxLength: number): unknown {
  if (typeof value === 'string') return boundedPreview(value, maxLength);
  const serialized = JSON.stringify(value);
  if (serialized === undefined || serialized.length <= maxLength) return value;
  return {
    _truncated: true,
    preview: boundedPreview(serialized, maxLength),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
