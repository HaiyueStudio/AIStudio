import type { LocalEmbeddingProvider } from './types.js';

const SEMANTIC_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  camera: ['view', 'viewport', 'framing', 'orbit', 'follow', '相机', '视角', '镜头', '取景'],
  input: ['keyboard', 'pointer', 'touch', 'mouse', 'gamepad', 'interaction', '输入', '键盘', '鼠标', '触控', '交互'],
  physics: ['collision', 'gravity', 'body', 'raycast', 'overlap', '碰撞', '重力', '刚体', '射线'],
  transform: ['position', 'rotation', 'scale', 'spatial', 'align', '位置', '旋转', '缩放', '对齐'],
  gameplay: ['state', 'trigger', 'score', 'spawn', 'reset', '玩法', '状态', '触发', '计分', '生成', '重开'],
  render: ['light', 'material', 'shadow', 'particle', 'postprocess', '渲染', '灯光', '材质', '阴影', '粒子', '后期'],
  asset: ['texture', 'model', 'audio', 'animation', 'resource', '资源', '纹理', '模型', '音频', '动画'],
  hierarchy: ['entity', 'parent', 'child', 'prefab', 'scene', '层级', '实体', '父级', '子级', '预制体', '场景'],
  validation: ['diagnostic', 'preview', 'capture', 'evidence', 'evaluate', '验证', '诊断', '预览', '截图', '证据', '验收'],
});

/** Deterministic, offline feature-hashing embedding. It is intentionally pluggable so a
 * reviewed local model can replace it without changing index or provenance semantics. */
export class LocalHashEmbeddingProvider implements LocalEmbeddingProvider {
  readonly id = 'local-feature-hash-v1';
  constructor(readonly dimensions = 192) {
    if (!Number.isSafeInteger(dimensions) || dimensions < 64 || dimensions > 2_048) throw new TypeError('Embedding dimensions must be 64-2048.');
  }

  embed(text: string): readonly number[] {
    const values = new Float64Array(this.dimensions);
    const tokens = expandSemanticTokens(tokenize(text));
    for (const token of tokens) {
      add(values, `w:${token}`, 1);
      const padded = `^${token}$`;
      for (let index = 0; index + 2 < padded.length; index += 1) add(values, `g:${padded.slice(index, index + 3)}`, 0.35);
    }
    const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
    if (norm > 0) for (let index = 0; index < values.length; index += 1) values[index] = values[index]! / norm;
    return Object.freeze([...values]);
  }
}

export function tokenize(text: string): readonly string[] {
  return Object.freeze((text.toLocaleLowerCase().match(/[\p{L}\p{N}_.:/-]+/gu) ?? []).flatMap((value) => {
    const parts = value.split(/[_.:/-]+/u).filter(Boolean);
    const cjk = /\p{Script=Han}/u.test(value) ? [...value].flatMap((character, index, characters) => [character, characters.slice(index, index + 2).join(''), characters.slice(index, index + 3).join('')]) : [];
    return value.length > 1 ? [value, ...parts, ...cjk] : [...parts, ...cjk];
  }).filter((value) => value.length > 1).slice(0, 20_000));
}

function expandSemanticTokens(tokens: readonly string[]): readonly string[] {
  const expanded = [...tokens];
  for (const token of tokens) {
    for (const [concept, aliases] of Object.entries(SEMANTIC_ALIASES)) {
      if (token === concept || aliases.includes(token)) expanded.push(concept, ...aliases);
    }
  }
  return expanded;
}

function add(values: Float64Array, token: string, weight: number): void {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) { hash ^= token.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  const position = (hash >>> 0) % values.length;
  values[position] = values[position]! + ((hash & 1) === 0 ? weight : -weight);
}
