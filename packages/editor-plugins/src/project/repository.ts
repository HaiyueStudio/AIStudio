import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { migrateProjectDocumentV1, parseProjectDocumentFile, parseProjectDocumentSource, type ProjectDocumentFile, type ProjectMigrationReport } from './document.js';
import { ComponentRegistry } from '../components/registry.js';

const PROJECT_FILE = '.haiyue-project.json';
const TEMP_PREFIX = `${PROJECT_FILE}.tmp-`;
const V1_BACKUP_FILE = '.haiyue-project.v1.backup.json';
const MIGRATION_REPORT_FILE = '.haiyue-migration-v1-to-v2.json';

export interface ProjectRepositoryOptions {
  readonly beforeRename?: (tempFile: string, targetFile: string) => void | Promise<void>;
  readonly clock?: () => Date;
}

export class ProjectRepository {
  private constructor(readonly root: string, private readonly options: ProjectRepositoryOptions) {}

  static async open(selectedRoot: string, options: ProjectRepositoryOptions = {}): Promise<ProjectRepository> {
    if (!path.isAbsolute(selectedRoot)) throw new ProjectPathError('project-root-not-absolute', 'Selected project root must be absolute.');
    const canonical = await realpath(selectedRoot);
    const info = await stat(canonical);
    if (!info.isDirectory()) throw new ProjectPathError('project-root-not-directory', 'Selected project root must be a directory.');
    const repository = new ProjectRepository(canonical, options);
    await repository.cleanupTemps();
    return repository;
  }

