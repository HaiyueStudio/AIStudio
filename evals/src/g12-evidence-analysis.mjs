const ANALYZER_VERSION = 'g12-trace-pixel-correlator-1.0.0';

export function analyzeG12ReplayEvidence({ genre, replay, scene, bitmap, width, height, tickRateHz = 60 }) {
  const traceSignals = genre === 'snake' ? analyzeSnake(replay, tickRateHz) : {};
  const visual = analyzeVisual({ genre, replay, scene, bitmap, width, height });
  return Object.freeze({ version: ANALYZER_VERSION, traceSignals: Object.freeze(traceSignals), visualSignals: Object.freeze(visual.signals), visualMetrics: Object.freeze(visual.metrics) });
}

function analyzeSnake(replay, tickRateHz) {
  const observations = Array.isArray(replay?.observations) ? replay.observations : [];
  const states = deriveDirections(observations.map(snakeState).filter(Boolean));
  if (states.length < 2) return {};
  const initial = states[0];
  const final = states.at(-1);
  const maximumScore = Math.max(...states.map((entry) => entry.score));
  const maximumLength = Math.max(...states.map((entry) => entry.length));
  const directions = new Set(states.filter((entry) => entry.direction).map((entry) => `${entry.direction.dc},${entry.direction.dr}`));
  const collections = positiveTransitions(states, 'score');
  const respawned = collections > 0 && foodRespawned(states);
  const terminal = states.some((entry) => entry.terminal) && (replay.observedSignals ?? []).some((entry) => ['game-over', 'gameover'].includes(entry));
  const semanticVerified = replay.semanticDriverIds?.includes('scripted-verify-snake') === true;
  const restartQueued = replay.trace?.some((entry) => entry.sourceStepId === 'restart' && entry.kind === 'trigger-input-queued') === true;
  const restarted = restartQueued && !final.terminal && final.score === initial.score && final.length === initial.length;
  const hudText = observations.flatMap((entry) => hudStrings(entry.value?.hud));
  return {
    'movement.directionChanged': directions.size > 1,
    'movement.immediateReverseBlocked': semanticVerified,
    'snake.lengthDelta': maximumLength - initial.length,
    'score.delta': maximumScore - initial.score,
    'food.collections': collections,
    'food.respawned': respawned,
    'terminal.collisionGameOver': terminal,
    'restart.initialStateRestored': restarted,
    'restart.inputAccepted': restarted,
    'hud.scorePresent': hudText.some((entry) => /score|分数/iu.test(entry)),
    'simulation.speedDriftRatio': speedDrift(observations, tickRateHz),
  };
}

function analyzeVisual({ genre, replay, scene, bitmap, width, height }) {
  const pixels = bitmap instanceof Uint8Array || Buffer.isBuffer(bitmap) ? bitmap : new Uint8Array();
  const pixelCount = Math.floor(pixels.byteLength / 4);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || pixelCount < width * height) {
    return { signals: {}, metrics: { validBitmap: false } };
  }
  const histogram = new Map();
  let brightTopPixels = 0;
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    const b = pixels[offset], g = pixels[offset + 1], r = pixels[offset + 2], a = pixels[offset + 3];
    if (a < 16) continue;
    const key = `${r >> 4},${g >> 4},${b >> 4}`;
    histogram.set(key, (histogram.get(key) ?? 0) + 1);
    if (index < width * Math.ceil(height * 0.25) && Math.max(r, g, b) - Math.min(r, g, b) < 48 && r + g + b > 600) brightTopPixels += 1;
  }
  const clusters = [...histogram.values()].filter((count) => count >= Math.max(4, pixelCount * 0.00005)).length;
  const visibleMaterials = materialVisibility(scene, pixels, width, height);
  const hudText = (replay?.observations ?? []).flatMap((entry) => hudStrings(entry.value?.hud));
  const hudReadable = hudText.length > 0 && brightTopPixels >= Math.max(8, width * 0.04);
  const metrics = { validBitmap: true, clusters, brightTopPixels, visibleMaterialCount: visibleMaterials.size };
  if (genre !== 'snake') return { signals: { 'visual.pngCaptured': true }, metrics };
  const head = roleMaterial(scene, /snake.*head|head.*snake|snakehead/iu);
  const body = roleMaterial(scene, /snake.*body|body.*snake|snakebody/iu);
  const food = roleMaterial(scene, /food/iu);
  const roles = [head, body, food].filter(Boolean);
  const distinct = new Set(roles.map((entry) => entry.color.join(','))).size === 3;
  const visible = roles.every((entry) => visibleMaterials.has(entry.entityId));
  const finalState = [...(replay?.observations ?? [])].reverse().map(snakeState).find(Boolean);
  return {
    signals: {
      'visual.pngCaptured': true,
      'visual.rolesDistinct': roles.length === 3 && distinct && visible && clusters >= 4,
      'visual.hudReadable': hudReadable,
      'visual.foodMatchesState': Boolean(finalState?.food && food && visibleMaterials.has(food.entityId)),
    },
    metrics,
  };
}

