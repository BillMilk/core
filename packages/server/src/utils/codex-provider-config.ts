import { parse as parseToml } from 'smol-toml';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Detect a user-declared model provider table that would collide with an
 * Agent Tower runtime alias. The alias must remain a distinct table because
 * Codex merges `-c` assignments into the existing TOML rather than replacing
 * the table (for example, an old `env_key` would otherwise survive).
 */
export function hasCodexBuiltinProviderAliasCollision(
  settings: string | undefined,
  alias: string,
): boolean {
  if (!settings?.trim()) return false;
  try {
    const parsed = parseToml(settings) as Record<string, unknown>;
    const rawModelProvider = parsed.model_provider;
    let activeModelProvider: string | undefined;
    if (rawModelProvider === undefined) activeModelProvider = 'openai';
    else if (typeof rawModelProvider === 'string') activeModelProvider = rawModelProvider.trim() || 'openai';
    if (activeModelProvider !== 'openai' || !isRecord(parsed.model_providers)) return false;
    return Object.prototype.hasOwnProperty.call(parsed.model_providers, alias);
  } catch {
    // Invalid TOML is reported by the regular settings validator. Do not
    // emit a second, potentially misleading alias diagnostic here.
    return false;
  }
}
