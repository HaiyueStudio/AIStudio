import type { ConversationTaskAcceptanceReadModel } from '@haiyue/ai-studio-shell';

type Language = 'zh-CN' | 'en';
export interface PreviewTestActivity {
  readonly id: string;
  readonly label: string;
  readonly expected: string;
  status: 'running' | 'completed' | 'failed';
  diagnostic?: string;
  tick?: number;
}
type TestStatus = 'pending' | 'fail' | 'pass' | 'running';
interface TestRow { id: string; label: string; expected: string; status: TestStatus; note: string; kind: 'acceptance' | 'operation'; }

/** Describe the existing assertion, without evaluating it or inventing a result. */
export function previewExpectedEffect(assertion: string, language: Language): string {
  const zh = language === 'zh-CN';
  const match = /^evidence ([\w-]+)(?: signal ([\w.-]+) (equals|gte|lte) ([\s\S]+))?$/u.exec(assertion?.trim() ?? '');
  if (!match) return assertion || (zh ? '尚未提供期望效果' : 'Expected effect not provided');
  const types: Record<string, string> = { state: '运行状态', 'event-trace': '交互事件', 'runtime-errors': '运行错误', performance: '性能数据', screenshot: '画面截图', 'visual-analysis': '视觉分析', lifecycle: '生命周期' };
  const type = zh ? types[match[1]!] ?? match[1]! : match[1]!;
  if (!match[2]) return zh ? `取得${type}证据` : `Capture ${type} evidence`;
  const operator = zh ? { equals: '等于', gte: '不小于', lte: '不大于' }[match[3]!] : { equals: '=', gte: '≥', lte: '≤' }[match[3]!];
  return `${type} · ${match[2]} ${operator} ${match[4]}`;
}

export function previewTestRows(criteria: readonly ConversationTaskAcceptanceReadModel[], activities: readonly PreviewTestActivity[], language: Language): readonly TestRow[] {
  const zh = language === 'zh-CN';
  return [
    ...criteria.map(item => ({ id: `acceptance:${item.id}`, kind: 'acceptance' as const, label: item.label, expected: previewExpectedEffect(item.assertion, language),
      status: item.status === 'pass' || item.status === 'fail' ? item.status : 'pending' as TestStatus,
      note: item.diagnostic || (item.status === 'blocked' ? zh ? '验证条件尚未满足' : 'Verification prerequisites are not met' : '') })),
    ...activities.slice(-6).map(item => ({ id: `operation:${item.id}`, kind: 'operation' as const, label: item.label, expected: item.expected,
      status: ({ running: 'running', completed: 'pass', failed: 'fail' } as const)[item.status],
      note: [zh ? '验证操作' : 'Verification operation', item.tick === undefined ? '' : `tick ${item.tick}`, item.diagnostic ?? ''].filter(Boolean).join(' · ') })),
  ];
}

/** Keyed rows preserve the reader's scroll and DOM through repeated polling. */
export function renderPreviewTestTable(table: HTMLTableElement, criteria: readonly ConversationTaskAcceptanceReadModel[], activities: readonly PreviewTestActivity[], language: Language): void {
  const zh = language === 'zh-CN';
  const headings = zh ? ['测试用例', '期望效果', '状态'] : ['Test case', 'Expected effect', 'Status'];
  const setText = (node: HTMLElement, value: string): void => { if (node.textContent !== value) node.textContent = value; };
  table.querySelectorAll('thead th').forEach((cell, index) => setText(cell as HTMLElement, headings[index]!));
  const body = table.tBodies[0]!;
  const rows = previewTestRows(criteria, activities, language);
  const existing = new Map([...body.rows].map(row => [row.dataset.testId!, row]));
  if (!rows.length && existing.size === 1 && existing.has('empty')) {
    setText(existing.get('empty')!.cells[0]!, zh ? '等待 Agent 提交测试用例' : 'Waiting for Agent test cases'); return;
  }
  const ids = new Set(rows.map(row => row.id));
  for (const [id, row] of existing) if (!ids.has(id)) row.remove();
  let cursor = body.firstElementChild;
  for (const item of rows) {
    let row = existing.get(item.id);
    if (!row) {
      row = table.ownerDocument.createElement('tr'); row.dataset.testId = item.id;
      const name = table.ownerDocument.createElement('th'); name.scope = 'row';
      const expected = table.ownerDocument.createElement('td'); expected.append(table.ownerDocument.createElement('span'), table.ownerDocument.createElement('small'));
      const status = table.ownerDocument.createElement('td'); status.append(table.ownerDocument.createElement('span'));
      row.append(name, expected, status);
    }
    row.dataset.kind = item.kind;
    setText(row.cells[0]!, item.label);
    setText(row.cells[1]!.querySelector('span')!, item.expected);
    const note = row.cells[1]!.querySelector('small')!; setText(note, item.note); note.hidden = !item.note;
    const status = row.cells[2]!.querySelector('span')!;
    status.className = 'preview-test-status'; status.dataset.status = item.status;
    setText(status, zh ? { pending: '待验证', fail: '未通过', pass: '通过', running: '进行中' }[item.status] : { pending: 'Pending', fail: 'Failed', pass: 'Passed', running: 'In progress' }[item.status]);
    if (row !== cursor) body.insertBefore(row, cursor);
    cursor = row.nextElementSibling;
  }
  if (!rows.length) {
    const row = body.insertRow(); row.dataset.testId = 'empty';
    const cell = row.insertCell(); cell.colSpan = 3; cell.className = 'preview-test-empty';
    setText(cell, zh ? '等待 Agent 提交测试用例' : 'Waiting for Agent test cases');
  }
}
