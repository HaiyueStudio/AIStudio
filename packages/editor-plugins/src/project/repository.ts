import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseProjectDocumentFile, type ProjectDocumentFile } from './document.js';

const PROJECT_FILE = '.haiyue-project.json';
const TEMP_PREFIX = `${PROJECT_FILE}.tmp-`;

export interface ProjectRepositoryOptions {
  readonly beforeRename?: (tempFile: string, targetFile: string) => void | Promise<void>;
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
    const target = this.resolveProjectPath(PROJECT_FILE);
    await this.assertTargetSafe(target);
    return parseProjectDocumentFile(JSON.parse(await readFile(target, 'utf8')));
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

  async cleanupTemps(): Promise<number> {
    let removed = 0;
    for (const name of await readdir(this.root)) {
      if (!name.startsWith(TEMP_PREFIX)) continue;
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
