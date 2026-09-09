import { copyFile, mkdir } from 'node:fs/promises';

const destination = new URL('../dist/panels/resources/', import.meta.url);
await mkdir(destination, { recursive: true });
await copyFile(new URL('../src/panels/resources/resources.css', import.meta.url), new URL('resources.css', destination));
