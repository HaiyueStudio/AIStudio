import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { QUERY_LIMIT_DEFAULTS, parseQueryLimits, type QueryLimits } from '@haiyue/ai-studio-game-authoring-tools';

export class QueryPreferences {
  private value: QueryLimits = QUERY_LIMIT_DEFAULTS;
  private disposed = false;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}
  async initialize(): Promise<void> {
    try { this.value = parseQueryLimits(JSON.parse(await readFile(this.file, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  snapshot(): QueryLimits { return this.value; }
  configure(input: unknown): Promise<QueryLimits> {
    if (this.disposed) throw new Error('Query preferences are disposed.');
    const next = parseQueryLimits(input);
    const write = this.writes.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp`;
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
      await rename(temporary, this.file); this.value = next; return next;
    });
    this.writes = write.catch(() => undefined); return write;
  }
  async dispose(): Promise<void> { this.disposed = true; await this.writes; }
}