  resolveProjectPath(relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\0')) {
      throw new ProjectPathError('project-path-invalid', 'Project-relative path is invalid.');
    }
    const target = path.resolve(this.root, relativePath);
    assertInside(this.root, target);
    return target;
  }

  async read(): Promise<ProjectDocumentFile> {
    return (await this.readWithMigration()).file;
  }

  async readWithMigration(registry = new ComponentRegistry().freeze()): Promise<Readonly<{ file: ProjectDocumentFile; migration: ProjectMigrationReport | null }>> {
    const target = this.resolveProjectPath(PROJECT_FILE);
    await this.assertTargetSafe(target);
    const body = await readFile(target, 'utf8'); const source = parseProjectDocumentSource(JSON.parse(body));
    if (source.schemaVersion === 2) return Object.freeze({ file: parseProjectDocumentFile(source, registry), migration: null });
    const migrated = migrateProjectDocumentV1(source, (this.options.clock?.() ?? (await stat(target)).mtime).toISOString(), registry);
    await this.writeBackup(body);
    await this.writeAuxiliary(MIGRATION_REPORT_FILE, `${JSON.stringify(migrated.report, null, 2)}\n`);
    await this.save(migrated.file);
    return Object.freeze({ file: migrated.file, migration: migrated.report });
  }

  async save(value: ProjectDocumentFile): Promise<void> {
    const target = this.resolveProjectPath(PROJECT_FILE);
    await this.assertTargetSafe(target, true);
    const temp = this.resolveProjectPath(`${TEMP_PREFIX}${randomUUID()}`);
    const body = `${JSON.stringify(value, null, 2)}\n`;
    const handle = await open(temp, 'wx');
    try {
      await handle.writeFile(body, 'utf8');
      await handle.sync();
      await this.options.beforeRename?.(temp, target);
      await handle.close();
      await rename(temp, target);
    } catch (cause) {
      await handle.close().catch(() => {});
      await rm(temp, { force: true }).catch(() => {});
      throw new ProjectPathError('project-save-failed', 'Crash-safe project save failed; the previous file remains authoritative.', { cause });
    }
  }

  async rollbackMigration(): Promise<void> {
    const backup = this.resolveProjectPath(V1_BACKUP_FILE); await this.assertTargetSafe(backup);
    const body = await readFile(backup, 'utf8'); parseProjectDocumentSource(JSON.parse(body));
    await this.writeProjectBody(body);
  }

  async cleanupTemps(): Promise<number> {
    let removed = 0;
    for (const name of await readdir(this.root)) {
      if (!name.startsWith(TEMP_PREFIX) && !name.startsWith(`${MIGRATION_REPORT_FILE}.tmp-`)) continue;
      const target = this.resolveProjectPath(name);
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isFile()) continue;
      await rm(target, { force: true });
      removed += 1;
    }
    return removed;
  }

  private async assertTargetSafe(target: string, allowMissing = false): Promise<void> {
    assertInside(this.root, target);
    const parent = await realpath(path.dirname(target));
    assertInside(this.root, parent, true);
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new ProjectPathError('project-symlink-rejected', 'Project file cannot be a symbolic link.');
      const canonical = await realpath(target);
      assertInside(this.root, canonical);
    } catch (cause) {
      if (cause instanceof ProjectPathError) throw cause;
      if (!allowMissing || !isNotFound(cause)) throw cause;
    }
  }

  private async writeBackup(body: string): Promise<void> {
    const target = this.resolveProjectPath(V1_BACKUP_FILE); await this.assertTargetSafe(target, true);
    try { const handle = await open(target, 'wx'); try { await handle.writeFile(body, 'utf8'); await handle.sync(); } finally { await handle.close(); } }
    catch (cause) { if (!isAlreadyExists(cause) || await readFile(target, 'utf8') !== body) throw new ProjectPathError('project-migration-backup-failed', 'A byte-identical v1 migration backup could not be secured.', { cause }); }
  }

  private async writeAuxiliary(relativePath: string, body: string): Promise<void> {
    const target = this.resolveProjectPath(relativePath); await this.assertTargetSafe(target, true);
    try { if (await readFile(target, 'utf8') === body) return; throw new ProjectPathError('project-migration-report-conflict', 'An existing migration report differs from the requested migration.'); }
    catch (cause) { if (cause instanceof ProjectPathError) throw cause; if (!isNotFound(cause)) throw cause; }
    const temp = this.resolveProjectPath(`${relativePath}.tmp-${randomUUID()}`); const handle = await open(temp, 'wx');
    try { await handle.writeFile(body, 'utf8'); await handle.sync(); await handle.close(); await rename(temp, target); }
    catch (cause) { await handle.close().catch(() => {}); await rm(temp, { force: true }).catch(() => {}); throw new ProjectPathError('project-migration-report-failed', 'Migration report persistence failed before project replacement.', { cause }); }
  }

  private async writeProjectBody(body: string): Promise<void> {
    const target = this.resolveProjectPath(PROJECT_FILE); await this.assertTargetSafe(target); const temp = this.resolveProjectPath(`${TEMP_PREFIX}${randomUUID()}`); const handle = await open(temp, 'wx');
    try { await handle.writeFile(body, 'utf8'); await handle.sync(); await this.options.beforeRename?.(temp, target); await handle.close(); await rename(temp, target); }
    catch (cause) { await handle.close().catch(() => {}); await rm(temp, { force: true }).catch(() => {}); throw new ProjectPathError('project-migration-rollback-failed', 'Migration rollback failed; the backup remains available.', { cause }); }
  }
}

export class RecentProjectStore {
  private readonly file: string;
  constructor(userDataRoot: string) {
    if (!path.isAbsolute(userDataRoot)) throw new ProjectPathError('user-data-not-absolute', 'User-data root must be absolute.');
    this.file = path.join(userDataRoot, 'session', 'recent-projects.json');
  }
  async load(): Promise<readonly string[]> {
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8')) as unknown;
      return Array.isArray(value) && value.every((item) => typeof item === 'string') ? Object.freeze([...value]) : Object.freeze([]);
    } catch (cause) {
      if (isNotFound(cause)) return Object.freeze([]);
      throw cause;
    }
  }
  async save(projectRoots: readonly string[]): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify([...projectRoots].slice(0, 10), null, 2)}\n`, 'utf8');
  }
}

export class ProjectPathError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProjectPathError';
  }
}

function assertInside(root: string, target: string, allowEqual = false): void {
  const relative = path.relative(root, target);
  if ((!allowEqual && relative === '') || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ProjectPathError('project-path-escape', 'Project path escapes the explicitly selected root.');
  }
}

function isNotFound(value: unknown): boolean {
  return value instanceof Error && 'code' in value && (value as NodeJS.ErrnoException).code === 'ENOENT';
}
function isAlreadyExists(value: unknown): boolean { return value instanceof Error && 'code' in value && (value as NodeJS.ErrnoException).code === 'EEXIST'; }
