import { createHash, randomBytes } from 'node:crypto';

export const AGENT_API_CREDENTIAL_HEADER = 'x-agent-tower-agent-credential';
export const AGENT_API_CREDENTIAL_ENV = 'AGENT_TOWER_AGENT_CREDENTIAL';

export interface AgentApiCredentialIdentity {
  sessionId: string;
  invocationId: string | null;
}

const credentialsByDigest = new Map<string, AgentApiCredentialIdentity>();
const credentialBySession = new Map<string, {
  credential: string;
  digest: string;
  identity: AgentApiCredentialIdentity;
}>();

function digestCredential(credential: string): string {
  return createHash('sha256').update(credential).digest('base64url');
}

export function createAgentApiCredential(
  identity: AgentApiCredentialIdentity,
): string {
  const existing = credentialBySession.get(identity.sessionId);
  if (existing && existing.identity.invocationId === identity.invocationId) {
    return existing.credential;
  }
  if (existing) credentialsByDigest.delete(existing.digest);

  const credential = randomBytes(32).toString('base64url');
  const digest = digestCredential(credential);
  const boundIdentity = { ...identity };
  credentialsByDigest.set(digest, boundIdentity);
  credentialBySession.set(identity.sessionId, { credential, digest, identity: boundIdentity });
  return credential;
}

export function validateAgentApiCredential(
  credential: string | null | undefined,
): AgentApiCredentialIdentity | null {
  if (!credential) return null;
  const identity = credentialsByDigest.get(digestCredential(credential));
  return identity ? { ...identity } : null;
}

export function revokeAgentApiCredential(sessionId: string): void {
  const existing = credentialBySession.get(sessionId);
  if (!existing) return;
  credentialBySession.delete(sessionId);
  credentialsByDigest.delete(existing.digest);
}

export function clearAgentApiCredentials(): void {
  credentialBySession.clear();
  credentialsByDigest.clear();
}
