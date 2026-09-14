/** Bounded Markdown presentation built entirely with DOM text nodes.
 * Supports paragraphs, headings, lists, quotes, emphasis and fenced/inline code.
 * HTML and media remain text; this component cannot execute or fetch model content.
 */
export function renderMarkdown(document: Document, source: string): HTMLElement {
  const root = document.createElement('div'); root.className = 'studio-markdown';
  blocks(document, root, source.slice(0, 16384).replace(/\r\n?/gu, '\n').split('\n'), 0);
  return root;
}

function inline(document: Document, parent: HTMLElement, source: string, depth = 0): void {
  if (depth > 6) { parent.append(document.createTextNode(source)); return; }
  const pattern = /(`+)([^`\n]+)\1|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_|\\([\\`*_[\]{}()#+.!>-])/gu;
  let start = 0;
  for (const match of source.matchAll(pattern)) {
    parent.append(document.createTextNode(source.slice(start, match.index)));
    if (match[7]) parent.append(document.createTextNode(match[7]));
    else {
      const element = document.createElement(match[2] ? 'code' : match[3] || match[4] ? 'strong' : 'em');
      const text = match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? '';
      if (match[2]) element.textContent = text; else inline(document, element, text, depth + 1);
      parent.append(element);
    }
    start = match.index + match[0].length;
  }
  parent.append(document.createTextNode(source.slice(start)));
}

const listItem = (line: string) => /^(\s*)(?:([-+*])|(\d+)[.)])\s+(.*)$/u.exec(line);
const fence = (line: string) => /^\s{0,3}(`{3,}|~{3,})([^`]*)$/u.exec(line);
const heading = (line: string) => /^\s{0,3}(#{1,6})\s+(.+)$/u.exec(line);
const rule = (line: string) => /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line);
function blocks(document: Document, parent: HTMLElement, lines: string[], depth: number): void {
  if (depth > 8) { const p = document.createElement('p'); p.textContent = lines.join('\n'); parent.append(p); return; }
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) { index++; continue; }
    const open = fence(line);
    if (open) {
      const content: string[] = []; index++;
      while (index < lines.length && !new RegExp(`^\\s{0,3}${open[1]![0]}{${open[1]!.length},}\\s*$`, 'u').test(lines[index]!)) content.push(lines[index++]!);
      if (index < lines.length) index++;
      const pre = document.createElement('pre'); const code = document.createElement('code'); code.textContent = content.join('\n'); pre.append(code); parent.append(pre); continue;
    }
    const title = heading(line);
    if (title) { const h = document.createElement(`h${Math.min(6, title[1]!.length + 2)}`); inline(document, h, title[2]!); parent.append(h); index++; continue; }
    if (rule(line)) { parent.append(document.createElement('hr')); index++; continue; }
    if (/^\s{0,3}>/u.test(line)) {
      const quote = document.createElement('blockquote'); const content: string[] = [];
      while (index < lines.length && /^\s{0,3}>/u.test(lines[index]!)) content.push(lines[index++]!.replace(/^\s{0,3}> ?/u, ''));
      blocks(document, quote, content, depth + 1); parent.append(quote); continue;
    }
    const first = listItem(line);
    if (first) {
      const ordered = Boolean(first[3]); const indent = first[1]!.length;
      const list = document.createElement(ordered ? 'ol' : 'ul');
      if (ordered) list.setAttribute('start', String(Math.min(1000000, Number(first[3]))));
      while (index < lines.length) {
        const item = listItem(lines[index]!);
        if (!item || item[1]!.length !== indent || Boolean(item[3]) !== ordered) break;
        const li = document.createElement('li'); const content = [item[4]!]; index++;
        while (index < lines.length) {
          const next = lines[index]!;
          if (!next.trim()) { if ((lines[index + 1]?.match(/^\s*/u)?.[0].length ?? 0) > indent) { content.push(''); index++; continue; } break; }
          const spaces = next.match(/^\s*/u)![0].length;
          if (spaces <= indent) break;
          content.push(next.slice(Math.min(spaces, indent + 2))); index++;
        }
        blocks(document, li, content, depth + 1); list.append(li);
      }
      parent.append(list); continue;
    }
    const content = [line]; index++;
    while (index < lines.length && lines[index]!.trim() && !fence(lines[index]!) && !heading(lines[index]!) && !rule(lines[index]!) && !listItem(lines[index]!) && !/^\s{0,3}>/u.test(lines[index]!)) content.push(lines[index++]!);
    const paragraph = document.createElement('p'); inline(document, paragraph, content.join('\n')); parent.append(paragraph);
  }
}
