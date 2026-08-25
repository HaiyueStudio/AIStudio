import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { JsonValue } from '@haiyue/ai-studio-contracts';
import { canonicalStringify, sha256 } from './canonical.js';

export interface BugBundleVerificationOptions {
  readonly forbiddenCanaries?: readonly string[];
  readonly maxFileBytes?: number;
  readonly maxFiles?: number;
}

export interface BugBundleVerificationResult {
  readonly schemaVersion: 1;
  readonly contentDigest: string;
  readonly eventCount: number;
  readonly artifactCount: number;
  readonly correlationIds: readonly string[];
  readonly files: readonly Readonly<{ path: string; bytes: number; sha256: string }>[];
}

export class BugBundleVerificationError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options); this.name = 'BugBundleVerificationError';
  }
}

export async function verifyBugBundle(directory: string, options: BugBundleVerificationOptions = {}): Promise<BugBundleVerificationResult> {
  if (!path.isAbsolute(directory)) throw failure('bundle.verify-root-not-absolute', 'Bug bundle directory must be absolute.');
  const maxFileBytes = boundedInteger(options.maxFileBytes ?? 8 * 1024 * 1024, 1, 64 * 1024 * 1024, 'maxFileBytes');
  const maxFiles = boundedInteger(options.maxFiles ?? 128, 2, 1_024, 'maxFiles');
  const contentsText = await readBoundedText(path.join(directory, 'contents.json'), Math.min(maxFileBytes, 1024 * 1024));
  const contents = record(parseJson(contentsText, 'contents.json'), 'contents.json');
  if (contents.schemaVersion !== 1 || !digest(contents.contentDigest) || !Array.isArray(contents.files) || contents.files.length < 2 || contents.files.length > maxFiles) {
    throw failure('bundle.verify-contents-schema', 'contents.json failed the bounded bundle schema.');
  }
  const files = contents.files.map((value, index) => fileRecord(value, index));
  if (new Set(files.map((entry) => entry.path)).size !== files.length) throw failure('bundle.verify-duplicate-path', 'Bundle contents contain duplicate paths.');
  if (files[0]?.path !== 'manifest.json' || files[1]?.path !== 'events.jsonl') throw failure('bundle.verify-required-files', 'Bundle contents must begin with manifest.json and events.jsonl.');
  if (files.some((entry) => entry.path === 'contents.json')) throw failure('bundle.verify-recursive-contents', 'contents.json must not hash itself.');
  if (sha256(canonicalStringify(files as unknown as JsonValue)) !== contents.contentDigest) throw failure('bundle.verify-content-digest', 'Bundle content digest does not match its file table.');

  const bodies = new Map<string, string>();
  const root = path.resolve(directory);
  for (const entry of files) {
    const target = resolveBundlePath(root, entry.path);
    const bytes = await readFile(target).catch((cause) => { throw failure('bundle.verify-file-missing', `Bundle file is missing: ${entry.path}`, cause); });
    if (bytes.byteLength > maxFileBytes) throw failure('bundle.verify-file-too-large', `Bundle file exceeds the offline verification limit: ${entry.path}`);
    if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) throw failure('bundle.verify-file-digest', `Bundle file digest or byte count changed: ${entry.path}`);
    const text = bytes.toString('utf8');
    bodies.set(entry.path, text);
    for (const canary of options.forbiddenCanaries ?? []) {
      if (canary.length > 0 && text.includes(canary)) throw failure('bundle.verify-secret-canary', `A forbidden canary remains in ${entry.path}.`);
    }
  }

  const manifest = record(parseJson(bodies.get('manifest.json')!, 'manifest.json'), 'manifest.json');
  if (manifest.schemaVersion !== 1 || !nonNegativeInteger(manifest.eventCount) || !nonNegativeInteger(manifest.artifactCount) || !Array.isArray(manifest.contents)) {
    throw failure('bundle.verify-manifest-schema', 'manifest.json failed the bounded bundle schema.');
  }
  const manifestFiles = manifest.contents.map((value, index) => fileRecord(value, index));
  if (canonicalStringify(manifestFiles as unknown as JsonValue) !== canonicalStringify(files.slice(1) as unknown as JsonValue)) {
    throw failure('bundle.verify-manifest-contents', 'Manifest file table does not match contents.json.');
  }
  const eventLines = bodies.get('events.jsonl')!.split(/\r?\n/u).filter(Boolean);
  if (eventLines.length !== manifest.eventCount) throw failure('bundle.verify-event-count', 'Manifest event count does not match events.jsonl.');
  const correlationIds = new Set<string>();
  let previousSequence: number | null = null;
  for (const [index, line] of eventLines.entries()) {
    const event = record(parseJson(line, `events.jsonl:${index + 1}`), `events.jsonl:${index + 1}`);
    if (event.schemaVersion !== 1 || !nonNegativeInteger(event.sequence) || typeof event.eventId !== 'string' || typeof event.kind !== 'string'
      || !recordOrNull(event.correlation) || !digest(event.payloadDigest)) throw failure('bundle.verify-event-schema', `Event ${index + 1} failed the offline schema.`);
    if (previousSequence !== null && event.sequence <= previousSequence) throw failure('bundle.verify-event-order', 'Bundle event sequences are not strictly increasing.');
    previousSequence = event.sequence;
    for (const value of Object.values(event.correlation)) if (typeof value === 'string') correlationIds.add(value);
  }
  const artifactCount = files.filter((entry) => entry.path.startsWith('artifacts/')).length;
  if (artifactCount !== manifest.artifactCount) throw failure('bundle.verify-artifact-count', 'Manifest artifact count does not match the file table.');
  return Object.freeze({
    schemaVersion: 1, contentDigest: contents.contentDigest, eventCount: manifest.eventCount, artifactCount,
    correlationIds: Object.freeze([...correlationIds].sort()), files: Object.freeze(files.map((entry) => Object.freeze(entry))),
  });
}

