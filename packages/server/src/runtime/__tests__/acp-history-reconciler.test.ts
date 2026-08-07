import { describe, expect, it } from 'vitest';
import type { NormalizedEntry } from '../../output/index.js';
import { reconcileAcpHistoryEntries } from '../acp/history-reconciler.js';

function entry(
  id: string,
  content: string,
  entryType: NormalizedEntry['entryType'] = 'assistant_message',
  timestamp = 1,
): NormalizedEntry {
  return { id, content, entryType, timestamp };
}

describe('reconcileAcpHistoryEntries', () => {
  it('does nothing when replayed history already exists locally', () => {
    const local = [entry('acp-message-one', 'complete', 'assistant_message', 10)];
    const replayed = [entry('acp-message-one', 'complete', 'assistant_message', 20)];

    expect(reconcileAcpHistoryEntries(local, replayed)).toBeUndefined();
  });

  it('replaces a partial stable message without duplicating it', () => {
    const local = [entry('acp-message-one', 'part', 'assistant_message', 10)];
    const replayed = [entry('acp-message-one', 'partial response completed', 'assistant_message', 20)];

    expect(reconcileAcpHistoryEntries(local, replayed)).toEqual([
      entry('acp-message-one', 'partial response completed', 'assistant_message', 10),
    ]);
  });

  it('matches replayed assistant messages when Codex changes live IDs to history item IDs', () => {
    const local = [entry('acp-message-live-msg', 'same response', 'assistant_message', 10)];
    const replayed = [entry('acp-message-history-item', 'same response', 'assistant_message', 20)];

    expect(reconcileAcpHistoryEntries(local, replayed)).toBeUndefined();
  });

  it('completes an ID-drifted partial assistant message in place', () => {
    const local = [entry('acp-message-live-msg', 'partial response', 'assistant_message', 10)];
    const replayed = [entry('acp-message-history-item', 'partial response completed', 'assistant_message', 20)];

    expect(reconcileAcpHistoryEntries(local, replayed)).toEqual([
      entry('acp-message-live-msg', 'partial response completed', 'assistant_message', 10),
    ]);
  });

  it('matches replayed thinking when load combines multiple live reasoning entries', () => {
    const local = [
      entry('acp-thought-live-one', 'Plan the ', 'thinking'),
      entry('acp-tool-read', 'read output', 'tool_use'),
      entry('acp-thought-live-two', 'implementation', 'thinking'),
    ];
    const replayed = [entry('acp-thought-history-item', 'Plan theimplementation', 'thinking')];

    expect(reconcileAcpHistoryEntries(local, replayed)).toBeUndefined();
  });

  it('keeps legitimate repeated assistant messages using occurrence-aware matching', () => {
    const local = [entry('acp-message-live-one', 'Done')];
    const replayed = [
      entry('acp-message-history-one', 'Done'),
      entry('acp-message-history-two', 'Done'),
    ];

    expect(reconcileAcpHistoryEntries(local, replayed)).toEqual([
      local[0],
      replayed[1],
    ]);
  });

  it('inserts missing loaded history before the current local user message', () => {
    const local = [
      entry('acp-message-live-one', 'Known response'),
      entry('current-user', 'Continue', 'user_message'),
    ];
    const replayed = [
      entry('acp-message-history-one', 'Known response'),
      entry('acp-message-history-two', 'Recovered response'),
    ];

    expect(reconcileAcpHistoryEntries(local, replayed, {
      historyBoundaryEntryId: 'current-user',
    })).toEqual([
      local[0],
      replayed[1],
      local[1],
    ]);
  });

  it('appends stable messages and tools that are missing locally', () => {
    const local = [entry('local-user', 'continue', 'user_message')];
    const replayed = [
      entry('acp-message-two', 'answer'),
      entry('acp-tool-read', 'read output', 'tool_use'),
    ];

    expect(reconcileAcpHistoryEntries(local, replayed)).toEqual([...local, ...replayed]);
  });

  it('updates stable plan and usage entries in place', () => {
    const local = [
      entry('acp-plan', 'old plan', 'tool_use'),
      entry('acp-usage', '10 tokens', 'token_usage_info'),
    ];
    const replayed = [
      entry('acp-plan', 'current plan', 'tool_use'),
      entry('acp-usage', '20 tokens', 'token_usage_info'),
    ];

    expect(reconcileAcpHistoryEntries(local, replayed)).toEqual(replayed);
  });

  it('heals duplicate local ACP identities', () => {
    const local = [
      entry('acp-message-one', 'partial'),
      entry('acp-message-one', 'duplicate partial'),
    ];

    expect(reconcileAcpHistoryEntries(local, [])).toEqual([
      entry('acp-message-one', 'partial'),
    ]);
  });

  it('matches anonymous entries by occurrence instead of collapsing equal entries globally', () => {
    const anonymous = entry('random-one', 'same warning', 'warning_message');
    const replayed = [
      entry('random-two', 'same warning', 'warning_message'),
      entry('random-three', 'same warning', 'warning_message'),
    ];

    expect(reconcileAcpHistoryEntries([anonymous], replayed)).toEqual([
      anonymous,
      replayed[1],
    ]);
  });

  it('keeps local user messages authoritative', () => {
    const local = [entry('local-user', 'edited local message', 'user_message')];
    const replayed = [entry('remote-user', 'replayed message', 'user_message')];

    expect(reconcileAcpHistoryEntries(local, replayed)).toBeUndefined();
  });

  it('handles large histories without changing an exact replay', () => {
    const local = Array.from({ length: 5_000 }, (_, index) => (
      entry(`acp-message-${index}`, `message ${index}`, 'assistant_message', index)
    ));
    const replayed = local.map((item) => ({ ...item, timestamp: item.timestamp + 1 }));

    expect(reconcileAcpHistoryEntries(local, replayed)).toBeUndefined();
  });
});
