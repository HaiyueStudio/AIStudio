import { createHash } from 'node:crypto';
import type { M12Digest } from '@haiyue/ai-studio-contracts';

import { BehaviorContractError, canonicalJson } from './json.js';
export { BehaviorContractError, canonicalJson, checkedJson, freezeProjection } from './json.js';

export function behaviorDigest(value: unknown): M12Digest { return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`; }
export function sourceTextDigest(value: string): M12Digest { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
export function withDigest<T extends object>(value: T): T & { readonly digest: M12Digest } { return { ...value, digest: behaviorDigest(value) }; }
export function verifyDigest(value: { readonly digest: M12Digest }): void {
  const { digest, ...content } = value;
  if (digest !== behaviorDigest(content)) throw new BehaviorContractError('behavior.digest-mismatch');
}
