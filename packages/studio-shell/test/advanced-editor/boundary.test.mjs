import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir,readFile } from 'node:fs/promises';

test('advanced adapter owns presentation only and consumes frozen M12/SDK types through declared exports',async()=>{
  const directory=new URL('../../src/panels/advanced/',import.meta.url);
  for(const file of await readdir(directory)) if(file.endsWith('.ts')) {
    const source=await readFile(new URL(file,directory),'utf8');
    for(const match of source.matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g)) assert.ok(match[1].startsWith('./') || ['@haiyue/ai-studio-contracts','@haiyue/editor-plugin-sdk'].includes(match[1]),`${file}: ${match[1]}`);
    assert.doesNotMatch(source,/new\s+(?:EditorHistoryService|EditorSelectionService|World|Worker)|\b(?:readFile|writeFile|spawn)\s*\(|interface\s+(?:GameDocument|ComponentDefinition|ObservationArtifact)/);
  }
});
