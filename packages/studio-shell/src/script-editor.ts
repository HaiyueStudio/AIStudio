import { basicSetup } from 'codemirror';
import { Compartment, EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { syntaxHighlighting } from '@codemirror/language';
import { classHighlighter } from '@lezer/highlight';

const copy = {
  'zh-CN': { source: '对象脚本源码', format: '格式化', formatting: '格式化中…', formatted: '已格式化，请验证后提交。', unchanged: '代码格式已整齐。', failed: '无法格式化，请检查语法：', hint: 'Shift+Alt+F 格式化 · Tab 切换焦点' },
  en: { source: 'Entity script source', format: 'Format', formatting: 'Formatting…', formatted: 'Formatted. Validate before committing.', unchanged: 'Code is already formatted.', failed: 'Cannot format. Check the syntax:', hint: 'Shift+Alt+F to format · Tab to move focus' },
} as const;
type Language = keyof typeof copy;

/** Owns the editing surface and its local draft, never a Document or approval. */
export class ScriptCodeEditor {
  private readonly view: EditorView;
  private readonly access = new Compartment();
  private readonly label = new Compartment();
  private readonly button: HTMLButtonElement;
  private readonly hint: HTMLElement;
  private readonly status: HTMLElement;
  private readonly lifetime = new AbortController();
  private language: Language;
  private identity: string | null = null;
  private source = '';
  private lineEnding = '\n';
  private generation = 0;
  private disposed = false;
  private readOnly = false;
  private formatting = false;

  constructor(private readonly host: HTMLElement, private readonly onChange: () => void, language: Language = 'zh-CN') {
    this.language = language;
    const document = host.ownerDocument;
    const toolbar = document.createElement('div'); toolbar.className = 'script-code-toolbar';
    const name = document.createElement('strong'); name.textContent = 'TypeScript';
    this.button = document.createElement('button'); this.button.type = 'button'; this.button.dataset.scriptAction = 'format';
    this.button.setAttribute('aria-keyshortcuts', 'Alt+Shift+F');
    this.hint = document.createElement('span'); this.hint.className = 'script-code-hint';
    this.status = document.createElement('span'); this.status.className = 'script-code-status'; this.status.setAttribute('role', 'status');
    const surface = document.createElement('div'); surface.className = 'script-code-surface';
    toolbar.append(name, this.button, this.hint, this.status); host.replaceChildren(toolbar, surface);
    this.view = new EditorView({ parent: surface, state: this.createState('') });
    this.button.addEventListener('click', () => { void this.format(); }, { signal: this.lifetime.signal });
    this.setLanguage(language);
  }

  get text(): string { return this.source; }
  get selection(): Readonly<{ from: number; to: number }> {
    const { from, to } = this.view.state.selection.main;
    return { from: sourceOffset(this.source, from), to: sourceOffset(this.source, to) };
  }
  get hasFocus(): boolean { return this.view.hasFocus; }

  /** New source identities get fresh undo history; rerenders retain the current draft. */
  load(identity: string, text: string): void {
    if (this.disposed || this.identity === identity) return;
    this.identity = identity; this.generation++; this.formatting = false;
    this.source = text; this.lineEnding = text.match(/\r\n?|\n/u)?.[0] ?? '\n';
    this.view.setState(this.createState(text)); this.status.textContent = ''; this.updateButton();
  }

  setReadOnly(value: boolean): void {
    if (this.disposed || value === this.readOnly) return;
    this.readOnly = value; this.generation++; this.formatting = false;
    this.view.dispatch({ effects: this.access.reconfigure([EditorState.readOnly.of(value), EditorView.editable.of(!value)]) });
    this.updateButton();
  }

  setLanguage(language: Language): void {
    if (this.disposed) return;
    this.language = language;
    this.view.dispatch({ effects: this.label.reconfigure(EditorView.contentAttributes.of({ 'aria-label': copy[language].source })) });
    this.hint.textContent = copy[language].hint; this.status.textContent = ''; this.updateButton();
  }

  focusRange(from: number, to: number): void {
    if (this.disposed) return;
    const anchor = documentOffset(this.source, from), head = documentOffset(this.source, to);
    this.view.dispatch({ selection: { anchor, head }, effects: EditorView.scrollIntoView(anchor, { y: 'center' }) });
    this.view.focus();
  }

  async format(): Promise<void> {
    if (this.disposed || this.readOnly || this.formatting) return;
    const generation = this.generation, text = this.text, selection = this.view.state.selection;
    const current = () => !this.disposed && generation === this.generation;
    this.formatting = true; this.status.textContent = copy[this.language].formatting; this.updateButton();
    try {
      const { formatScript } = await import('./script-format.js');
      if (!current()) return;
      const result = await formatScript(text, sourceOffset(text, selection.main.head));
      if (!current()) return;
      if (result.formatted !== text) {
        this.view.dispatch({
          changes: { from: 0, to: this.view.state.doc.length, insert: result.formatted },
          selection: this.view.state.selection.eq(selection) ? { anchor: documentOffset(result.formatted, Math.max(0, result.cursorOffset)) } : undefined,
          annotations: [Transaction.userEvent.of('input.format'), isolateHistory.of('full')],
        });
        this.status.textContent = copy[this.language].formatted;
      } else this.status.textContent = copy[this.language].unchanged;
    } catch (cause) {
      if (current()) this.status.textContent = `${copy[this.language].failed} ${cause instanceof Error ? cause.message : String(cause)}`;
    } finally {
      // Editing/loading cancels this request and may already have started a new one.
      if (current()) { this.formatting = false; this.updateButton(); }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.generation++; this.lifetime.abort(); this.view.destroy(); this.host.replaceChildren();
  }

  private updateButton(): void {
    this.button.textContent = this.formatting ? copy[this.language].formatting : copy[this.language].format;
    this.button.disabled = this.readOnly || this.formatting;
    this.host.setAttribute('aria-busy', String(this.formatting));
  }

  private createState(doc: string): EditorState {
    return EditorState.create({ doc, extensions: [
      basicSetup, javascript({ typescript: true }), syntaxHighlighting(classHighlighter),
      this.access.of([EditorState.readOnly.of(this.readOnly), EditorView.editable.of(!this.readOnly)]),
      this.label.of(EditorView.contentAttributes.of({ 'aria-label': copy[this.language].source })),
      keymap.of([{ key: 'Shift-Alt-f', run: () => { void this.format(); return true; } }]),
      EditorView.updateListener.of(update => {
        if (!update.docChanged || this.disposed) return;
        this.source = update.state.doc.sliceString(0, update.state.doc.length, this.lineEnding);
        this.generation++; this.formatting = false; this.status.textContent = ''; this.updateButton(); this.onChange();
      }),
      EditorView.theme({
        '&': { height: '100%', fontSize: '13px' },
        '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', lineHeight: '1.6' },
        '.cm-content': { minHeight: '100%', padding: '8px 0' },
      }),
    ] });
  }
}

// CodeMirror offsets count each line break once; stored TypeScript ranges count CRLF twice.
function documentOffset(source: string, offset: number): number {
  return source.slice(0, offset).replace(/\r\n?/gu, '\n').length;
}
function sourceOffset(source: string, offset: number): number {
  let extra = 0;
  for (const match of source.matchAll(/\r\n/gu)) {
    if (match.index - extra >= offset) break;
    extra++;
  }
  return offset + extra;
}
