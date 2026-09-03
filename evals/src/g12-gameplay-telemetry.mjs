/** Shared, genre-neutral normalization for model-authored gameplay observations. */
export function gameplayValues(observation) {
  const records = Array.isArray(observation?.value?.gameplay) ? observation.value.gameplay : [];
  return records.map((record) => record?.value).filter(isRecord);
}

export function createG12GameplayTrace(replay) {
  const observations = Array.isArray(replay?.observations) ? replay.observations : [];
  const frames = [];
  for (const observation of observations) {
    for (const value of gameplayValues(observation)) {
      const flat = {};
      flatten(value, '', flat, 0);
      frames.push(Object.freeze({ tick: observation.tick, value, flat: Object.freeze(flat), events: Object.freeze(eventNames(value)) }));
    }
  }
  return Object.freeze(frames);
}

export function traceValues(frames, aliases) {
  const keys = [...new Set(aliases.map(normalizeTelemetryPath).filter(Boolean))];
  const result = [];
  for (const frame of frames) {
    for (const key of keys) {
      if (Object.hasOwn(frame.flat, key)) { result.push(Object.freeze({ tick: frame.tick, value: frame.flat[key] })); break; }
    }
  }
  return result;
}

export function traceNumbers(frames, aliases) {
  return traceValues(frames, aliases).filter((entry) => typeof entry.value === 'number' && Number.isFinite(entry.value));
}

export function traceBooleans(frames, aliases) {
  return traceValues(frames, aliases).filter((entry) => typeof entry.value === 'boolean');
}

export function traceHasEvent(frames, aliases) {
  const expected = new Set(aliases.map(normalizeTelemetryToken));
  return frames.some((frame) => frame.events.some((event) => expected.has(event)));
}

export function traceEventCount(frames, aliases) {
  const expected = new Set(aliases.map(normalizeTelemetryToken));
  let count = 0;
  for (const frame of frames) count += frame.events.filter((event) => expected.has(event)).length;
  return count;
}

export function namedTelemetryPoint(value, name) {
  return telemetryPoint(value?.[name]) ?? telemetryPoint({
    c: value?.[`${name}C`], col: value?.[`${name}Col`], column: value?.[`${name}Column`], r: value?.[`${name}R`], row: value?.[`${name}Row`],
    x: value?.[`${name}X`], y: value?.[`${name}Y`], z: value?.[`${name}Z`],
  });
}

export function roleTelemetryPoint(value, collections, rolePatterns) {
  for (const collectionName of collections) {
    const collection = value?.[collectionName];
    if (!Array.isArray(collection)) continue;
    for (const entry of collection) {
      if (!isRecord(entry)) continue;
      const identity = [entry.role, entry.type, entry.id, entry.name].filter((item) => typeof item === 'string').join(' ');
      if (!rolePatterns.some((pattern) => pattern.test(identity))) continue;
      const point = telemetryPoint(entry.grid ?? entry.cell ?? entry.position ?? entry.world ?? entry);
      if (point) return point;
    }
  }
  return null;
}

export function telemetryPoint(value) {
  if (!isRecord(value)) return null;
  const usesZ = value.r === undefined && value.row === undefined && value.y === undefined && value.z !== undefined;
  const usesY = value.r === undefined && value.row === undefined && value.y !== undefined;
  const c = finite(value.c ?? value.col ?? value.column ?? value.x);
  const r = finite(value.r ?? value.row ?? value.y ?? value.z);
  return c === null || r === null ? null : Object.freeze({ c, r, axis: usesZ ? 'z' : usesY ? 'y' : 'row' });
}

export function normalizeTelemetryToken(value) {
  return typeof value === 'string'
    ? value.trim().replace(/([a-z0-9])([A-Z])/gu, '$1-$2').toLowerCase().replace(/[\s_]+/gu, '-').replace(/[^a-z0-9.:-]/gu, '')
    : '';
}

export function normalizeTelemetryPath(value) {
  return typeof value === 'string' ? value.split('.').map(normalizeTelemetryToken).filter(Boolean).join('.') : '';
}

function eventNames(value) {
  const result = [];
  for (const key of ['event', 'status', 'state', 'phase']) if (typeof value[key] === 'string') result.push(value[key]);
  for (const key of ['events', 'triggers']) if (Array.isArray(value[key])) result.push(...value[key].filter((entry) => typeof entry === 'string'));
  if (isRecord(value.flags)) for (const [key, enabled] of Object.entries(value.flags)) if (enabled === true) result.push(key);
  return [...new Set(result.map(normalizeTelemetryToken).filter(Boolean))];
}

function flatten(value, prefix, result, depth) {
  if (depth > 6 || value === null || value === undefined) return;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (prefix) result[normalizeTelemetryPath(prefix)] = value;
    return;
  }
  if (Array.isArray(value)) return;
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, result, depth + 1);
}

function finite(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function isRecord(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
