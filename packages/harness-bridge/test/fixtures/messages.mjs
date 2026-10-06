/** Real Messages SSE envelopes, including fragmented tool JSON and split usage. */
export const usage = { input_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 0, output_tokens: 7 };
export const data = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
export function frames({ text, calls = [], tokens = usage, stop = calls.length ? 'tool_use' : 'end_turn' } = {}) {
  const result = [{ type: 'message_start', message: { id: 'fixture-response', type: 'message', role: 'assistant', content: [], model: 'deepseek-flash', usage: { ...tokens, output_tokens: 0 } } }];
  let index = 0;
  if (text) {
    result.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index, delta: { type: 'text_delta', text } }, { type: 'content_block_stop', index });
    index++;
  }
  for (const call of calls) {
    const args = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {});
    result.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } });
    for (const partial_json of [args.slice(0, 1), args.slice(1)]) result.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } });
    result.push({ type: 'content_block_stop', index });
    index++;
  }
  result.push({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: tokens.output_tokens } }, { type: 'message_stop' });
  return result;
}
export function response(options) { return new Response(frames(options).map(data).join(''), { headers: { 'content-type': 'text/event-stream' } }); }
export function results(body) { return body.messages.flatMap(message => typeof message.content === 'string' ? [] : message.content.filter(block => block.type === 'tool_result')); }
export function resultText(result) { return typeof result.content === 'string' ? result.content : result.content.filter(block => block.type === 'text').map(block => block.text).join('\n'); }
