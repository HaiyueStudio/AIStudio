import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface SecretEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export class DeepSeekCredentialStoreError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options); this.name = 'DeepSeekCredentialStoreError';
  }
}

export class DeepSeekCredentialStore {
  private readonly filePath: string;
  constructor(rootDirectory: string, private readonly encryption: SecretEncryption) {
    if (!path.isAbsolute(rootDirectory)) throw new DeepSeekCredentialStoreError('credential.root-not-absolute', 'Credential root must be absolute.');
    this.filePath = path.join(rootDirectory, 'credentials', 'deepseek-api-key.v1.json');
  }

  async importFromEnvironment(environment: NodeJS.ProcessEnv): Promise<boolean> {
    const names = ['HAIYUE_STUDIO_DEEPSEEK_SECRET', 'DEEPSEEK_API_KEY'] as const;
    const candidate = names.map((name) => environment[name]).find((value) => typeof value === 'string' && value.trim().length > 0)?.trim() ?? null;
    for (const name of names) delete environment[name];
    if (!candidate) return false;
    await this.set(candidate);
    return true;
  }

  async set(value: string): Promise<void> {
    const secret = validateSecret(value);
    if (!this.encryption.isEncryptionAvailable()) throw new DeepSeekCredentialStoreError('credential.encryption-unavailable', 'OS-backed Electron secret encryption is unavailable.');
    const encrypted = this.encryption.encryptString(secret);
    if (!Buffer.isBuffer(encrypted) || encrypted.byteLength === 0) throw new DeepSeekCredentialStoreError('credential.encryption-failed', 'OS-backed credential encryption returned no data.');
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `.deepseek-api-key.${randomUUID()}.tmp`);
    const body = `${JSON.stringify({ schemaVersion: 1, encryption: 'electron-safe-storage', cipherText: encrypted.toString('base64') })}\n`;
    try {
      await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, this.filePath);
    } finally { await unlink(temporary).catch((cause: NodeJS.ErrnoException) => { if (cause.code !== 'ENOENT') throw cause; }); }
  }

  async resolve(): Promise<string | null> {
    let text: string;
    try { text = await readFile(this.filePath, 'utf8'); }
    catch (cause) { if ((cause as NodeJS.ErrnoException)?.code === 'ENOENT') return null; throw cause; }
    if (!this.encryption.isEncryptionAvailable()) throw new DeepSeekCredentialStoreError('credential.encryption-unavailable', 'OS-backed Electron secret encryption is unavailable.');
    let value: unknown;
    try { value = JSON.parse(text); }
    catch (cause) { throw new DeepSeekCredentialStoreError('credential.record-malformed', 'Encrypted credential record is not valid JSON.', { cause }); }
    if (!isRecord(value) || value.schemaVersion !== 1 || value.encryption !== 'electron-safe-storage' || typeof value.cipherText !== 'string'
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value.cipherText) || value.cipherText.length > 16_384 || Object.keys(value).some((key) => !recordKeys.has(key))) {
      throw new DeepSeekCredentialStoreError('credential.record-malformed', 'Encrypted credential record failed schema validation.');
    }
    try { return validateSecret(this.encryption.decryptString(Buffer.from(value.cipherText, 'base64'))); }
    catch (cause) { if (cause instanceof DeepSeekCredentialStoreError) throw cause; throw new DeepSeekCredentialStoreError('credential.decryption-failed', 'OS-backed credential decryption failed.', { cause }); }
  }

  async clear(): Promise<void> {
    await unlink(this.filePath).catch((cause: NodeJS.ErrnoException) => { if (cause.code !== 'ENOENT') throw cause; });
  }
}

function validateSecret(value: unknown): string {
  if (typeof value !== 'string') throw new DeepSeekCredentialStoreError('credential.invalid', 'DeepSeek credential must be a string.');
  const secret = value.trim();
  if (secret.length < 8 || secret.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(secret)) throw new DeepSeekCredentialStoreError('credential.invalid', 'DeepSeek credential has an invalid length or control characters.');
  return secret;
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
const recordKeys = new Set(['schemaVersion', 'encryption', 'cipherText']);
