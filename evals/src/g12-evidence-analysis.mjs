import {
  createG12GameplayTrace, gameplayValues, lifecycleTelemetryState, namedTelemetryPoint, roleTelemetryEntry, roleTelemetryPoint,
  traceBooleans, traceHasEvent, traceNumbers,
} from './g12-gameplay-telemetry.mjs';

const ANALYZER_VERSION = 'g12-trace-pixel-correlator-2.0.0';

export function analyzeG12ReplayEvidence({ genre, replay, scene, bitmap, width, height, tickRateHz = 60 }) {
  const trace = createG12GameplayTrace(replay);
  const traceSignals = analyzeTrace(genre, replay, trace, tickRateHz);
  const visual = analyzeVisual({ genre, replay, scene, bitmap, width, height });
  return Object.freeze({ version: ANALYZER_VERSION, traceSignals: Object.freeze(traceSignals), visualSignals: Object.freeze(visual.signals), visualMetrics: Object.freeze(visual.metrics) });
}

function analyzeTrace(genre, replay, trace, tickRateHz) {
  if (genre === 'snake') return analyzeSnake(replay, tickRateHz);
  if (genre === 'match-3') return analyzeMatch3(replay, trace);
  if (genre === 'falling-blocks') return analyzeFallingBlocks(replay, trace);
  if (genre === 'jigsaw') return analyzeJigsaw(replay, trace);
  if (genre === 'platformer') return analyzePlatformer(replay, trace);
  if (genre === 'racing') return analyzeRacing(replay, trace);
  if (genre === 'shooter') return analyzeShooter(replay, trace);
  return {};
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

function analyzeMatch3(replay, trace) {
  const invalidAttempted = bool(trace, ['swap.invalidAttempted', 'invalidSwapAttempted'])
    ?? event(trace, ['invalid-swap', 'swap-rejected', 'invalid-move', 'swap-reverted']);
  const invalidRestored = bool(trace, ['swap.invalidRestored', 'invalidSwapRestored', 'board.invalidSwapRestored'])
    ?? event(trace, ['invalid-swap-restored', 'swap-reverted', 'board-restored']);
  const scoreDelta = delta(trace, ['score', 'metrics.score']);
  return compact({
    'swap.invalidRestored': invalidRestored,
    'swap.invalidAttempted': invalidAttempted,
    'swap.invalidScoreDelta': number(trace, ['swap.invalidScoreDelta', 'metrics.invalidSwapScoreDelta']) ?? (invalidRestored && invalidAttempted ? 0 : null),
    'board.emptyCells': number(trace, ['board.emptyCells', 'metrics.emptyCells', 'emptyCells']),
    'match.clearedCount': maximum(trace, ['match.clearedCount', 'metrics.clearedCount', 'clearedCount', 'tilesCleared']),
    'board.gravityAndRefillCompleted': bool(trace, ['board.gravityAndRefillCompleted', 'gravityAndRefillCompleted', 'refillCompleted'])
      ?? event(trace, ['gravity-complete', 'refill-complete', 'board-refilled', 'board-settled']),
    'score.delta': scoreDelta,
    'terminal.reached': terminal(trace),
    'restart.initialStateRestored': restartRestored(replay, trace),
    'hud.scoreAndMovesPresent': hudContains(replay, /score|分数/iu) && hudContains(replay, /moves?|步数|剩余/iu),
    'board.interactableAfterSettling': bool(trace, ['board.interactableAfterSettling', 'interactable', 'inputEnabled', 'canInteract']),
    'board.maxSettleTicks': maximum(trace, ['board.maxSettleTicks', 'metrics.maxSettleTicks', 'settleTicks']),
  });
}

function analyzeFallingBlocks(replay, trace) {
  const levels = numbers(trace, ['level', 'metrics.level']);
  const intervals = numbers(trace, ['dropInterval', 'fallInterval', 'metrics.dropInterval']);
  return compact({
    'piece.transformsWithinBoard': bool(trace, ['piece.transformsWithinBoard', 'transformsWithinBoard', 'activePieceWithinBoard'])
      ?? zero(trace, ['board.outOfBoundsCellCount', 'outOfBoundsCells']),
    'board.overlapCellCount': number(trace, ['board.overlapCellCount', 'overlapCellCount', 'overlapCells']),
    'controls.moveRotateObserved': bool(trace, ['controls.moveRotateObserved', 'moveRotateObserved'])
      ?? (inputs(replay, ['move-rotate']) && event(trace, ['piece-moved', 'piece-rotated', 'move-accepted', 'rotate-accepted'])),
    'piece.lockedCount': maximum(trace, ['piece.lockedCount', 'metrics.lockedCount', 'lockedCount', 'piecesLocked']),
    'line.clearedCount': maximum(trace, ['line.clearedCount', 'metrics.linesCleared', 'linesCleared', 'clearedLines']),
    'board.compactedAfterClear': bool(trace, ['board.compactedAfterClear', 'compactedAfterClear']) ?? event(trace, ['line-cleared', 'board-compacted']),
    'progression.speedIncreased': bool(trace, ['progression.speedIncreased', 'speedIncreased'])
      ?? (levels.length > 1 ? levels.at(-1) > levels[0] : intervals.length > 1 ? intervals.at(-1) < intervals[0] : null),
    'terminal.topOutGameOver': bool(trace, ['terminal.topOutGameOver', 'topOutGameOver']) ?? event(trace, ['top-out', 'game-over']),
    'restart.initialStateRestored': restartRestored(replay, trace),
    'hud.scoreLevelPreviewPresent': hudContains(replay, /score|分数/iu) && hudContains(replay, /level|等级/iu) && hudContains(replay, /next|preview|下一/iu),
    'board.duplicateActivePieces': number(trace, ['board.duplicateActivePieces', 'duplicateActivePieces']),
  });
}

function analyzeJigsaw(replay, trace) {
  const locked = maximum(trace, ['puzzle.lockedCount', 'metrics.lockedCount', 'lockedCount', 'piecesLocked']);
  const cancelInjected = inputs(replay, ['wrong-drop']);
  const laterInteractionWorked = event(trace, ['correct-snap', 'piece-snapped', 'piece-locked', 'first-piece-locked']);
  return compact({
    'drag.followsPointer': bool(trace, ['drag.followsPointer', 'dragFollowsPointer']) ?? event(trace, ['drag-move', 'piece-dragged']),
    'drag.activePieceOnTop': bool(trace, ['drag.activePieceOnTop', 'activePieceOnTop']),
    'drag.releaseObserved': inputs(replay, ['wrong-drop', 'near-correct']) || event(trace, ['drag-release', 'piece-released']),
    'snap.correctLockedCount': maximum(trace, ['snap.correctLockedCount', 'correctLockedCount', 'metrics.lockedCount', 'lockedCount']),
    'snap.wrongLockedCount': number(trace, ['snap.wrongLockedCount', 'wrongLockedCount', 'metrics.wrongLockedCount']),
    'snap.correctMappingOnly': bool(trace, ['snap.correctMappingOnly', 'correctMappingOnly']) ?? event(trace, ['correct-snap', 'piece-locked']),
    'puzzle.lockedCount': locked,
    'terminal.completed': event(trace, ['complete', 'completed', 'victory', 'won', 'win']),
    'reshuffle.draggableCount': number(trace, ['reshuffle.draggableCount', 'draggableCount', 'metrics.draggableCount']),
    'puzzle.visiblePieceCount': number(trace, ['puzzle.visiblePieceCount', 'visiblePieceCount', 'metrics.visiblePieceCount']),
    'drag.cancelRecovered': bool(trace, ['drag.cancelRecovered', 'cancelRecovered']) ?? (cancelInjected && laterInteractionWorked),
    'drag.cancelInjected': bool(trace, ['drag.cancelInjected', 'cancelInjected']) ?? cancelInjected,
  });
}

function analyzePlatformer(replay, trace) {
  return compact({
    'player.jumpAndLandObserved': bool(trace, ['player.jumpAndLandObserved', 'jumpAndLandObserved'])
      ?? (event(trace, ['jump', 'jumped']) && event(trace, ['land', 'landed'])),
    'physics.platformPenetrations': number(trace, ['physics.platformPenetrations', 'metrics.platformPenetrations', 'platformPenetrations']),
    'controls.runJumpObserved': bool(trace, ['controls.runJumpObserved', 'runJumpObserved'])
      ?? (inputs(replay, ['run', 'jump']) && event(trace, ['jump', 'jumped'])),
    'collectible.duplicateCredits': number(trace, ['collectible.duplicateCredits', 'duplicateCollectibleCredits', 'duplicateCredits']),
    'hazard.contactObserved': event(trace, ['hazard-contact', 'hit-hazard', 'damaged']),
    'respawn.usedActivatedCheckpoint': bool(trace, ['respawn.usedActivatedCheckpoint', 'usedActivatedCheckpoint'])
      ?? (event(trace, ['checkpoint-activated']) && event(trace, ['respawn', 'respawned'])),
    'terminal.victoryReached': bool(trace, ['terminal.victoryReached', 'victoryReached']) ?? event(trace, ['victory', 'complete', 'completed', 'win']),
    'restart.initialStateRestored': restartRestored(replay, trace),
    'camera.maxJitterPixels': maximum(trace, ['camera.maxJitterPixels', 'metrics.cameraJitterPixels', 'cameraJitterPixels']),
    'respawn.duplicatePlayers': number(trace, ['respawn.duplicatePlayers', 'duplicatePlayers']),
  });
}

function analyzeRacing(replay, trace) {
  const speeds = numbers(trace, ['vehicle.speed', 'speed', 'metrics.speed']);
  return compact({
    'vehicle.accelerationObserved': bool(trace, ['vehicle.accelerationObserved', 'accelerationObserved']) ?? increased(speeds),
    'vehicle.brakingObserved': bool(trace, ['vehicle.brakingObserved', 'brakingObserved'])
      ?? (inputs(replay, ['brake']) && event(trace, ['brake', 'braking', 'vehicle-braked'])),
    'controls.steeringObserved': bool(trace, ['controls.steeringObserved', 'steeringObserved'])
      ?? (inputs(replay, ['steer']) && event(trace, ['steer', 'steering', 'vehicle-steered'])),
    'lap.completed': bool(trace, ['lap.completed', 'lapCompleted']) ?? event(trace, ['lap-complete', 'race-finished', 'complete']),
    'checkpoint.orderValid': bool(trace, ['checkpoint.orderValid', 'checkpointOrderValid', 'checkpointsInOrder']),
    'collision.boundaryPenetrations': number(trace, ['collision.boundaryPenetrations', 'boundaryPenetrations']),
    'restart.initialStateRestored': restartRestored(replay, trace),
    'vehicle.recoveredFromOfftrack': bool(trace, ['vehicle.recoveredFromOfftrack', 'recoveredFromOfftrack'])
      ?? event(trace, ['collision-recovered', 'offtrack-recovered', 'vehicle-recovered']),
    'camera.maxJitterPixels': maximum(trace, ['camera.maxJitterPixels', 'metrics.cameraJitterPixels', 'cameraJitterPixels']),
  });
}

function analyzeShooter(replay, trace) {
  return compact({
    'player.movementObserved': bool(trace, ['player.movementObserved', 'movementObserved']) ?? event(trace, ['player-moved', 'move']),
    'aim.maxAngularErrorDegrees': maximum(trace, ['aim.maxAngularErrorDegrees', 'metrics.aimErrorDegrees', 'aimErrorDegrees']),
    'fire.inputObserved': bool(trace, ['fire.inputObserved', 'fireInputObserved'])
      ?? (inputs(replay, ['aim-fire']) && event(trace, ['fire', 'shot-fired'])),
    'combat.validHitDamageObserved': bool(trace, ['combat.validHitDamageObserved', 'validHitDamageObserved']) ?? event(trace, ['enemy-hit', 'damage-applied', 'hit']),
    'cover.blockedShots': maximum(trace, ['cover.blockedShots', 'metrics.blockedShots', 'blockedShots']),
    'combat.duplicateHitSettlements': number(trace, ['combat.duplicateHitSettlements', 'duplicateHitSettlements']),
    'terminal.reached': terminal(trace),
    'restart.staleProjectileCount': number(trace, ['restart.staleProjectileCount', 'staleProjectileCount']),
    'combat.hitFeedbackObserved': bool(trace, ['combat.hitFeedbackObserved', 'hitFeedbackObserved']) ?? event(trace, ['hit-feedback', 'enemy-hit']),
  });
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
  const trace = createG12GameplayTrace(replay);
  if (genre === 'match-3') {
    const tiles = matchingMaterials(scene, /tile|gem|candy|jewel|piece/iu).filter((entry) => visibleMaterials.has(entry.entityId));
    return { signals: {
      'visual.pngCaptured': true,
      'visual.boardRolesDistinct': distinctColors(tiles) >= 3 && clusters >= 5,
      'visual.hudReadable': hudReadable,
    }, metrics };
  }
  if (genre === 'falling-blocks') {
    return { signals: {
      'visual.pngCaptured': true,
      'visual.activeAndLockedDistinct': distinctVisibleRoles(scene, visibleMaterials, [/active|falling|current/iu, /locked|settled|stack/iu]),
      'visual.hudAndPreviewReadable': hudReadable && hudText.some((entry) => /next|preview|下一/iu.test(entry)),
    }, metrics };
  }
  if (genre === 'jigsaw') {
    const pieceVisible = matchingMaterials(scene, /puzzle.*piece|jigsaw.*piece|piece/iu).some((entry) => visibleMaterials.has(entry.entityId));
    const visibleCount = number(trace, ['puzzle.visiblePieceCount', 'visiblePieceCount', 'metrics.visiblePieceCount']);
    return { signals: {
      'visual.pngCaptured': true,
      'visual.pieceBoundariesReadable': pieceVisible && clusters >= 5,
      'visual.allPiecesInViewport': pieceVisible && visibleCount === 12,
    }, metrics };
  }
  if (genre === 'platformer') {
    const composition = distinctVisibleRoles(scene, visibleMaterials, [/player|hero|character/iu, /platform|ground|path/iu]);
    return { signals: {
      'visual.pngCaptured': true,
      'visual.playerAndForwardPathVisible': composition,
      'visual.cameraWithinLevelBounds': bool(trace, ['visual.cameraWithinLevelBounds', 'cameraWithinLevelBounds']) ?? false,
    }, metrics };
  }
  if (genre === 'racing') {
    const vehicleAndRoad = distinctVisibleRoles(scene, visibleMaterials, [/vehicle|car|racer/iu, /road|track|course/iu]);
    const collisionFeedback = matchingMaterials(scene, /collision|impact|feedback|spark|effect/iu).some((entry) => visibleMaterials.has(entry.entityId));
    return { signals: {
      'visual.pngCaptured': true,
      'visual.collisionFeedbackVisible': (bool(trace, ['visual.collisionFeedbackVisible', 'collisionFeedbackVisible']) ?? collisionFeedback)
        && event(trace, ['collision', 'hit-boundary', 'collision-recovered']),
      'visual.vehicleAndRoadVisible': vehicleAndRoad,
      'visual.hudReadable': hudReadable,
    }, metrics };
  }
  if (genre === 'shooter') {
    return { signals: {
      'visual.pngCaptured': true,
      'visual.combatRolesDistinct': distinctVisibleRoles(scene, visibleMaterials, [/player|hero/iu, /enemy|foe/iu, /projectile|bullet|shot|cover|obstacle/iu]),
      'visual.hudReadable': hudReadable,
    }, metrics };
  }
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

function matchingMaterials(scene, pattern) {
  return (scene?.entities ?? []).filter((entry) => pattern.test(String(entry?.name ?? '')) && Array.isArray(entry?.appearance?.color))
    .map((entry) => ({ entityId: entry.id, color: entry.appearance.color.slice(0, 3) }));
}

function distinctVisibleRoles(scene, visibleMaterials, patterns) {
  const roles = patterns.map((pattern) => roleMaterial(scene, pattern));
  return roles.every(Boolean) && roles.every((entry) => visibleMaterials.has(entry.entityId)) && distinctColors(roles) === roles.length;
}

function distinctColors(entries) { return new Set(entries.map((entry) => entry.color.map((value) => Math.round(value * 255)).join(','))).size; }

function snakeState(observation) {
  for (const value of gameplayValues(observation)) {
    const snakeActor = roleTelemetryEntry(value, ['actors'], [/snake|player|\bhead\b/iu]);
    const head = namedTelemetryPoint(value, 'head') ?? roleTelemetryPoint(value, ['actors'], [/snake|player|\bhead\b/iu]);
    const food = namedTelemetryPoint(value, 'food') ?? roleTelemetryPoint(value, ['targets'], [/food|collectible|pickup/iu]);
    const direction = namedVector(value) ?? vector(snakeActor?.dir ?? snakeActor?.direction ?? snakeActor?.head?.direction);
    const score = value.score ?? value.metrics?.score;
    const length = value.length ?? value.metrics?.length ?? value.metrics?.snakeLength;
    if (!head || !Number.isFinite(score) || !Number.isFinite(length)) continue;
    return {
      tick: observation.tick,
      head,
      food,
      direction,
      score,
      length,
      terminal: ['over', 'gameover', 'game-over', 'failed', 'lost'].includes(String(lifecycleTelemetryState(value)).toLowerCase()),
    };
  }
  return null;
}

function namedVector(value) {
  return vector(value?.dir ?? value?.direction) ?? vector({
    dc: value?.dirC ?? value?.directionC, dr: value?.dirR ?? value?.directionR,
    x: value?.dirX ?? value?.directionX, y: value?.dirY ?? value?.directionY, z: value?.dirZ ?? value?.directionZ,
  });
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

function vector(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const dc = value.dc ?? value.dx ?? value.x, dr = value.dr ?? value.dy ?? value.y ?? value.dz ?? value.z;
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

function values(trace, aliases) { return traceValuesSafe(traceNumbers(trace, aliases)); }
function numbers(trace, aliases) { return values(trace, aliases); }
function number(trace, aliases) { const result = numbers(trace, aliases); return result.length > 0 ? result.at(-1) : null; }
function maximum(trace, aliases) { const result = numbers(trace, aliases); return result.length > 0 ? Math.max(...result) : null; }
function delta(trace, aliases) { const result = numbers(trace, aliases); return result.length > 1 ? Math.max(...result) - result[0] : null; }
function bool(trace, aliases) { const result = traceBooleans(trace, aliases); return result.length > 0 ? result.at(-1).value : null; }
function zero(trace, aliases) { const result = maximum(trace, aliases); return result === null ? null : result === 0; }
function event(trace, aliases) { return traceHasEvent(trace, aliases); }
function increased(result) { return result.length > 1 ? Math.max(...result.slice(1)) > result[0] : null; }
function terminal(trace) { return event(trace, ['game-over', 'gameover', 'failed', 'failure', 'defeat', 'lost', 'complete', 'completed', 'victory', 'won', 'win']); }
function inputs(replay, sourceStepIds) {
  const expected = new Set(sourceStepIds);
  return Array.isArray(replay?.trace) && replay.trace.some((entry) => expected.has(entry?.sourceStepId)
    && ['input-queued', 'trigger-input-queued', 'semantic-driver'].includes(entry?.kind));
}
function restartRestored(replay, trace) {
  const explicit = bool(trace, ['restart.initialStateRestored', 'initialStateRestored']);
  if (explicit !== null) return explicit;
  const restarted = inputs(replay, ['restart', 'reshuffle']) || event(trace, ['restart', 'restarted', 'reset', 'reshuffle', 'reshuffled']);
  if (!restarted) return false;
  const phases = trace.map((entry) => String(entry.value?.state ?? entry.value?.status ?? entry.value?.phase ?? '').toLowerCase());
  return phases.length > 0 && !['gameover', 'game-over', 'failed', 'lost', 'complete', 'completed', 'victory', 'won', 'win'].includes(phases.at(-1));
}
function hudContains(replay, pattern) { return (replay?.observations ?? []).flatMap((entry) => hudStrings(entry.value?.hud)).some((entry) => pattern.test(entry)); }
function compact(value) { return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined)); }
function traceValuesSafe(entries) { return entries.map((entry) => entry.value); }
function hudStrings(value) {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(hudStrings);
  if (typeof value !== 'object') return [];
  return Object.values(value).flatMap(hudStrings);
}
