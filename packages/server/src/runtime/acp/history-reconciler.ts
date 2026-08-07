import type { NormalizedEntry } from '../../output/index.js';

const STABLE_ACP_ENTRY_PREFIXES = [
  'acp-message-',
  'acp-thought-',
  'acp-tool-',
  'acp-diagnostic-',
];
const STABLE_ACP_ENTRY_IDS = new Set(['acp-plan', 'acp-usage']);

interface AcpHistoryReconcileOptions {
  historyBoundaryEntryId?: string;
}

/**
 * Reconcile history replayed by session/load with the locally persisted log.
 * Stable ACP identities update in place. Text entries also use ordered semantic
 * matching because agents may assign different IDs or chunk boundaries on load.
 */
export function reconcileAcpHistoryEntries(
  localEntries: NormalizedEntry[],
  replayedEntries: NormalizedEntry[],
  options: AcpHistoryReconcileOptions = {},
): NormalizedEntry[] | undefined {
  const boundaryIndex = options.historyBoundaryEntryId
    ? localEntries.findIndex((entry) => entry.id === options.historyBoundaryEntryId)
    : -1;
  const localHistory = boundaryIndex >= 0 ? localEntries.slice(0, boundaryIndex) : localEntries;
  const protectedSuffix = boundaryIndex >= 0 ? localEntries.slice(boundaryIndex) : [];
  const merged: NormalizedEntry[] = [];
  const stableIndexes = new Map<string, number>();
  let changed = false;

  for (const entry of localHistory) {
    if (hasStableAcpIdentity(entry.id)) {
      if (stableIndexes.has(entry.id)) {
        changed = true;
        continue;
      }
      stableIndexes.set(entry.id, merged.length);
    }
    merged.push(entry);
  }

  const anonymousIndexes = new Map<string, number[]>();
  for (let index = 0; index < merged.length; index += 1) {
    const entry = merged[index];
    if (hasStableAcpIdentity(entry.id)
      || entry.entryType === 'user_message'
      || entry.entryType === 'assistant_message'
      || entry.entryType === 'thinking') continue;
    const fingerprint = entryFingerprint(entry);
    const indexes = anonymousIndexes.get(fingerprint) ?? [];
    indexes.push(index);
    anonymousIndexes.set(fingerprint, indexes);
  }
  const anonymousMatches = new Map<string, number>();
  const claimedLocalIndexes = new Set<number>();
  const assistantIndexes = merged.flatMap((entry, index) => (
    entry.entryType === 'assistant_message' ? [index] : []
  ));
  const assistantPositions = new Map(assistantIndexes.map((index, position) => [index, position]));
  let assistantCursor = 0;
  const localStableIds = new Set(merged
    .filter((entry) => hasStableAcpIdentity(entry.id))
    .map((entry) => entry.id));
  const matchedThinkingReplayIndexes = matchReplayedThinkingEntries(
    merged,
    replayedEntries,
    localStableIds,
  );

  for (let replayedIndex = 0; replayedIndex < replayedEntries.length; replayedIndex += 1) {
    const replayed = replayedEntries[replayedIndex];
    if (replayed.entryType === 'user_message') continue;

    if (hasStableAcpIdentity(replayed.id)) {
      const existingIndex = stableIndexes.get(replayed.id);
      if (existingIndex !== undefined) {
        claimedLocalIndexes.add(existingIndex);
        const assistantPosition = assistantPositions.get(existingIndex);
        if (assistantPosition !== undefined) assistantCursor = Math.max(assistantCursor, assistantPosition + 1);

        const existing = merged[existingIndex];
        const replacement = { ...replayed, timestamp: existing.timestamp };
        if (!entriesEqual(existing, replacement)) {
          merged[existingIndex] = replacement;
          changed = true;
        }
        continue;
      }
    }

    if (replayed.entryType === 'assistant_message') {
      const match = findAssistantMatch(
        merged,
        replayed,
        assistantIndexes,
        assistantCursor,
        claimedLocalIndexes,
      );
      if (match) {
        claimedLocalIndexes.add(match.index);
        assistantCursor = match.position + 1;
        if (match.replayIsMoreComplete) {
          const existing = merged[match.index];
          const replacement = {
            ...replayed,
            id: existing.id,
            timestamp: existing.timestamp,
          };
          if (!entriesEqual(existing, replacement)) {
            merged[match.index] = replacement;
            changed = true;
          }
        }
        continue;
      }
    }

    if (replayed.entryType === 'thinking' && matchedThinkingReplayIndexes.has(replayedIndex)) continue;

    if (hasStableAcpIdentity(replayed.id)) {
      stableIndexes.set(replayed.id, merged.length);
      merged.push(replayed);
      changed = true;
      continue;
    }

    const fingerprint = entryFingerprint(replayed);
    const matchOffset = anonymousMatches.get(fingerprint) ?? 0;
    const matchingIndexes = anonymousIndexes.get(fingerprint) ?? [];
    if (matchOffset < matchingIndexes.length) {
      anonymousMatches.set(fingerprint, matchOffset + 1);
      continue;
    }

    merged.push(replayed);
    changed = true;
  }

  return changed ? [...merged, ...protectedSuffix] : undefined;
}

