import { formatWithCursor } from 'prettier/standalone';
import * as typescript from 'prettier/plugins/typescript';
import * as estree from 'prettier/plugins/estree';

/** Local formatting only. Parsing never executes the project script. */
export function formatScript(text: string, cursorOffset: number): Promise<{ formatted: string; cursorOffset: number }> {
  return formatWithCursor(text, {
    parser: 'typescript', plugins: [typescript, estree], cursorOffset,
    tabWidth: 2, printWidth: 100, singleQuote: true, endOfLine: 'auto',
    embeddedLanguageFormatting: 'off',
  });
}
