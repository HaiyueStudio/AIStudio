import { asStableId, type JsonObject } from '@haiyue/ai-studio-contracts';
import { PlanProtocolError } from './plan-policy.js';

export const ASYNC_QUESTION_TOOL = Object.freeze({
  id: asStableId('studio.question.ask'), effect: 'observe', risk: 'low',
  description: 'Experimental nonblocking clarification. Ask one question with 2-3 suggested answers. Returns pending immediately, never an answer or permission. Continue independent read-only work, then finish the turn; do not poll or ask again. Studio queues the user reply against the owning task. Editing and external effects wait for the reply. Never use for tool approval or budget authorization.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['prompt', 'options'], properties: {
    prompt: { type: 'string', minLength: 1, maxLength: 2048 },
    options: { type: 'array', minItems: 2, maxItems: 3, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 160 } },
  } } as JsonObject,
});
export function parseAsyncQuestion(value: JsonObject): { prompt: string; options: string[] } {
  if (Object.keys(value).some(key => !['prompt', 'options'].includes(key)) || typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 2048
    || !Array.isArray(value.options) || value.options.length < 2 || value.options.length > 3 || value.options.some(option => typeof option !== 'string' || !option.trim() || option.length > 160))
    throw new PlanProtocolError('question.invalid', 'Supply one prompt and 2-3 short answer choices.');
  const options = (value.options as string[]).map(option => option.trim());
  if (new Set(options).size !== options.length) throw new PlanProtocolError('question.invalid', 'Answer choices must differ.');
  return { prompt: value.prompt.trim(), options };
}
export function validateAsyncAnswer(answer: JsonObject, options: readonly JsonObject[]): void {
  const ids = answer.optionIds ?? [], text = answer.text ?? '';
  if (Object.keys(answer).some(key => !['optionIds', 'text'].includes(key)) || !Array.isArray(ids) || ids.length > 1 || ids.some(id => !options.some(option => option.id === id))
    || typeof text !== 'string' || text.length > 1800 || (!ids.length && !text.trim())) throw new PlanProtocolError('question.answer-invalid', 'Select a suggested answer or enter a short reply.');
}