function fileRecord(value: unknown, index: number): { path: string; bytes: number; sha256: string } {
  const item = record(value, `files[${index}]`);
  if (typeof item.path !== 'string' || !/^(?:manifest\.json|events\.jsonl|artifacts\/[a-f0-9]{64}\.json)$/u.test(item.path)
    || !nonNegativeInteger(item.bytes) || !digest(item.sha256) || Object.keys(item).some((key) => !['path', 'bytes', 'sha256'].includes(key))) {
    throw failure('bundle.verify-file-schema', `Bundle file entry ${index} is invalid.`);
  }
  return { path: item.path, bytes: item.bytes, sha256: item.sha256 };
}
function resolveBundlePath(root: string, relative: string): string {
  const target = path.resolve(root, ...relative.split('/'));
  if (!target.startsWith(`${root}${path.sep}`)) throw failure('bundle.verify-path-escape', `Bundle path escapes its root: ${relative}`);
  return target;
}
async function readBoundedText(file: string, limit: number): Promise<string> {
  const bytes = await readFile(file).catch((cause) => { throw failure('bundle.verify-file-missing', `Bundle file is missing: ${path.basename(file)}`, cause); });
  if (bytes.byteLength > limit) throw failure('bundle.verify-file-too-large', `${path.basename(file)} exceeds the offline verification limit.`);
  return bytes.toString('utf8');
}
function parseJson(text: string, label: string): unknown { try { return JSON.parse(text); } catch (cause) { throw failure('bundle.verify-json', `${label} is not valid JSON.`, cause); } }
function record(value: unknown, label: string): Record<string, any> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('bundle.verify-object', `${label} must be an object.`); return value as Record<string, any>; }
function recordOrNull(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function nonNegativeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function digest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function boundedInteger(value: number, minimum: number, maximum: number, label: string): number { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw failure('bundle.verify-option', `${label} is outside its safe range.`); return value; }
function failure(code: string, message: string, cause?: unknown): BugBundleVerificationError { return new BugBundleVerificationError(code, message, cause === undefined ? undefined : { cause }); }
