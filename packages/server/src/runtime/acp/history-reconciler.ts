import type { NormalizedEntry } from '../../output/index.js';

const STABLE_ACP_ENTRY_PREFIXES = [
  'acp-message-',
  'acp-thought-',
  'acp-tool-',
  'acp-diagnostic-',
];
const STABLE_ACP_ENTRY_IDS = new Set(['acp-plan', 'acp-usage']);

/**
 * Reconcile history replayed by session/load with the locally persisted log.
 * Stable ACP identities update in place; anonymous entries use occurrence-aware
 * fingerprints so equal, legitimate messages are not collapsed globally.
 */
export function reconcileAcpHistoryEntries(
  localEntries: NormalizedEntry[],
  replayedEntries: NormalizedEntry[],
): NormalizedEntry[] | undefined {
  const merged: NormalizedEntry[] = [];
  const stableIndexes = new Map<string, number>();
  let changed = false;

  for (const entry of localEntries) {
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
    if (hasStableAcpIdentity(entry.id) || entry.entryType === 'user_message') continue;
    const fingerprint = entryFingerprint(entry);
    const indexes = anonymousIndexes.get(fingerprint) ?? [];
    indexes.push(index);
    anonymousIndexes.set(fingerprint, indexes);
  }
  const anonymousMatches = new Map<string, number>();

  for (const replayed of replayedEntries) {
    if (replayed.entryType === 'user_message') continue;

    if (hasStableAcpIdentity(replayed.id)) {
      const existingIndex = stableIndexes.get(replayed.id);
      if (existingIndex === undefined) {
        stableIndexes.set(replayed.id, merged.length);
        merged.push(replayed);
        changed = true;
        continue;
      }

      const existing = merged[existingIndex];
      const replacement = { ...replayed, timestamp: existing.timestamp };
      if (!entriesEqual(existing, replacement)) {
        merged[existingIndex] = replacement;
        changed = true;
      }
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

  return changed ? merged : undefined;
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