function materialVisibility(scene, pixels, width, height) {
  const result = new Set();
  for (const entity of scene?.entities ?? []) {
    const color = entity?.appearance?.color;
    if (!Array.isArray(color) || color.length < 3) continue;
    const expected = color.slice(0, 3).map((entry) => Math.round(entry * 255));
    let matches = 0;
    for (let index = 0; index < width * height; index += 3) {
      const offset = index * 4;
      const actual = [pixels[offset + 2], pixels[offset + 1], pixels[offset]];
      if (Math.max(...actual.map((entry, channel) => Math.abs(entry - expected[channel]))) <= 42) matches += 1;
      if (matches >= 3) { result.add(entity.id); break; }
    }
  }
  return result;
}

function roleMaterial(scene, pattern) {
  const entity = (scene?.entities ?? []).find((entry) => pattern.test(String(entry?.name ?? '')) && Array.isArray(entry?.appearance?.color));
  return entity ? { entityId: entity.id, color: entity.appearance.color.slice(0, 3) } : null;
}

function snakeState(observation) {
  for (const record of observation?.value?.gameplay ?? []) {
    const value = record?.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const head = point(value.head), food = point(value.food), direction = vector(value.dir ?? value.direction);
    if (!head || !Number.isFinite(value.score) || !Number.isFinite(value.length)) continue;
    return {
      tick: observation.tick,
      head,
      food,
      direction,
      score: value.score,
      length: value.length,
      terminal: ['over', 'gameover', 'game-over', 'failed', 'lost'].includes(String(value.state ?? value.status ?? '').toLowerCase()),
    };
  }
  return null;
}

function deriveDirections(states) {
  let prior = null;
  return states.map((state) => {
    let direction = state.direction;
    if (!direction && prior && (state.head.c !== prior.head.c || state.head.r !== prior.head.r)) direction = { dc: Math.sign(state.head.c - prior.head.c), dr: Math.sign(state.head.r - prior.head.r) };
    if (!direction && prior?.direction) direction = prior.direction;
    const derived = direction ? { ...state, direction } : state;
    prior = derived;
    return derived;
  });
}

function point(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const c = value.c ?? value.column ?? value.x, r = value.r ?? value.row ?? value.y ?? value.z;
  return Number.isFinite(c) && Number.isFinite(r) ? { c, r } : null;
}
function vector(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const dc = value.dc ?? value.x, dr = value.dr ?? value.y ?? value.z;
  return Number.isFinite(dc) && Number.isFinite(dr) ? { dc, dr } : null;
}
function positiveTransitions(states, key) {
  let count = 0, prior = states[0][key];
  for (const state of states.slice(1)) { if (state[key] > prior) count += state[key] - prior; prior = state[key]; }
  return count;
}
function foodRespawned(states) {
  let prior = states[0];
  for (const state of states.slice(1)) {
    if (state.score > prior.score && prior.food && state.food && (prior.food.c !== state.food.c || prior.food.r !== state.food.r)) return true;
    prior = state;
  }
  return false;
}
function speedDrift(observations, tickRateHz) {
  const expected = 1_000 / tickRateHz;
  let maximum = 0, prior = null, samples = 0;
  for (const observation of observations) {
    if (!Number.isFinite(observation?.tick) || !Number.isFinite(observation?.value?.timeMs)) continue;
    if (prior && observation.tick > prior.tick) {
      const actual = (observation.value.timeMs - prior.timeMs) / (observation.tick - prior.tick);
      maximum = Math.max(maximum, Math.abs(actual - expected) / expected);
      samples += 1;
    }
    prior = { tick: observation.tick, timeMs: observation.value.timeMs };
  }
  return samples > 0 ? maximum : 1;
}
function hudStrings(value) {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(hudStrings);
  if (typeof value !== 'object') return [];
  return Object.values(value).flatMap(hudStrings);
}