interface AssistantMatch {
  index: number;
  position: number;
  replayIsMoreComplete: boolean;
}

function findAssistantMatch(
  localEntries: NormalizedEntry[],
  replayed: NormalizedEntry,
  assistantIndexes: number[],
  startPosition: number,
  claimedIndexes: Set<number>,
): AssistantMatch | undefined {
  const replayedContent = normalizeMessageContent(replayed.content);
  if (!replayedContent) return undefined;

  for (let position = startPosition; position < assistantIndexes.length; position += 1) {
    const index = assistantIndexes[position];
    if (claimedIndexes.has(index)) continue;
    const localContent = normalizeMessageContent(localEntries[index].content);
    if (localContent === replayedContent) {
      return { index, position, replayIsMoreComplete: false };
    }
  }

  for (let position = startPosition; position < assistantIndexes.length; position += 1) {
    const index = assistantIndexes[position];
    if (claimedIndexes.has(index)) continue;
    const localContent = normalizeMessageContent(localEntries[index].content);
    if (!localContent) continue;
    if (replayedContent.startsWith(localContent)) {
      return { index, position, replayIsMoreComplete: true };
    }
    if (localContent.startsWith(replayedContent)) {
      return { index, position, replayIsMoreComplete: false };
    }
  }
  return undefined;
}

function matchReplayedThinkingEntries(
  localEntries: NormalizedEntry[],
  replayedEntries: NormalizedEntry[],
  localStableIds: Set<string>,
): Set<number> {
  const localStream = localEntries
    .filter((entry) => entry.entryType === 'thinking')
    .map((entry) => normalizeThinkingContent(entry.content))
    .join('');
  const matches = new Set<number>();
  let cursor = 0;

  for (let index = 0; index < replayedEntries.length; index += 1) {
    const replayed = replayedEntries[index];
    if (replayed.entryType !== 'thinking' || localStableIds.has(replayed.id)) continue;
    const content = normalizeThinkingContent(replayed.content);
    if (!content) continue;
    const matchIndex = localStream.indexOf(content, cursor);
    if (matchIndex < 0) continue;
    matches.add(index);
    cursor = matchIndex + content.length;
  }
  return matches;
}

function normalizeMessageContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function normalizeThinkingContent(content: string): string {
  return content.replace(/\s+/g, '');
}

function hasStableAcpIdentity(id: string): boolean {
  return STABLE_ACP_ENTRY_IDS.has(id)
    || STABLE_ACP_ENTRY_PREFIXES.some((prefix) => id.startsWith(prefix));
}

function entryFingerprint(entry: NormalizedEntry): string {
  return JSON.stringify([entry.entryType, entry.content, entry.metadata ?? null]);
}

function entriesEqual(left: NormalizedEntry, right: NormalizedEntry): boolean {
  return left.id === right.id
    && left.entryType === right.entryType
    && left.content === right.content
    && JSON.stringify(left.metadata ?? null) === JSON.stringify(right.metadata ?? null);
}
