// packages/studio-shell/dist/workspace/preferences.js
var defaults = Object.freeze({ schemaVersion: 1, mode: "intent", tab: "logic", category: "geometry", advancedTab: "inspect" });

// packages/studio-contracts/dist/index.js
function asStableId(value, kind = "id") {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(normalized)) {
    throw new TypeError(`Invalid ${kind} ${JSON.stringify(value)}.`);
  }
  return normalized;
}
function createStudioServiceToken(id) {
  const stable2 = asStableId(id, "service token");
  return Object.freeze({ id: stable2, key: /* @__PURE__ */ Symbol.for(`@haiyue/ai-studio-service/${stable2}`) });
}

// packages/studio-shell/dist/conversation/types.js
var CONVERSATION_NODE_KINDS = Object.freeze([
  "text",
  "progress",
  "question",
  "plan",
  "tool-call",
  "tool-result",
  "approval",
  "diagnostic",
  "completion"
]);

// packages/studio-shell/dist/conversation/validation.js
var MAX_CONVERSATION_CONTENT_BYTES = 16 * 1024;
var MAX_PRESENTATION_TEXT = 4096;
var statuses = /* @__PURE__ */ new Set(["pending", "streaming", "completed", "failed", "cancelled"]);
var knownKinds = new Set(CONVERSATION_NODE_KINDS);
var bearerLike = /\b(?:bearer\s+)?(?:sk-[A-Za-z0-9_-]{12,}|[A-Za-z0-9_-]{32,})\b/gi;
var digestPattern = /^sha256:[a-f0-9]{64}$/;
var evidenceTypes = ["state", "event-trace", "runtime-errors", "performance", "screenshot", "visual-analysis", "lifecycle"];
var taskPhases = ["planning", "editing", "validating", "playing", "evaluating", "repairing", "complete", "blocked", "cancelled"];
var taskStatuses = ["running", "waiting-user", "blocked", "completed", "failed", "cancelled"];
var acceptanceCategories = ["functional", "visual", "performance", "lifecycle", "budget", "security"];
var MAX_SCREENSHOT_DATA_URL_BYTES = 520 * 1024;
var ConversationReadModelError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "ConversationReadModelError";
  }
};
function normalizeConversationNode(value) {
  if (!isRecord(value))
    throw new ConversationReadModelError("conversation.node-invalid", "Conversation node must be an object.");
  const id = stable(value.id, "node id");
  const kind = boundedString(value.kind, "node kind", 64);
  const knownKind = knownKinds.has(kind) ? kind : null;
  const status = statuses.has(value.status) ? value.status : "failed";
  const createdAt = timestamp(value.createdAt, "createdAt");
  const provenance = normalizeProvenance(value.provenance);
  if (!isRecord(value.content))
    throw new ConversationReadModelError("conversation.content-invalid", "Conversation content must be an object.");
  const serialized = safeStringify(value.content);
  const oversized = utf8Bytes(serialized) > MAX_CONVERSATION_CONTENT_BYTES;
  const content = !knownKind ? Object.freeze({ summary: "This conversation item is not supported by this Studio version.", originalKind: safeText(kind, 64) }) : oversized ? Object.freeze({ summary: `Payload omitted because it exceeds ${MAX_CONVERSATION_CONTENT_BYTES} bytes.` }) : normalizeContent(knownKind, value.content);
  return Object.freeze({ schemaVersion: 1, id, kind, knownKind, status, createdAt, provenance, content, payloadTruncated: oversized });
}
function normalizeBackend(value) {
  if (!isRecord(value))
    throw new ConversationReadModelError("conversation.backend-invalid", "Backend read model must be an object.");
  const kind = value.kind;
  const state = value.state;
  const authMode = value.authMode;
  if (kind !== "harness-api-key" && kind !== "codex-app-server")
    throw new ConversationReadModelError("conversation.backend-invalid", "Backend kind is invalid.");
  if (!["ready", "auth-required", "authenticating", "unavailable", "error"].includes(String(state)))
    throw new ConversationReadModelError("conversation.backend-invalid", "Backend state is invalid.");
  if (!["api-key", "chatgpt", "none"].includes(String(authMode)))
    throw new ConversationReadModelError("conversation.backend-invalid", "Backend auth mode is invalid.");
  const rateLimits = Array.isArray(value.rateLimits) ? value.rateLimits.slice(0, 8).map(normalizeRateLimit) : [];
  const diagnostic = isRecord(value.diagnostic) && typeof value.diagnostic.code === "string" && typeof value.diagnostic.message === "string" ? Object.freeze({ code: safeText(value.diagnostic.code, 96), message: safeText(value.diagnostic.message, 512) }) : void 0;
  const models = Array.isArray(value.models) ? value.models.slice(0, 64).flatMap((item) => normalizeModel(item)) : [];
  const selectedModel = typeof value.selectedModel === "string" && models.some((item) => item.id === value.selectedModel) ? safeText(value.selectedModel, 128) : null;
  const selectedReasoningEffort = reasoningEffort(value.selectedReasoningEffort);
  const outputTokenLimit = safeInteger(value.outputTokenLimit, 1, 1e6);
  const capabilities = isRecord(value.capabilities) ? Object.freeze({ resume: value.capabilities.resume === true, questions: value.capabilities.questions === true, structuredTools: value.capabilities.structuredTools === true, backendApprovals: value.capabilities.backendApprovals === true, usage: value.capabilities.usage === true, rateLimits: value.capabilities.rateLimits === true }) : Object.freeze({ resume: false, questions: false, structuredTools: false, backendApprovals: false, usage: false, rateLimits: false });
  let promptProfile = null;
  if (isRecord(value.promptProfile)) {
    try {
      promptProfile = Object.freeze({ id: stable(value.promptProfile.id, "prompt profile id"), version: safeText(typeof value.promptProfile.version === "string" ? value.promptProfile.version : "unknown", 64), digest: digest(value.promptProfile.digest) });
    } catch {
      promptProfile = null;
    }
  }
  return Object.freeze({
    id: stable(value.id, "backend id"),
    label: safeText(typeof value.label === "string" ? value.label : String(kind), 80),
    kind,
    state,
    authMode,
    protocolVersion: safeText(typeof value.protocolVersion === "string" ? value.protocolVersion : "unknown", 96),
    capabilities,
    promptProfile,
    ...typeof value.accountPlan === "string" ? { accountPlan: safeText(value.accountPlan, 80) } : {},
    rateLimits: Object.freeze(rateLimits),
    ...diagnostic ? { diagnostic } : {},
    models: Object.freeze(models),
    selectedModel,
    selectedReasoningEffort,
    outputTokenLimit
  });
}
function normalizeTaskAccounting(value) {
  if (!isRecord(value) || !isRecord(value.budget) || !isRecord(value.usage) || !isRecord(value.cost))
    return null;
  try {
    const budget = normalizeBudget(value.budget);
    const status = ["within", "soft-exceeded", "hard-exceeded"].includes(String(value.budgetStatus)) ? value.budgetStatus : "within";
    const countOrNull = (item) => item === null ? null : safeInteger(item, 0, 1e9);
    return Object.freeze({
      taskId: stable(value.taskId, "task id"),
      budget,
      budgetStatus: status,
      usage: Object.freeze({ inputTokens: countOrNull(value.usage.inputTokens), cachedInputTokens: countOrNull(value.usage.cachedInputTokens), outputTokens: countOrNull(value.usage.outputTokens), reasoningTokens: countOrNull(value.usage.reasoningTokens), toolInputBytes: safeInteger(value.usage.toolInputBytes, 0, 1e9) ?? 0, toolOutputBytes: safeInteger(value.usage.toolOutputBytes, 0, 1e9) ?? 0, wallTimeMs: safeInteger(value.usage.wallTimeMs, 0, 864e5) ?? 0, ...isRecord(value.usage.contextCache) ? { contextCache: Object.freeze({ localArtifactHits: safeInteger(value.usage.contextCache.localArtifactHits, 0, 1e9) ?? 0, localArtifactMisses: safeInteger(value.usage.contextCache.localArtifactMisses, 0, 1e9) ?? 0, deltaReuseBytes: safeInteger(value.usage.contextCache.deltaReuseBytes, 0, 1e9) ?? 0, providerCacheEligibleBytes: safeInteger(value.usage.contextCache.providerCacheEligibleBytes, 0, 1e9) ?? 0, providerReportedHitTokens: countOrNull(value.usage.contextCache.providerReportedHitTokens) }) } : {} }),
      cost: Object.freeze({ status: ["actual", "estimated", "unknown"].includes(String(value.cost.status)) ? value.cost.status : "unknown", amountMicros: countOrNull(value.cost.amountMicros), currency: typeof value.cost.currency === "string" ? safeText(value.cost.currency, 3) : null, cacheSavingMicros: countOrNull(value.cost.cacheSavingMicros), explanation: safeText(typeof value.cost.explanation === "string" ? value.cost.explanation : "Cost is unknown.", 512), final: value.cost.final === true })
    });
  } catch {
    return null;
  }
}
function normalizeTaskRuns(value) {
  if (!Array.isArray(value))
    return Object.freeze([]);
  const seen = /* @__PURE__ */ new Set();
  const runs = [];
  for (const item of value.slice(-50)) {
    try {
      const run = normalizeTaskRun(item);
      if (seen.has(run.taskId))
        continue;
      seen.add(run.taskId);
      runs.push(run);
    } catch {
    }
  }
  return Object.freeze(runs.sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.taskId.localeCompare(right.taskId)));
}
function normalizeTaskRun(value) {
  if (!isRecord(value) || value.schemaVersion !== 1)
    throw new ConversationReadModelError("conversation.task-version-unsupported", "Task projection version is unsupported.");
  const taskId = stable(value.taskId, "task id");
  const revision = safeInteger(value.revision, 0, 1e9);
  if (revision === null)
    throw new ConversationReadModelError("conversation.task-invalid", "Task revision is invalid.");
  const status = enumValue(value.status, taskStatuses);
  const phase = enumValue(value.phase, taskPhases);
  if (!status || !phase || !isRecord(value.model) || !isRecord(value.promptProfile))
    throw new ConversationReadModelError("conversation.task-invalid", "Task status, phase or configuration is invalid.");
  const reasoning = reasoningEffort(value.model.reasoningEffort);
  const outputTokenLimit = safeInteger(value.model.outputTokenLimit, 1, 1e6);
  if (!reasoning || outputTokenLimit === null)
    throw new ConversationReadModelError("conversation.task-invalid", "Task model configuration is invalid.");
  const documentRevision = value.documentRevision === null ? null : safeInteger(value.documentRevision, 0, 1e9);
  const repairIteration = safeInteger(value.repairIteration, 0, 100);
  const repairLimit = safeInteger(value.repairLimit, 0, 100);
  if (documentRevision === null && value.documentRevision !== null || repairIteration === null || repairLimit === null || repairIteration > repairLimit)
    throw new ConversationReadModelError("conversation.task-invalid", "Task revision or repair accounting is invalid.");
  const evidence = Array.isArray(value.evidence) ? value.evidence.slice(0, 256).flatMap((item) => {
    try {
      return [normalizeTaskEvidence(item, taskId, documentRevision)];
    } catch {
      return [];
    }
  }) : [];
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const acceptance = Array.isArray(value.acceptance) ? value.acceptance.slice(0, 256).flatMap((item) => {
    try {
      return [normalizeTaskAcceptance(item, evidenceIds)];
    } catch {
      return [];
    }
  }) : [];
  const timeline = Array.isArray(value.timeline) ? value.timeline.slice(-400).flatMap((item) => {
    try {
      return [normalizeTaskTimelineItem(item)];
    } catch {
      return [];
    }
  }) : [];
  return Object.freeze({
    schemaVersion: 1,
    revision,
    taskId,
    title: safeText(typeof value.title === "string" ? value.title : "Agent task", 160),
    requestSummary: safeText(typeof value.requestSummary === "string" ? value.requestSummary : "Task details unavailable.", 2048),
    status,
    phase,
    startedAt: timestamp(value.startedAt, "task startedAt"),
    updatedAt: timestamp(value.updatedAt, "task updatedAt"),
    backendId: stable(value.backendId, "backend id"),
    sessionId: nullableStable(value.sessionId, "session id"),
    turnId: nullableStable(value.turnId, "turn id"),
    model: Object.freeze({ id: safeText(typeof value.model.id === "string" ? value.model.id : "unknown", 128), reasoningEffort: reasoning, outputTokenLimit }),
    promptProfile: Object.freeze({ id: stable(value.promptProfile.id, "prompt profile id"), version: safeText(typeof value.promptProfile.version === "string" ? value.promptProfile.version : "unknown", 64), digest: digest(value.promptProfile.digest) }),
    documentRevision,
    repairIteration,
    repairLimit,
    acceptance: Object.freeze(acceptance),
    evidence: Object.freeze(evidence),
    timeline: Object.freeze(timeline),
    terminalDiagnostic: value.terminalDiagnostic === null ? null : safeText(typeof value.terminalDiagnostic === "string" ? value.terminalDiagnostic : "Task is blocked.", 512),
    resumable: value.resumable === true
  });
}
function normalizeTaskEvidence(value, taskId, currentRevision) {
  if (!isRecord(value))
    throw new ConversationReadModelError("conversation.evidence-invalid", "Evidence must be an object.");
  const type = enumValue(value.type, evidenceTypes);
  if (!type)
    throw new ConversationReadModelError("conversation.evidence-invalid", "Evidence type is invalid.");
  const evidenceTaskId = stable(value.taskId, "evidence task id");
  const documentRevision = safeInteger(value.documentRevision, 0, 1e9);
  const tick = safeInteger(value.tick, 0, 1e9);
  const frame = safeInteger(value.frame, 0, 1e9);
  const byteLength = safeInteger(value.byteLength, 0, 1e7);
  if (documentRevision === null || tick === null || frame === null || byteLength === null)
    throw new ConversationReadModelError("conversation.evidence-invalid", "Evidence coordinates are invalid.");
  const viewport2 = value.viewport === null ? null : normalizeViewport(value.viewport);
  const declared = enumValue(value.provenanceStatus, ["current", "stale", "invalid"]) ?? "invalid";
  const provenanceStatus = evidenceTaskId !== taskId ? "invalid" : currentRevision !== null && documentRevision !== currentRevision ? "stale" : declared;
  const previewDataUrl = type === "screenshot" ? normalizeScreenshotDataUrl(value.previewDataUrl) : void 0;
  return Object.freeze({
    id: stable(value.id, "evidence id"),
    type,
    taskId: evidenceTaskId,
    turnId: stable(value.turnId, "evidence turn id"),
    playId: stable(value.playId, "play id"),
    documentRevision,
    tick,
    frame,
    viewport: viewport2,
    device: value.device === null ? null : safeText(typeof value.device === "string" ? value.device : "unknown", 96),
    capturedAt: timestamp(value.capturedAt, "evidence capturedAt"),
    byteLength,
    redacted: value.redacted === true,
    producerVersion: safeText(typeof value.producerVersion === "string" ? value.producerVersion : "unknown", 96),
    provenanceStatus,
    ...previewDataUrl ? { previewDataUrl } : {}
  });
}
function normalizeTaskAcceptance(value, evidenceIds) {
  if (!isRecord(value))
    throw new ConversationReadModelError("conversation.acceptance-invalid", "Acceptance item must be an object.");
  const category = enumValue(value.category, acceptanceCategories);
  const status = enumValue(value.status, ["pending", "pass", "fail", "blocked"]);
  const visibility = enumValue(value.visibility, ["agent", "runner-only"]);
  if (!category || !status || !visibility || !Array.isArray(value.evidenceIds))
    throw new ConversationReadModelError("conversation.acceptance-invalid", "Acceptance item fields are invalid.");
  const referenced = Object.freeze(value.evidenceIds.slice(0, 64).flatMap((item) => {
    try {
      const id = stable(item, "acceptance evidence id");
      return evidenceIds.has(id) ? [id] : [];
    } catch {
      return [];
    }
  }));
  const normalizedStatus = status === "pass" && referenced.length === 0 ? "blocked" : status;
  return Object.freeze({ id: stable(value.id, "acceptance id"), label: safeText(typeof value.label === "string" ? value.label : "Acceptance criterion", 240), assertion: safeText(typeof value.assertion === "string" ? value.assertion : "Unspecified assertion", 2e3), category, required: value.required === true, visibility, status: normalizedStatus, evidenceIds: referenced, diagnostic: value.diagnostic === null ? null : safeText(typeof value.diagnostic === "string" ? value.diagnostic : "Evidence is unavailable.", 512) });
}
function normalizeTaskTimelineItem(value) {
  if (!isRecord(value))
    throw new ConversationReadModelError("conversation.timeline-invalid", "Timeline item must be an object.");
  const phase = enumValue(value.phase, taskPhases);
  const status = enumValue(value.status, ["active", "complete", "warning", "error"]);
  if (!phase || !status)
    throw new ConversationReadModelError("conversation.timeline-invalid", "Timeline item status is invalid.");
  const tick = value.tick === null ? null : safeInteger(value.tick, 0, 1e9);
  if (tick === null && value.tick !== null)
    throw new ConversationReadModelError("conversation.timeline-invalid", "Timeline tick is invalid.");
  return Object.freeze({ id: stable(value.id, "timeline id"), at: timestamp(value.at, "timeline timestamp"), phase, status, title: safeText(typeof value.title === "string" ? value.title : "Task update", 160), detail: safeText(typeof value.detail === "string" ? value.detail : "", 1024), turnId: nullableStable(value.turnId, "timeline turn id"), toolCallId: nullableStable(value.toolCallId, "timeline tool call id"), playId: nullableStable(value.playId, "timeline play id"), tick });
}
function approvalFromNode(node) {
  if (node.knownKind !== "approval")
    return null;
  const content = node.content;
  if (!isApprovalContent(content))
    return null;
  return content;
}
function questionFromNode(node) {
  if (node.knownKind !== "question")
    return null;
  const value = node.content;
  if (typeof value.prompt !== "string" || !Array.isArray(value.options))
    return null;
  return value;
}
function planFromNode(node) {
  if (node.knownKind !== "plan")
    return [];
  const items = node.content.items;
  return Array.isArray(items) ? items : [];
}
function safeText(value, maximum = MAX_PRESENTATION_TEXT) {
  return value.replace(bearerLike, "[REDACTED]").slice(0, maximum);
}
function normalizeContent(kind, value) {
  switch (kind) {
    case "text":
      return compact({ text: text(value.text ?? value.delta, MAX_PRESENTATION_TEXT), role: enumValue(value.role, ["user", "assistant", "system"]) });
    case "progress":
      return compact({ label: text(value.label, 160), message: text(value.message, 1024), current: finite(value.current), total: finite(value.total) });
    case "question":
      return normalizeQuestion(value);
    case "plan":
      return normalizePlan(value);
    case "tool-call":
      return compact({ toolCallId: stableOptional(value.toolCallId), toolId: text(value.toolId, 128), target: text(value.target, 256), effect: enumValue(value.effect, ["observe", "reversible-edit", "trusted-code", "runtime-start"]), argumentsSummary: text(value.argumentsSummary, 2048) });
    case "tool-result":
      return compact({ toolCallId: stableOptional(value.toolCallId), toolId: text(value.toolId, 128), summary: text(value.summary, 2048), details: text(value.details, 4096), resultStatus: enumValue(value.resultStatus ?? value.status, ["completed", "failed", "cancelled"]) });
    case "approval":
      return normalizeApproval(value);
    case "diagnostic":
      return compact({ code: text(value.code, 96), message: text(value.message, 2048), severity: enumValue(value.severity, ["info", "warning", "error"]), retryable: typeof value.retryable === "boolean" ? value.retryable : void 0 });
    case "completion":
      return compact({ summary: text(value.summary, 2048), terminalStatus: enumValue(value.terminalStatus ?? value.status, ["completed", "failed", "cancelled", "interrupted"]) });
  }
}
function normalizeQuestion(value) {
  const options = Array.isArray(value.options) ? value.options.slice(0, 20).flatMap((item) => {
    if (!isRecord(item))
      return [];
    try {
      return [Object.freeze({ id: stable(item.id, "question option id"), label: text(item.label, 160) ?? "Option", ...typeof item.description === "string" ? { description: safeText(item.description, 512) } : {} })];
    } catch {
      return [];
    }
  }) : [];
  return Object.freeze({ prompt: text(value.prompt, 2048) ?? "The Agent needs more information.", options: Object.freeze(options), allowFreeform: value.allowFreeform === true, multiple: value.multiple === true });
}
function normalizePlan(value) {
  const items = Array.isArray(value.items) ? value.items.slice(0, 50).flatMap((item) => {
    if (!isRecord(item))
      return [];
    try {
      return [Object.freeze({ id: stable(item.id, "plan item id"), label: text(item.label, 240) ?? "Plan item", ...typeof item.details === "string" ? { details: safeText(item.details, 1024) } : {}, status: enumValue(item.status, ["pending", "accepted", "rejected", "completed"]) ?? "pending" })];
    } catch {
      return [];
    }
  }) : [];
  return compact({
    title: text(value.title, 240) ?? "Proposed plan",
    summary: text(value.summary, 2048),
    decision: enumValue(value.decision, ["approved", "revision-requested"]),
    note: text(value.note, 2048),
    items: Object.freeze(items)
  });
}
function normalizeApproval(value) {
  const effect = enumValue(value.effect, ["reversible-edit", "trusted-code", "runtime-start"]);
  const risk = enumValue(value.risk, ["medium", "high"]);
  const decision = enumValue(value.decision, ["pending", "allow-once", "allow-always", "reject", "cancel", "expired", "stale", "unavailable"]);
  if (!effect || !risk || !decision)
    return Object.freeze({ summary: "Invalid approval payload; actions are disabled.", decision: "unavailable" });
  try {
    const argsDigest = digest(value.argsDigest);
    const previewDigest = digest(value.previewDigest);
    return Object.freeze({
      approvalId: stable(value.approvalId, "approval id"),
      toolCallId: stable(value.toolCallId, "tool call id"),
      toolId: text(value.toolId, 128) ?? "unknown",
      toolVersion: text(value.toolVersion, 32) ?? "unknown",
      target: text(value.target, 256) ?? "Unknown target",
      effect,
      risk,
      argumentsSummary: text(value.argumentsSummary, 2048) ?? "No argument summary provided.",
      previewDiff: text(value.previewDiff, 4096) ?? "No preview diff provided.",
      baseRevision: Number.isInteger(value.baseRevision) && value.baseRevision >= 0 ? value.baseRevision : 0,
      argsDigest,
      previewDigest,
      ...value.expiresAt === void 0 ? {} : { expiresAt: timestamp(value.expiresAt, "approval expiry") },
      scope: enumValue(value.scope, ["operation", "project-session"]) ?? "operation",
      decision
    });
  } catch {
    return Object.freeze({ summary: "Invalid approval payload; actions are disabled.", decision: "unavailable" });
  }
}
function normalizeProvenance(value) {
  if (!isRecord(value))
    throw new ConversationReadModelError("conversation.provenance-invalid", "Conversation provenance is missing.");
  return Object.freeze({ backendId: stable(value.backendId, "backend id"), sessionId: stable(value.sessionId, "session id"), turnId: stable(value.turnId, "turn id"), ...value.stepId === void 0 ? {} : { stepId: stable(value.stepId, "step id") } });
}
function normalizeRateLimit(value) {
  if (!isRecord(value))
    return Object.freeze({ name: "unknown" });
  const usedPercent = typeof value.usedPercent === "number" && Number.isFinite(value.usedPercent) ? Math.max(0, Math.min(100, value.usedPercent)) : void 0;
  return Object.freeze({ name: safeText(typeof value.name === "string" ? value.name : "unknown", 80), ...usedPercent === void 0 ? {} : { usedPercent }, ...typeof value.resetsAt === "string" ? { resetsAt: safeText(value.resetsAt, 80) } : {} });
}
function normalizeModel(value) {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.label !== "string" || !Array.isArray(value.reasoningEfforts))
    return [];
  const efforts = Object.freeze(value.reasoningEfforts.flatMap((item) => {
    const effort = reasoningEffort(item);
    return effort ? [effort] : [];
  }).slice(0, 8));
  const defaultEffort = reasoningEffort(value.defaultReasoningEffort);
  const maximum = safeInteger(value.maxOutputTokens, 1, 1e6);
  if (!efforts.length || !defaultEffort || !efforts.includes(defaultEffort) || maximum === null)
    return [];
  return [Object.freeze({ id: safeText(value.id, 128), label: safeText(value.label, 128), reasoningEfforts: efforts, defaultReasoningEffort: defaultEffort, maxOutputTokens: maximum, isDefault: value.isDefault === true })];
}
function normalizeBudget(value) {
  if (!isRecord(value) || value.schemaVersion !== 2 || !isRecord(value.limits) || !["observe", "soft", "hard"].includes(String(value.enforcement)))
    throw new ConversationReadModelError("conversation.budget-invalid", "Task budget is invalid.");
  const limits = value.limits;
  const nullable = (key) => {
    const item = limits[key];
    if (item === null)
      return null;
    const result2 = safeInteger(item, key === "repairIterations" ? 0 : 1, 1e9);
    if (result2 === null)
      throw new ConversationReadModelError("conversation.budget-invalid", `Budget ${key} is invalid.`);
    return result2;
  };
  const required = (key) => {
    const result2 = nullable(key);
    if (result2 === null)
      throw new ConversationReadModelError("conversation.budget-invalid", `Budget ${key} cannot be null.`);
    return result2;
  };
  return Object.freeze({ schemaVersion: 2, id: stable(value.id, "budget id"), enforcement: value.enforcement, limits: Object.freeze({
    inputTokens: nullable("inputTokens"),
    outputTokens: nullable("outputTokens"),
    estimatedCostMicros: nullable("estimatedCostMicros"),
    wallTimeMs: required("wallTimeMs"),
    turns: required("turns"),
    toolCalls: required("toolCalls"),
    repairIterations: required("repairIterations"),
    observationBytes: required("observationBytes")
  }) });
}
function reasoningEffort(value) {
  return ["backend-default", "off", "low", "medium", "high", "xhigh"].includes(String(value)) ? value : null;
}
function safeInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;
}
function isApprovalContent(value) {
  return typeof value.approvalId === "string" && typeof value.toolCallId === "string" && typeof value.toolId === "string" && value.decision !== "unavailable" && typeof value.argsDigest === "string" && (value.scope === "operation" || value.scope === "project-session");
}
function stable(value, label) {
  if (typeof value !== "string")
    throw new ConversationReadModelError("conversation.id-invalid", `${label} is invalid.`);
  try {
    return asStableId(value, label);
  } catch {
    throw new ConversationReadModelError("conversation.id-invalid", `${label} is invalid.`);
  }
}
function stableOptional(value) {
  try {
    return value === void 0 ? void 0 : stable(value, "id");
  } catch {
    return void 0;
  }
}
function nullableStable(value, label) {
  return value === null || value === void 0 ? null : stable(value, label);
}
function normalizeViewport(value) {
  if (!isRecord(value))
    throw new ConversationReadModelError("conversation.evidence-invalid", "Evidence viewport is invalid.");
  const width = safeInteger(value.width, 1, 16384);
  const height = safeInteger(value.height, 1, 16384);
  if (width === null || height === null)
    throw new ConversationReadModelError("conversation.evidence-invalid", "Evidence viewport is invalid.");
  return Object.freeze({ width, height });
}
function normalizeScreenshotDataUrl(value) {
  if (value === void 0)
    return void 0;
  if (typeof value !== "string" || utf8Bytes(value) > MAX_SCREENSHOT_DATA_URL_BYTES || !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/u.test(value))
    throw new ConversationReadModelError("conversation.evidence-preview-invalid", "Screenshot preview is invalid.");
  return value;
}
function timestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new ConversationReadModelError("conversation.timestamp-invalid", `${label} is invalid.`);
  return value;
}
function boundedString(value, label, maximum) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    throw new ConversationReadModelError("conversation.string-invalid", `${label} is invalid.`);
  return safeText(value, maximum);
}
function text(value, maximum) {
  return typeof value === "string" ? safeText(value, maximum) : void 0;
}
function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function digest(value) {
  if (typeof value !== "string" || !digestPattern.test(value))
    throw new ConversationReadModelError("conversation.digest-invalid", "Digest is invalid.");
  return value;
}
function enumValue(value, allowed) {
  return typeof value === "string" && allowed.includes(value) ? value : void 0;
}
function compact(value) {
  return Object.freeze(Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== void 0)));
}
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}
function utf8Bytes(value) {
  return new TextEncoder().encode(value).byteLength;
}

// packages/studio-shell/dist/conversation/execution-graph.js
var terminalStatuses = /* @__PURE__ */ new Set(["completed", "failed", "cancelled"]);
var activeStatuses = /* @__PURE__ */ new Set(["running", "waiting", "outcome-unknown"]);
function projectExecutionGraph(input) {
  const ops2 = [...input.ops].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
  const diagnostics = [];
  validatePrefix(input.sessionId, ops2, diagnostics);
  const nodes = /* @__PURE__ */ new Map();
  const edges = /* @__PURE__ */ new Map();
  const opToGraphNode = /* @__PURE__ */ new Map();
  const sourceNodeToGraphNode = /* @__PURE__ */ new Map();
  const transcriptByOp = new Map((input.transcript ?? []).map((entry) => [entry.opId, entry]));
  const transcript2 = [];
  const rootId = graphId("goal", input.sessionId);
  const first = ops2[0];
  nodes.set(rootId, mutableNode({
    id: rootId,
    kind: "goal",
    status: sessionStatus(input.status, ops2),
    title: safeText2(input.activeGoal, "Agent task"),
    summary: safeText2(first?.payload.activeGoal, safeText2(input.activeGoal, "Agent session")),
    startedAt: first?.timestamp ?? (/* @__PURE__ */ new Date(0)).toISOString()
  }));
  let latestPressure = null;
  let latestCompaction = null;
  const toolIntervals = /* @__PURE__ */ new Map();
  for (const op of ops2) {
    const graphNodeId = graphNodeIdFor(op, input.sessionId);
    if (!graphNodeId) {
      diagnostics.push(freeze({ code: "graph.coordinate-missing", message: `Session operation ${op.id} has no graph coordinate.`, sourceOpId: op.id }));
      continue;
    }
    const descriptor = describeOp(op, input.activeGoal ?? null);
    const existing = nodes.get(graphNodeId);
    const node = existing ?? mutableNode({
      id: graphNodeId,
      kind: descriptor.kind,
      status: descriptor.status,
      title: descriptor.title,
      summary: descriptor.summary,
      turnId: op.turnId,
      batchId: op.batchId,
      sourceNodeId: op.nodeId,
      startedAt: op.timestamp
    });
    foldNode(node, op, descriptor);
    nodes.set(graphNodeId, node);
    if (op.kind === "turn.completed" && op.turnId) {
      const turnNode = nodes.get(graphId("turn", op.turnId));
      if (turnNode) {
        turnNode.status = descriptor.status;
        turnNode.summary = descriptor.summary;
        turnNode.completedAt = op.timestamp;
        turnNode.sourceOpIds.push(op.id);
      }
    }
    opToGraphNode.set(op.id, graphNodeId);
    if (op.nodeId)
      sourceNodeToGraphNode.set(op.nodeId, graphNodeId);
    if (graphNodeId !== rootId) {
      const parent = ensureStructuralParents(op, input.sessionId, rootId, nodes, edges);
      addEdge(edges, "contains", parent, graphNodeId, op.id);
    }
    if (op.kind === "tool.started" && op.batchId)
      toolIntervals.set(graphNodeId, freeze({ batchId: op.batchId, startedAt: Date.parse(op.timestamp), completedAt: null }));
    if ((op.kind === "tool.completed" || op.kind === "tool.outcome-unknown") && op.batchId) {
      const interval = toolIntervals.get(graphNodeId);
      if (interval)
        toolIntervals.set(graphNodeId, freeze({ ...interval, completedAt: Date.parse(op.timestamp) }));
    }
    const compaction2 = compactionRecord(op.payload.compaction);
    if (compaction2) {
      latestCompaction = compaction2;
      latestPressure = compaction2.after ?? compaction2.before;
    }
    const pressure2 = contextPressure(op.payload.pressure);
    if (pressure2)
      latestPressure = pressure2;
    const transcriptEntry = transcriptByOp.get(op.id);
    if (transcriptEntry)
      transcript2.push(freeze({
        id: transcriptEntry.id,
        kind: "message",
        role: transcriptEntry.role,
        timestamp: transcriptEntry.timestamp,
        title: transcriptEntry.role === "user" ? "You" : "Agent",
        body: safeText2(transcriptEntry.content, ""),
        status: "completed",
        sourceOpIds: freeze([op.id]),
        graphNodeIds: freeze([graphNodeId]),
        artifactRefs: freeze([...op.artifactRefs])
      }));
    const systemItem = transcriptItemFor(op, graphNodeId, descriptor);
    if (systemItem)
      transcript2.push(systemItem);
  }
  for (const op of ops2) {
    const to = opToGraphNode.get(op.id);
    if (!to)
      continue;
    if (op.parentOpId)
      addReferenceEdge("depends-on", op.parentOpId, to, op, opToGraphNode, sourceNodeToGraphNode, edges, diagnostics);
    for (const dependency of op.dependsOn)
      addReferenceEdge("depends-on", dependency, to, op, opToGraphNode, sourceNodeToGraphNode, edges, diagnostics);
    if (op.kind === "document.committed")
      connectTransaction(op, to, nodes, edges, sourceNodeToGraphNode);
    if (op.kind === "approval.requested" || op.kind === "question.requested")
      connectBarrier(op, to, edges, sourceNodeToGraphNode);
    if (op.kind === "evidence.captured" || op.kind === "evaluation.completed")
      connectEvidence(op, to, nodes, edges);
    if (op.kind === "compaction.completed")
      connectCompaction(op, to, ops2, opToGraphNode, edges);
    const retrySource = stringValue(op.payload.retriedFrom) ?? stringValue(op.payload.retryOf);
    if (retrySource)
      addReferenceEdge("retried-from", retrySource, to, op, opToGraphNode, sourceNodeToGraphNode, edges, diagnostics);
    const resumedSource = stringValue(op.payload.resumedFrom);
    if (resumedSource)
      addReferenceEdge("resumed-from", resumedSource, to, op, opToGraphNode, sourceNodeToGraphNode, edges, diagnostics);
  }
  connectParallelIntervals(toolIntervals, edges);
  const root2 = nodes.get(rootId);
  if (root2)
    root2.status = sessionStatus(input.status, ops2);
  const frozenNodes = freeze([...nodes.values()].map(freezeNode).sort(compareNodes));
  const frozenEdges = freeze([...edges.values()].map((edge) => freeze({ ...edge, sourceOpIds: freeze(unique(edge.sourceOpIds).sort()) })).sort(compareEdges));
  const currentNodeIds = freeze(frozenNodes.filter((node) => activeStatuses.has(node.status)).map((node) => node.id));
  const criticalPathNodeIds = freeze(calculateCriticalPath(frozenNodes, frozenEdges));
  const sortedTranscript = freeze(transcript2.sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id)));
  const context = contextModel(latestPressure, latestCompaction, frozenNodes);
  const throughSequence = ops2.at(-1)?.sequence ?? -1;
  const semantic = {
    schemaVersion: 1,
    sessionId: input.sessionId,
    revision: throughSequence + 1,
    title: nodes.get(rootId)?.title ?? "Agent task",
    status: nodes.get(rootId)?.status ?? "pending",
    nodes: frozenNodes,
    edges: frozenEdges,
    criticalPathNodeIds,
    currentNodeIds,
    transcript: sortedTranscript,
    context,
    diagnostics: freeze([...diagnostics]),
    throughSequence
  };
  return freeze({ ...semantic, digest: sha256Digest(canonicalStringify(semantic)) });
}
function normalizeExecutionGraphs(value) {
  if (!Array.isArray(value))
    return freeze([]);
  const result2 = [];
  const sessions = /* @__PURE__ */ new Set();
  for (const item of value.slice(-50)) {
    try {
      const graph2 = normalizeExecutionGraph(item);
      if (sessions.has(graph2.sessionId))
        continue;
      sessions.add(graph2.sessionId);
      result2.push(graph2);
    } catch {
    }
  }
  return freeze(result2.sort(compareExecutionGraphs));
}
function compareExecutionGraphs(left, right) {
  const latest = (graph2) => {
    let timestamp2 = "";
    for (const node of graph2.nodes)
      for (const value of [node.startedAt, node.completedAt])
        if (value && value > timestamp2)
          timestamp2 = value;
    for (const item of graph2.transcript)
      if (item.timestamp > timestamp2)
        timestamp2 = item.timestamp;
    return timestamp2;
  };
  return latest(left).localeCompare(latest(right)) || left.sessionId.localeCompare(right.sessionId);
}
function normalizeExecutionGraph(value) {
  if (!record(value) || value.schemaVersion !== 1 || !stringValue(value.sessionId) || !stringValue(value.digest))
    throw new TypeError("Execution Graph envelope is invalid.");
  const serialized = JSON.stringify(value);
  if (serialized.length > 8 * 1024 * 1024)
    throw new TypeError("Execution Graph exceeds the renderer budget.");
  if (!Array.isArray(value.nodes) || value.nodes.length > 5e3 || !Array.isArray(value.edges) || value.edges.length > 2e4 || !Array.isArray(value.transcript) || value.transcript.length > 1e4 || !Array.isArray(value.diagnostics) || value.diagnostics.length > 1e3)
    throw new TypeError("Execution Graph collections are invalid.");
  const nodeIds = /* @__PURE__ */ new Set();
  for (const node of value.nodes) {
    if (!record(node) || !stringValue(node.id) || nodeIds.has(node.id) || !stringValue(node.kind) || !stringValue(node.status) || !stringValue(node.title) || !Array.isArray(node.sourceOpIds) || !Array.isArray(node.artifactRefs) || !record(node.detail))
      throw new TypeError("Execution Graph node is invalid.");
    nodeIds.add(node.id);
  }
  for (const edge of value.edges)
    if (!record(edge) || !stringValue(edge.id) || !stringValue(edge.kind) || !stringValue(edge.from) || !stringValue(edge.to) || !nodeIds.has(edge.from) || !nodeIds.has(edge.to) || !Array.isArray(edge.sourceOpIds))
      throw new TypeError("Execution Graph edge is invalid.");
  for (const item of value.transcript)
    if (!record(item) || !stringValue(item.id) || !stringValue(item.kind) || !stringValue(item.role) || !stringValue(item.timestamp) || !stringValue(item.title) || typeof item.body !== "string" || !Array.isArray(item.sourceOpIds) || !Array.isArray(item.graphNodeIds))
      throw new TypeError("Execution Graph transcript item is invalid.");
  const { digest: digest2, ...semantic } = value;
  if (!/^sha256:[a-f0-9]{64}$/u.test(String(digest2)) || sha256Digest(canonicalStringify(semantic)) !== digest2)
    throw new TypeError("Execution Graph digest is invalid.");
  return deepFreeze(value);
}
function validatePrefix(sessionId2, ops2, diagnostics) {
  let expected = 0;
  for (const op of ops2) {
    if (op.sessionId !== sessionId2 || op.sequence !== expected)
      diagnostics.push(freeze({ code: "graph.sequence-gap", message: `Expected sequence ${expected}; received ${op.sequence} for ${op.id}.`, sourceOpId: op.id }));
    expected = op.sequence + 1;
  }
}
function graphNodeIdFor(op, sessionId2) {
  if (op.kind === "session.created" || op.kind === "session.status-changed" || op.kind === "session.checkpointed" || op.kind === "backend.bound" || op.kind === "backend.detached")
    return graphId("goal", sessionId2);
  if (op.kind === "turn.started")
    return op.turnId ? graphId("turn", op.turnId) : null;
  if (op.kind === "turn.completed")
    return graphId("result", op.id);
  if (op.kind.startsWith("tool-batch."))
    return op.nodeId ? graphId("tool", op.nodeId) : op.batchId ? graphId("batch", op.batchId) : null;
  if (op.kind.startsWith("tool."))
    return op.nodeId ? graphId("tool", op.nodeId) : null;
  if (op.kind.startsWith("approval."))
    return graphId("barrier", stringValue(op.payload.approvalId) ?? op.nodeId ?? op.id);
  if (op.kind.startsWith("question."))
    return graphId(stringValue(op.payload.barrierKind) === "plan-review" ? "plan" : "barrier", stringValue(op.payload.questionId) ?? op.nodeId ?? op.id);
  if (op.kind === "document.committed")
    return graphId("transaction", stringValue(op.payload.transactionId) ?? op.id);
  if (op.kind.startsWith("compaction."))
    return graphId("compaction", op.nodeId ?? op.id);
  if (op.kind === "evidence.captured")
    return graphId("evidence", op.nodeId ?? op.artifactRefs[0] ?? op.id);
  if (op.kind === "evaluation.completed")
    return graphId("evaluation", op.nodeId ?? op.artifactRefs[0] ?? op.id);
  if (op.kind === "user.message" || op.kind === "assistant.message")
    return op.turnId ? graphId("turn", op.turnId) : graphId("goal", sessionId2);
  return graphId("unknown", op.id);
}
function describeOp(op, activeGoal) {
  const payloadStatus = stringValue(op.payload.status);
  switch (op.kind) {
    case "session.created":
      return freeze({ kind: "goal", status: "pending", title: safeText2(activeGoal ?? op.payload.activeGoal, "Agent task"), summary: "Session created." });
    case "session.status-changed":
      return freeze({ kind: "goal", status: productStatus(payloadStatus), title: safeText2(activeGoal, "Agent task"), summary: safeText2(op.payload.reason, `Session ${payloadStatus ?? "updated"}.`) });
    case "session.checkpointed":
      return freeze({ kind: "goal", status: "running", title: safeText2(activeGoal, "Agent task"), summary: "Safe recovery checkpoint saved." });
    case "backend.bound":
      return freeze({ kind: "goal", status: "running", title: safeText2(activeGoal, "Agent task"), summary: "Backend session connected." });
    case "backend.detached":
      return freeze({ kind: "goal", status: "waiting", title: safeText2(activeGoal, "Agent task"), summary: "Backend session disconnected." });
    case "turn.started":
      return freeze({ kind: "turn", status: "running", title: safeText2(op.payload.title, "Agent turn"), summary: safeText2(op.payload.summary, "Agent is working on the request.") });
    case "turn.completed":
      return freeze({ kind: "result", status: productStatus(payloadStatus), title: `Turn ${payloadStatus ?? "completed"}`, summary: safeText2(op.payload.summary, "Agent turn finished.") });
    case "user.message":
      return freeze({ kind: "turn", status: "running", title: "User request", summary: "User supplied additional direction." });
    case "assistant.message":
      return freeze({ kind: "turn", status: "running", title: "Agent response", summary: "Agent produced a response." });
    case "tool-batch.planned":
      return freeze({ kind: op.nodeId ? "tool" : "tool-batch", status: "pending", title: op.nodeId ? toolTitle(op) : "Tool batch", summary: op.nodeId ? toolSummary(op) : "Tool work was planned." });
    case "tool-batch.started":
      return freeze({ kind: "tool-batch", status: "running", title: "Tool batch", summary: "Independent ready tools are being scheduled." });
    case "tool-batch.completed":
      return freeze({ kind: "tool-batch", status: productStatus(payloadStatus), title: "Tool batch", summary: batchSummary(op) });
    case "tool.started":
      return freeze({ kind: "tool", status: "running", title: toolTitle(op), summary: toolSummary(op) });
    case "tool.completed":
      return freeze({ kind: "tool", status: productStatus(payloadStatus), title: toolTitle(op), summary: safeText2(op.payload.summary, `${stringValue(op.payload.toolId) ?? "Tool"} ${payloadStatus ?? "completed"}.`) });
    case "tool.outcome-unknown":
      return freeze({ kind: "tool", status: "outcome-unknown", title: toolTitle(op), summary: safeText2(op.payload.reason, "The effect outcome must be reconciled before retrying.") });
    case "approval.requested":
      return freeze({ kind: "approval", status: "waiting", title: "Approval required", summary: safeText2(op.payload.reason, safeText2(op.payload.toolId, "A protected action needs approval.")) });
    case "approval.resolved":
      return freeze({ kind: "approval", status: op.payload.denied === true ? "cancelled" : "completed", title: "Approval resolved", summary: `Decision: ${stringValue(op.payload.resolution) ?? "recorded"}.` });
    case "question.requested":
      return freeze({ kind: stringValue(op.payload.barrierKind) === "plan-review" ? "plan" : "question", status: "waiting", title: barrierTitle(op), summary: safeText2(op.payload.reason, "Agent needs user input.") });
    case "question.resolved":
      return freeze({ kind: "question", status: stringValue(op.payload.resolution) === "cancelled" ? "cancelled" : "completed", title: "User input received", summary: `Resolution: ${stringValue(op.payload.resolution) ?? "answered"}.` });
    case "document.committed":
      return freeze({ kind: "transaction", status: "completed", title: "Project changes committed", summary: revisionSummary(op) });
    case "evidence.captured":
      return freeze({ kind: "evidence", status: "completed", title: safeText2(op.payload.evidenceType, "Evidence captured"), summary: safeText2(op.payload.summary, `${op.artifactRefs.length} evidence artifact(s).`) });
    case "evaluation.completed":
      return freeze({ kind: "evaluation", status: productStatus(payloadStatus), title: "Validation result", summary: safeText2(op.payload.summary, `Evaluation ${payloadStatus ?? "completed"}.`) });
    case "compaction.requested":
      return freeze({ kind: "compaction", status: "pending", title: "Context compaction", summary: compactionSummary(op) });
    case "compaction.started":
      return freeze({ kind: "compaction", status: "running", title: "Context compaction", summary: compactionSummary(op) });
    case "compaction.summary-created":
      return freeze({ kind: "compaction", status: "running", title: "Context summary created", summary: compactionSummary(op) });
    case "compaction.completed":
      return freeze({ kind: "compaction", status: "completed", title: "Context compacted", summary: compactionSummary(op) });
    case "compaction.failed":
      return freeze({ kind: "compaction", status: "failed", title: "Context compaction failed", summary: compactionSummary(op) });
    default:
      return freeze({ kind: "unknown", status: "waiting", title: `Unsupported operation: ${String(op.kind)}`, summary: "A newer Session operation is present. Update Studio to inspect it." });
  }
}
function foldNode(node, op, descriptor) {
  node.kind = node.kind === "unknown" ? descriptor.kind : node.kind;
  node.status = descriptor.status;
  node.title = descriptor.title;
  node.summary = descriptor.summary;
  node.turnId ??= op.turnId;
  node.batchId ??= op.batchId;
  node.sourceNodeId ??= op.nodeId;
  node.sourceOpIds.push(op.id);
  node.artifactRefs.push(...op.artifactRefs);
  if (op.kind === "tool.started" || op.kind === "tool-batch.started" || op.kind === "compaction.started" || op.kind === "turn.started")
    node.startedAt = op.timestamp;
  if (node.projectRevisionBefore === null)
    node.projectRevisionBefore = numberValue(op.payload.beforeRevision) ?? op.projectRevision;
  node.projectRevisionAfter = numberValue(op.payload.afterRevision) ?? op.projectRevision ?? node.projectRevisionAfter;
  if (terminalStatuses.has(descriptor.status) || descriptor.status === "outcome-unknown")
    node.completedAt = op.timestamp;
  node.toolId = stringValue(op.payload.toolId) ?? node.toolId;
  node.toolVersion = stringValue(op.payload.toolVersion) ?? node.toolVersion;
  node.executionClass = stringValue(op.payload.executionClass) ?? node.executionClass;
  node.barrierKind = stringValue(op.payload.barrierKind) ?? node.barrierKind;
  node.transactionId = stringValue(op.payload.transactionId) ?? node.transactionId;
  const usage = stringValue(op.payload.usageRecordId);
  if (usage)
    node.usageRecordIds.push(usage);
  const cost = stringValue(op.payload.costRecordId);
  if (cost)
    node.costRecordIds.push(cost);
  node.diagnostic = stringValue(op.payload.diagnostic) ?? stringValue(op.payload.code) ?? node.diagnostic;
  node.validation = stringValue(op.payload.validation) ?? node.validation;
}
function ensureStructuralParents(op, sessionId2, rootId, nodes, edges) {
  if (!op.turnId)
    return rootId;
  const turnId2 = graphId("turn", op.turnId);
  if (!nodes.has(turnId2))
    nodes.set(turnId2, mutableNode({ id: turnId2, kind: "turn", status: "running", title: "Agent turn", summary: "Turn reconstructed from child operations.", turnId: op.turnId, startedAt: op.timestamp }));
  addEdge(edges, "contains", rootId, turnId2, op.id);
  if (!op.batchId || graphNodeIdFor(op, sessionId2) === graphId("batch", op.batchId))
    return turnId2;
  const batchId = graphId("batch", op.batchId);
  if (!nodes.has(batchId))
    nodes.set(batchId, mutableNode({ id: batchId, kind: "tool-batch", status: "pending", title: "Tool batch", summary: "Batch reconstructed from member tools.", turnId: op.turnId, batchId: op.batchId, startedAt: op.timestamp }));
  addEdge(edges, "contains", turnId2, batchId, op.id);
  return batchId;
}
function connectTransaction(op, transactionNodeId, nodes, edges, sourceNodeToGraphNode) {
  const memberIds = arrayOfStrings(op.payload.memberNodeIds);
  for (const memberId of memberIds) {
    const tool = sourceNodeToGraphNode.get(memberId) ?? graphId("tool", memberId);
    if (nodes.has(tool))
      addEdge(edges, "modified", tool, transactionNodeId, op.id);
  }
}
function connectBarrier(op, barrierNodeId, edges, sourceNodeToGraphNode) {
  const toolCallId = stringValue(op.payload.toolCallId);
  if (!toolCallId)
    return;
  const tool = sourceNodeToGraphNode.get(toolCallId) ?? graphId("tool", toolCallId);
  addEdge(edges, "blocked-by", tool, barrierNodeId, op.id);
}
function connectEvidence(op, evidenceNodeId, nodes, edges) {
  const transactionId = stringValue(op.payload.transactionId);
  if (transactionId) {
    const transaction = graphId("transaction", transactionId);
    if (nodes.has(transaction))
      addEdge(edges, "validated-by", transaction, evidenceNodeId, op.id);
  }
  const targetNodeId = stringValue(op.payload.targetNodeId) ?? stringValue(op.payload.toolNodeId);
  if (targetNodeId) {
    const target = graphId("tool", targetNodeId);
    if (nodes.has(target))
      addEdge(edges, "validated-by", target, evidenceNodeId, op.id);
  }
}
function connectCompaction(op, compactionNodeId, ops2, opToGraphNode, edges) {
  const record2 = compactionRecord(op.payload.compaction);
  if (!record2)
    return;
  for (const source of ops2) {
    if (source.sequence < record2.coveredStartSequence || source.sequence > record2.coveredEndSequence)
      continue;
    const from = opToGraphNode.get(source.id);
    if (from && from !== compactionNodeId)
      addEdge(edges, "compacted-into", from, compactionNodeId, op.id);
  }
}
function addReferenceEdge(kind, reference, to, op, opToGraphNode, sourceNodeToGraphNode, edges, diagnostics) {
  const from = opToGraphNode.get(reference) ?? sourceNodeToGraphNode.get(reference);
  if (!from) {
    diagnostics.push(freeze({ code: "graph.reference-missing", message: `Operation ${op.id} references missing dependency ${reference}.`, sourceOpId: op.id }));
    return;
  }
  if (from !== to)
    addEdge(edges, kind, from, to, op.id);
}
function connectParallelIntervals(intervals, edges) {
  const entries = [...intervals.entries()];
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    const [leftId, left] = entries[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const [rightId, right] = entries[rightIndex];
      if (left.batchId !== right.batchId)
        continue;
      const leftEnd = left.completedAt ?? Number.POSITIVE_INFINITY;
      const rightEnd = right.completedAt ?? Number.POSITIVE_INFINITY;
      if (left.startedAt < rightEnd && right.startedAt < leftEnd)
        addEdge(edges, "parallel-with", leftId, rightId, `parallel:${left.batchId}`);
    }
  }
}
function transcriptItemFor(op, graphNodeId, descriptor) {
  let kind = null;
  let role = "system";
  if (op.kind === "approval.requested" || op.kind === "approval.resolved" || op.kind === "question.requested" || op.kind === "question.resolved")
    kind = "barrier";
  else if (op.kind === "compaction.completed" || op.kind === "compaction.failed")
    kind = "compaction";
  else if (op.kind === "tool.outcome-unknown")
    kind = "recovery";
  else if (op.kind === "turn.completed")
    kind = "result";
  else if (op.kind === "session.checkpointed" && op.payload.recoveredAfterRestart === true)
    kind = "recovery";
  if (!kind)
    return null;
  return freeze({ id: graphId("transcript", op.id), kind, role, timestamp: op.timestamp, title: descriptor.title, body: descriptor.summary, status: descriptor.status, sourceOpIds: freeze([op.id]), graphNodeIds: freeze([graphNodeId]), artifactRefs: freeze([...op.artifactRefs]) });
}
function contextModel(pressure2, latestCompaction, nodes) {
  const blocker = nodes.find((node) => node.status === "waiting" || node.status === "outcome-unknown");
  const running = nodes.find((node) => node.kind === "tool" || node.kind === "tool-batch" ? node.status === "running" : false);
  const compactionBlockedReason = blocker ? `Resolve ${blocker.title} before compacting.` : running ? "Wait for the active tool batch to reach a safe boundary." : null;
  return freeze({ pressure: pressure2, latestCompaction, compactionAvailable: compactionBlockedReason === null && pressure2 !== null, compactionBlockedReason });
}
function calculateCriticalPath(nodes, edges) {
  const relevant = /* @__PURE__ */ new Set(["depends-on", "contains", "blocked-by", "validated-by", "modified"]);
  const incoming = /* @__PURE__ */ new Map();
  for (const edge of edges)
    if (relevant.has(edge.kind))
      (incoming.get(edge.to) ?? incoming.set(edge.to, []).get(edge.to)).push(edge.from);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const score = /* @__PURE__ */ new Map();
  const previous = /* @__PURE__ */ new Map();
  const visiting = /* @__PURE__ */ new Set();
  const visit = (id) => {
    const cached = score.get(id);
    if (cached !== void 0)
      return cached;
    if (visiting.has(id))
      return 0;
    visiting.add(id);
    let best2 = 0;
    let parent = null;
    for (const candidate of incoming.get(id) ?? []) {
      if (!nodeIds.has(candidate))
        continue;
      const value2 = visit(candidate);
      if (value2 > best2) {
        best2 = value2;
        parent = candidate;
      }
    }
    visiting.delete(id);
    const node = nodes.find((item) => item.id === id);
    const value = best2 + Math.max(1, node.durationMs ?? 1);
    score.set(id, value);
    if (parent)
      previous.set(id, parent);
    return value;
  };
  let tail = null;
  let best = -1;
  for (const node of nodes) {
    const value = visit(node.id);
    if (value > best || value === best && node.id.localeCompare(tail ?? "") < 0) {
      best = value;
      tail = node.id;
    }
  }
  const path = [];
  while (tail) {
    path.unshift(tail);
    tail = previous.get(tail) ?? null;
  }
  return path;
}
function mutableNode(input) {
  return { turnId: null, batchId: null, sourceNodeId: null, sourceOpIds: [], artifactRefs: [], projectRevisionBefore: null, projectRevisionAfter: null, completedAt: null, toolId: null, toolVersion: null, executionClass: null, barrierKind: null, transactionId: null, usageRecordIds: [], costRecordIds: [], diagnostic: null, validation: null, ...input };
}
function freezeNode(node) {
  const started = Date.parse(node.startedAt);
  const completed = node.completedAt ? Date.parse(node.completedAt) : Number.NaN;
  return freeze({
    id: node.id,
    kind: node.kind,
    status: node.status,
    title: safeText2(node.title, "Untitled step"),
    summary: safeText2(node.summary, ""),
    turnId: node.turnId,
    batchId: node.batchId,
    sourceNodeId: node.sourceNodeId,
    sourceOpIds: freeze(unique(node.sourceOpIds).sort()),
    artifactRefs: freeze(unique(node.artifactRefs).sort()),
    projectRevisionBefore: node.projectRevisionBefore,
    projectRevisionAfter: node.projectRevisionAfter,
    startedAt: node.startedAt,
    completedAt: node.completedAt,
    durationMs: Number.isFinite(started) && Number.isFinite(completed) ? Math.max(0, completed - started) : null,
    detail: freeze({ toolId: node.toolId, toolVersion: node.toolVersion, executionClass: node.executionClass, barrierKind: node.barrierKind, transactionId: node.transactionId, usageRecordIds: freeze(unique(node.usageRecordIds).sort()), costRecordIds: freeze(unique(node.costRecordIds).sort()), diagnostic: node.diagnostic, validation: node.validation })
  });
}
function addEdge(edges, kind, from, to, sourceOpId) {
  if (from === to)
    return;
  const id = graphId("edge", `${kind}:${from}:${to}`);
  const existing = edges.get(id);
  if (existing) {
    existing.sourceOpIds.push(sourceOpId);
    return;
  }
  edges.set(id, { id, kind, from, to, sourceOpIds: [sourceOpId] });
}
function productStatus(value) {
  if (value === "completed" || value === "passed" || value === "success" || value === "idle")
    return "completed";
  if (value === "failed" || value === "error" || value === "blocked")
    return "failed";
  if (value === "cancelled" || value === "interrupted" || value === "denied")
    return "cancelled";
  if (value === "waiting" || value === "waiting-user" || value === "waiting-approval")
    return "waiting";
  if (value === "running" || value === "compacting")
    return "running";
  return "completed";
}
function sessionStatus(value, ops2) {
  if (value)
    return productStatus(value);
  const lastTurn = [...ops2].reverse().find((op) => op.kind === "turn.completed" || op.kind === "turn.started");
  if (!lastTurn)
    return "pending";
  return lastTurn.kind === "turn.started" ? "running" : productStatus(stringValue(lastTurn.payload.status));
}
function compactionRecord(value) {
  if (!record(value) || typeof value.id !== "string" || !record(value.before) || !Array.isArray(value.pinnedFactDigests))
    return null;
  const before = contextPressure(value.before);
  const after = value.after === null ? null : contextPressure(value.after);
  if (!before || value.after !== null && !after)
    return null;
  return freeze(value);
}
function contextPressure(value) {
  if (!record(value) || !["normal", "warning", "preparing", "compact-required", "emergency", "unknown"].includes(String(value.state)))
    return null;
  return freeze(value);
}
function compactionSummary(op) {
  const value = compactionRecord(op.payload.compaction);
  if (!value)
    return "Context compaction record is unavailable.";
  const before = value.before.ratio === null ? "unknown" : `${Math.round(value.before.ratio * 100)}%`;
  const after = value.after?.ratio === null || value.after === null ? "unknown" : `${Math.round(value.after.ratio * 100)}%`;
  return `${value.reason}; context ${before} \u2192 ${after}; covered operations ${value.coveredStartSequence}\u2013${value.coveredEndSequence}; validation ${value.validation}.`;
}
function batchSummary(op) {
  const completed = numberValue(op.payload.completed) ?? 0;
  const failed = numberValue(op.payload.failed) ?? 0;
  const cancelled = numberValue(op.payload.cancelled) ?? 0;
  return `${completed} completed, ${failed} failed, ${cancelled} cancelled.`;
}
function revisionSummary(op) {
  const before = numberValue(op.payload.beforeRevision);
  const after = numberValue(op.payload.afterRevision);
  return before === null || after === null ? "A project transaction was committed." : `Project revision r${before} \u2192 r${after}.`;
}
function toolTitle(op) {
  return safeText2(op.payload.toolId, "Tool");
}
function toolSummary(op) {
  return `${stringValue(op.payload.executionClass) ?? "bounded"} \xB7 ${arrayOfStrings(op.payload.effects).join(", ") || "effect unknown"}`;
}
function barrierTitle(op) {
  return stringValue(op.payload.barrierKind) === "budget-continuation" ? "Budget continuation" : stringValue(op.payload.barrierKind) === "plan-review" ? "Plan review" : "Agent question";
}
function graphId(prefix, value) {
  return `${prefix}:${value}`;
}
function safeText2(value, fallback, max = 2048) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback;
}
function stringValue(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function arrayOfStrings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.length > 0) : [];
}
function record(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function unique(values) {
  return [...new Set(values)];
}
function freeze(value) {
  return Object.freeze(value);
}
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value))
      deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function compareNodes(left, right) {
  return left.startedAt.localeCompare(right.startedAt) || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
}
function compareEdges(left, right) {
  return left.kind.localeCompare(right.kind) || left.from.localeCompare(right.from) || left.to.localeCompare(right.to);
}
function canonicalStringify(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string")
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(canonicalStringify).join(",")}]`;
  const object = value;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(object[key])}`).join(",")}}`;
}
function sha256Digest(value) {
  const bytes = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const data = new Uint8Array(paddedLength);
  data.set(bytes);
  data[bytes.length] = 128;
  const bitLength = bytes.length * 8;
  const view = new DataView(data.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 4294967296), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  const hash = new Uint32Array([1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924, 528734635, 1541459225]);
  const constants = new Uint32Array([1116352408, 1899447441, 3049323471, 3921009573, 961987163, 1508970993, 2453635748, 2870763221, 3624381080, 310598401, 607225278, 1426881987, 1925078388, 2162078206, 2614888103, 3248222580, 3835390401, 4022224774, 264347078, 604807628, 770255983, 1249150122, 1555081692, 1996064986, 2554220882, 2821834349, 2952996808, 3210313671, 3336571891, 3584528711, 113926993, 338241895, 666307205, 773529912, 1294757372, 1396182291, 1695183700, 1986661051, 2177026350, 2456956037, 2730485921, 2820302411, 3259730800, 3345764771, 3516065817, 3600352804, 4094571909, 275423344, 430227734, 506948616, 659060556, 883997877, 958139571, 1322822218, 1537002063, 1747873779, 1955562222, 2024104815, 2227730452, 2361852424, 2428436474, 2756734187, 3204031479, 3329325298]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < data.length; offset += 64) {
    for (let index = 0; index < 16; index += 1)
      words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const a2 = words[index - 15];
      const b2 = words[index - 2];
      const s0 = rotate(a2, 7) ^ rotate(a2, 18) ^ a2 >>> 3;
      const s1 = rotate(b2, 17) ^ rotate(b2, 19) ^ b2 >>> 10;
      words[index] = words[index - 16] + s0 + words[index - 7] + s1 >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choice = e & f ^ ~e & g;
      const t1 = h + s1 + choice + constants[index] + words[index] >>> 0;
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = a & b ^ a & c ^ b & c;
      const t2 = s0 + majority >>> 0;
      h = g;
      g = f;
      f = e;
      e = d + t1 >>> 0;
      d = c;
      c = b;
      b = a;
      a = t1 + t2 >>> 0;
    }
    hash[0] = hash[0] + a >>> 0;
    hash[1] = hash[1] + b >>> 0;
    hash[2] = hash[2] + c >>> 0;
    hash[3] = hash[3] + d >>> 0;
    hash[4] = hash[4] + e >>> 0;
    hash[5] = hash[5] + f >>> 0;
    hash[6] = hash[6] + g >>> 0;
    hash[7] = hash[7] + h >>> 0;
  }
  return `sha256:${[...hash].map((word) => word.toString(16).padStart(8, "0")).join("")}`;
}
function rotate(value, bits) {
  return value >>> bits | value << 32 - bits;
}

// packages/studio-shell/dist/conversation/projector.js
var terminalStatuses2 = /* @__PURE__ */ new Set(["completed", "failed", "cancelled"]);
var ConversationProjector = class {
  nodes = /* @__PURE__ */ new Map();
  revision = 0;
  stateRevision = -1;
  lastSequence = -1;
  connection = "disconnected";
  busy = false;
  backendId = null;
  backends = Object.freeze([]);
  taskAccounting = null;
  taskRuns = Object.freeze([]);
  executionGraphs = Object.freeze([]);
  reset(snapshot2) {
    this.nodes.clear();
    this.revision = 0;
    this.stateRevision = Math.max(0, snapshot2.revision);
    this.lastSequence = -1;
    this.connection = snapshot2.connection;
    this.busy = snapshot2.busy;
    this.backendId = snapshot2.backendId;
    this.backends = normalizeBackends(snapshot2.backends);
    this.taskAccounting = normalizeTaskAccounting(snapshot2.taskAccounting);
    this.taskRuns = normalizeTaskRuns(snapshot2.taskRuns);
    this.executionGraphs = normalizeExecutionGraphs(snapshot2.executionGraphs);
    for (const event of [...snapshot2.events].sort((left, right) => left.sequence - right.sequence))
      this.apply(event);
    return this.snapshot();
  }
  apply(event) {
    if (event.schemaVersion !== 1 || !Number.isInteger(event.sequence) || event.sequence < 0)
      return this.snapshot();
    if (event.sequence <= this.lastSequence)
      return this.snapshot();
    const node = normalizeConversationNode(event.node);
    const existing = this.nodes.get(node.id);
    if (existing && !sameCoordinates(existing, node))
      return this.snapshot();
    if (existing && terminalStatuses2.has(existing.status) && !terminalStatuses2.has(node.status))
      return this.snapshot();
    this.nodes.set(node.id, node);
    this.lastSequence = event.sequence;
    this.revision += 1;
    return this.snapshot();
  }
  applyState(value) {
    if (!Number.isInteger(value.revision) || value.revision <= this.stateRevision)
      return this.snapshot();
    this.stateRevision = value.revision;
    this.revision += 1;
    this.connection = value.connection;
    this.busy = value.busy;
    this.backendId = value.backendId;
    this.backends = normalizeBackends(value.backends);
    this.taskAccounting = normalizeTaskAccounting(value.taskAccounting);
    this.taskRuns = normalizeTaskRuns(value.taskRuns);
    this.executionGraphs = normalizeExecutionGraphs(value.executionGraphs);
    return this.snapshot();
  }
  snapshot(now = Date.now()) {
    const nodes = Object.freeze([...this.nodes.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)));
    const pendingInteraction = findPendingInteraction(nodes, now);
    const composerBlockedReason = this.connection !== "connected" ? "Reconnect before sending a message." : null;
    return Object.freeze({
      revision: this.revision,
      lastSequence: this.lastSequence,
      connection: this.connection,
      busy: this.busy,
      backendId: this.backendId,
      backends: this.backends,
      taskAccounting: this.taskAccounting,
      taskRuns: this.taskRuns,
      executionGraphs: this.executionGraphs,
      nodes,
      pendingInteraction,
      composerBlockedReason
    });
  }
};
function normalizeBackends(values) {
  const result2 = [];
  for (const value of values)
    try {
      result2.push(normalizeBackend(value));
    } catch {
    }
  return Object.freeze(result2.sort((left, right) => left.label.localeCompare(right.label)));
}
function findPendingInteraction(nodes, now) {
  for (const node of [...nodes].reverse()) {
    if (node.status !== "pending")
      continue;
    if (node.knownKind === "question")
      return Object.freeze({ nodeId: node.id, kind: "question" });
    if (node.knownKind === "plan")
      return Object.freeze({ nodeId: node.id, kind: "plan" });
    if (node.knownKind === "approval") {
      const approval = approvalFromNode(node);
      if (approval?.decision === "pending" && (approval.expiresAt === void 0 || Date.parse(approval.expiresAt) > now))
        return Object.freeze({ nodeId: node.id, kind: "approval" });
    }
  }
  return null;
}
function sameCoordinates(left, right) {
  return left.provenance.backendId === right.provenance.backendId && left.provenance.sessionId === right.provenance.sessionId && left.provenance.turnId === right.provenance.turnId && left.kind === right.kind;
}

// packages/studio-shell/dist/conversation/execution-layout.js
var importantStatuses = /* @__PURE__ */ new Set(["running", "waiting", "failed", "outcome-unknown"]);
function layoutExecutionGraph(graph2, options = {}) {
  const mode = options.mode ?? "overview";
  const query = options.query?.trim().toLocaleLowerCase() ?? "";
  const statuses2 = options.statuses ? new Set(options.statuses) : null;
  const kinds = options.kinds ? new Set(options.kinds) : null;
  const expanded = new Set(options.expandedBatchIds ?? []);
  const maxCompleted = Math.max(0, Math.min(500, options.maxCompletedToolsPerBatch ?? 24));
  const critical = new Set(graph2.criticalPathNodeIds);
  const transcriptLinked = new Set(graph2.transcript.flatMap((item) => item.graphNodeIds));
  const keep = /* @__PURE__ */ new Set();
  const completedByBatch = /* @__PURE__ */ new Map();
  for (const node of graph2.nodes) {
    const matchesQuery = !query || `${node.title}
${node.summary}
${node.detail.toolId ?? ""}
${node.detail.diagnostic ?? ""}`.toLocaleLowerCase().includes(query);
    const matchesStatus = !statuses2 || statuses2.has(node.status);
    const matchesKind = !kinds || kinds.has(node.kind);
    const matchesCost = options.costUnknown !== true || node.detail.costRecordIds.length === 0;
    if (!matchesQuery || !matchesStatus || !matchesKind || !matchesCost)
      continue;
    const always = importantStatuses.has(node.status) || node.kind !== "tool" || critical.has(node.id) || transcriptLinked.has(node.id);
    if (mode === "expanded" || always || node.batchId && expanded.has(`batch:${node.batchId}`)) {
      keep.add(node.id);
      continue;
    }
    if (node.batchId) {
      const list = completedByBatch.get(node.batchId) ?? [];
      list.push(node.id);
      completedByBatch.set(node.batchId, list);
    } else
      keep.add(node.id);
  }
  for (const ids of completedByBatch.values())
    for (const id of ids.slice(-maxCompleted))
      keep.add(id);
  preserveConnectingNodes(graph2, keep);
  const visibleNodes = graph2.nodes.filter((node) => keep.has(node.id));
  const layerById = calculateLayers(graph2, keep);
  const byLayer = /* @__PURE__ */ new Map();
  for (const node of visibleNodes) {
    const layer = layerById.get(node.id) ?? 0;
    const values = byLayer.get(layer) ?? [];
    values.push(node);
    byLayer.set(layer, values);
  }
  const horizontalGap = 88;
  const verticalGap = 28;
  const nodeWidth = 224;
  const nodeHeight = 88;
  const margin = 32;
  const layoutNodes = [];
  let maximumRows = 0;
  for (const [layer, values] of [...byLayer.entries()].sort((left, right) => left[0] - right[0])) {
    values.sort((left, right) => statusPriority(left.status) - statusPriority(right.status) || left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id));
    maximumRows = Math.max(maximumRows, values.length);
    for (const [order, node] of values.entries())
      layoutNodes.push(Object.freeze({ id: node.id, x: margin + layer * (nodeWidth + horizontalGap), y: margin + order * (nodeHeight + verticalGap), width: nodeWidth, height: nodeHeight, layer, order, hidden: false }));
  }
  const maximumLayer = Math.max(0, ...layoutNodes.map((node) => node.layer));
  return Object.freeze({
    nodes: Object.freeze(layoutNodes),
    width: margin * 2 + (maximumLayer + 1) * nodeWidth + maximumLayer * horizontalGap,
    height: margin * 2 + maximumRows * nodeHeight + Math.max(0, maximumRows - 1) * verticalGap,
    visibleNodeIds: Object.freeze(layoutNodes.map((node) => node.id))
  });
}
function preserveConnectingNodes(graph2, keep) {
  if (keep.size === 0)
    return;
  const parentByChild = /* @__PURE__ */ new Map();
  for (const edge of graph2.edges)
    if (edge.kind === "contains" || edge.kind === "depends-on") {
      const list = parentByChild.get(edge.to) ?? [];
      list.push(edge.from);
      parentByChild.set(edge.to, list);
    }
  const pending = [...keep];
  while (pending.length) {
    const id = pending.pop();
    for (const parent of parentByChild.get(id) ?? [])
      if (!keep.has(parent)) {
        keep.add(parent);
        pending.push(parent);
      }
  }
}
function calculateLayers(graph2, keep) {
  const predecessors = /* @__PURE__ */ new Map();
  for (const edge of graph2.edges) {
    if (!keep.has(edge.from) || !keep.has(edge.to) || edge.kind === "parallel-with" || edge.kind === "retried-from" || edge.kind === "supersedes")
      continue;
    const values = predecessors.get(edge.to) ?? [];
    values.push(edge.from);
    predecessors.set(edge.to, values);
  }
  const layers = /* @__PURE__ */ new Map();
  const visiting = /* @__PURE__ */ new Set();
  const visit = (id) => {
    const cached = layers.get(id);
    if (cached !== void 0)
      return cached;
    if (visiting.has(id))
      return 0;
    visiting.add(id);
    let layer = 0;
    for (const predecessor of predecessors.get(id) ?? [])
      layer = Math.max(layer, visit(predecessor) + 1);
    visiting.delete(id);
    layers.set(id, layer);
    return layer;
  };
  for (const id of keep)
    visit(id);
  return layers;
}
function statusPriority(status) {
  return { waiting: 0, "outcome-unknown": 1, failed: 2, running: 3, pending: 4, cancelled: 5, completed: 6 }[status];
}

// packages/studio-shell/dist/panels/chat/index.js
function presentChatPanel(snapshot2, now = Date.now()) {
  const cards = Object.freeze(snapshot2.nodes.map((node) => presentConversationNode(node, now)));
  const selected2 = snapshot2.backends.find((backend2) => backend2.id === snapshot2.backendId);
  const backendReady = selected2?.state === "ready" && selected2.selectedModel !== null && selected2.selectedReasoningEffort !== null && selected2.outputTokenLimit !== null;
  return Object.freeze({
    backendId: snapshot2.backendId,
    backends: snapshot2.backends,
    cards,
    composer: Object.freeze({ busy: snapshot2.busy, blockedReason: snapshot2.composerBlockedReason ?? (backendReady ? null : backendBlockedReason(selected2)), canSend: snapshot2.composerBlockedReason === null && snapshot2.backendId !== null && backendReady, canCancel: snapshot2.busy }),
    connection: snapshot2.connection,
    taskAccounting: snapshot2.taskAccounting,
    taskRuns: snapshot2.taskRuns,
    executionGraphs: snapshot2.executionGraphs ?? Object.freeze([]),
    ariaLive: cards.at(-1)?.body ?? (snapshot2.connection === "connected" ? "Agent conversation ready." : "Agent conversation disconnected.")
  });
}
function backendBlockedReason(backend2) {
  if (!backend2)
    return "Select an Agent backend before sending.";
  if (backend2.state === "auth-required")
    return backend2.authMode === "api-key" ? "Configure an API key before sending." : "Sign in with ChatGPT, then refresh connection.";
  if (backend2.state === "authenticating")
    return "Complete sign-in, then refresh connection.";
  if (backend2.state !== "ready")
    return "Agent connection is unavailable. Refresh connection to retry.";
  return "No supported model is selected. Refresh connection to load models.";
}
function presentConversationNode(node, now = Date.now()) {
  const metadata = Object.freeze([
    Object.freeze({ label: "Backend", value: node.provenance.backendId }),
    Object.freeze({ label: "Turn", value: node.provenance.turnId }),
    ...node.provenance.stepId ? [Object.freeze({ label: "Step", value: node.provenance.stepId })] : []
  ]);
  const base = { id: node.id, kind: node.kind, status: node.status, provenance: node.provenance, metadata };
  if (!node.knownKind)
    return Object.freeze({ ...base, title: `Unsupported item \xB7 ${node.kind}`, body: stringValue2(node.content.summary, "Payload hidden for safety."), tone: "warning", actions: Object.freeze([]) });
  switch (node.knownKind) {
    case "text": {
      const user = node.content.role === "user";
      return card(base, user ? "\u4F60" : "AI \u8BF4\u660E", stringValue2(node.content.text, ""), user ? "neutral" : node.status === "streaming" ? "progress" : "neutral");
    }
    case "progress":
      return card(base, stringValue2(node.content.label, "Progress"), progressBody(node.content), "progress");
    case "tool-call":
      return card(base, `\u8C03\u7528\u5DE5\u5177 \xB7 ${toolLabel(stringValue2(node.content.toolId, "unknown"))}`, stringValue2(node.content.argumentsSummary, "\u6B63\u5728\u51C6\u5907\u7ED3\u6784\u5316\u53C2\u6570\u3002"), "warning");
    case "tool-result":
      return toolResultCard(base, node);
    case "diagnostic":
      return diagnosticCard(base, node);
    case "completion":
      return completionCard(base, node);
    case "question":
      return questionCard(base, node);
    case "plan":
      return planCard(base, node);
    case "approval":
      return approvalCard(base, node, now);
  }
}
var ChatComposerKeyboardController = class {
  composing = false;
  compositionStart() {
    this.composing = true;
  }
  compositionEnd() {
    this.composing = false;
  }
  handleKeyDown(event) {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || this.composing)
      return "none";
    event.preventDefault();
    return "send";
  }
};
function chatFeedIsNearLatest(position, threshold = 24) {
  return position.scrollHeight - position.clientHeight - position.scrollTop <= threshold;
}
function renderChatPanel(root2, model2, dispatch) {
  executionViewportUpdates.delete(root2);
  currentChatModels.set(root2, model2);
  const document2 = root2.ownerDocument;
  for (const image of [...root2.querySelectorAll?.(".chat-evidence-preview") ?? []])
    image.removeAttribute("src");
  const previousFeed = root2.querySelector?.(".chat-feed");
  const previousInput = root2.querySelector?.(".chat-composer textarea");
  const followLatest = !previousFeed || chatFeedIsNearLatest(previousFeed);
  const preservedScrollTop = previousFeed?.scrollTop ?? 0;
  const preservedDraft = previousInput?.value ?? "";
  const restoreInputFocus = previousInput !== void 0 && previousInput !== null && document2.activeElement === previousInput;
  const preservedSelection = restoreInputFocus ? Object.freeze({ start: previousInput.selectionStart, end: previousInput.selectionEnd, direction: previousInput.selectionDirection ?? void 0 }) : null;
  const fragment = document2.createDocumentFragment();
  const backendControls = document2.createElement("div");
  backendControls.className = "chat-backend-controls";
  const backendSelect = document2.createElement("select");
  backendSelect.setAttribute("aria-label", "Agent backend");
  for (const backend2 of model2.backends) {
    const option = document2.createElement("option");
    option.value = backend2.id;
    option.selected = backend2.id === model2.backendId;
    option.textContent = `${backend2.label} \xB7 ${backend2.state}${backend2.accountPlan ? ` \xB7 ${backend2.accountPlan}` : ""}`;
    backendSelect.append(option);
  }
  backendSelect.addEventListener("change", () => {
    const backend2 = model2.backends.find((item) => item.id === backendSelect.value);
    if (backend2)
      dispatch(Object.freeze({ type: "backend/select", backendId: backend2.id }));
  });
  backendControls.append(backendSelect);
  const selectedBackend = model2.backends.find((item) => item.id === model2.backendId);
  const refresh = document2.createElement("button");
  refresh.type = "button";
  refresh.textContent = "Refresh connection";
  refresh.addEventListener("click", () => dispatch(Object.freeze({ type: "conversation/reconnect" })));
  backendControls.append(refresh);
  if (selectedBackend?.diagnostic) {
    const diagnostic = document2.createElement("p");
    diagnostic.className = "chat-backend-diagnostic";
    diagnostic.setAttribute("role", "status");
    diagnostic.textContent = `${safeText(selectedBackend.diagnostic.code, 96)}: ${safeText(selectedBackend.diagnostic.message, 512)}`;
    backendControls.append(diagnostic);
  }
  if (selectedBackend?.state === "auth-required") {
    const authenticate = document2.createElement("button");
    authenticate.type = "button";
    authenticate.textContent = selectedBackend.authMode === "api-key" ? "Configure API key securely" : "Sign in with ChatGPT";
    authenticate.addEventListener("click", () => dispatch(Object.freeze({ type: "backend/authenticate", backendId: selectedBackend.id })));
    backendControls.append(authenticate);
  } else if (selectedBackend?.state === "ready") {
    const logout = document2.createElement("button");
    logout.type = "button";
    logout.textContent = "Sign out";
    logout.addEventListener("click", () => dispatch(Object.freeze({ type: "backend/logout", backendId: selectedBackend.id })));
    backendControls.append(logout);
  }
  if (selectedBackend?.rateLimits.length) {
    const limits = document2.createElement("span");
    limits.className = "chat-rate-limits";
    limits.textContent = selectedBackend.rateLimits.map((item) => `${item.name}${item.usedPercent === void 0 ? "" : ` ${item.usedPercent}%`}${item.resetsAt ? ` resets ${item.resetsAt}` : ""}`).join(" \xB7 ");
    backendControls.append(limits);
  }
  if (selectedBackend) {
    const capabilities = document2.createElement("details");
    capabilities.className = "chat-backend-capabilities";
    const summary = document2.createElement("summary");
    summary.textContent = `Backend capabilities \xB7 ${selectedBackend.protocolVersion}`;
    const value = document2.createElement("p");
    value.textContent = Object.entries(selectedBackend.capabilities).map(([name, supported]) => `${supported ? "\u2713" : "\u2014"} ${name}`).join(" \xB7 ");
    capabilities.append(summary, value);
    backendControls.append(capabilities);
  }
  if (selectedBackend?.models.length && selectedBackend.selectedModel && selectedBackend.selectedReasoningEffort && selectedBackend.outputTokenLimit) {
    const selectedModelInfo = selectedBackend.models.find((item) => item.id === selectedBackend.selectedModel);
    const settings = document2.createElement("details");
    settings.className = "chat-agent-settings";
    const summary = document2.createElement("summary");
    summary.textContent = "Model, reasoning and task budget";
    settings.append(summary);
    if (selectedBackend.promptProfile) {
      const profile = document2.createElement("p");
      profile.className = "chat-prompt-profile";
      profile.textContent = `Prompt profile ${selectedBackend.promptProfile.id}@${selectedBackend.promptProfile.version} \xB7 ${selectedBackend.promptProfile.digest}`;
      settings.append(profile);
    }
    const modelSelect = document2.createElement("select");
    modelSelect.setAttribute("aria-label", "Agent model");
    for (const item of selectedBackend.models) {
      const option = document2.createElement("option");
      option.value = item.id;
      option.selected = item.id === selectedModelInfo.id;
      option.textContent = item.label;
      modelSelect.append(option);
    }
    const effortSelect = document2.createElement("select");
    effortSelect.setAttribute("aria-label", "Reasoning effort");
    for (const effort of selectedModelInfo.reasoningEfforts) {
      const option = document2.createElement("option");
      option.value = effort;
      option.selected = effort === selectedBackend.selectedReasoningEffort;
      option.textContent = effort;
      effortSelect.append(option);
    }
    const outputLimit = numericInput(document2, "Output token limit", selectedBackend.outputTokenLimit, 1, selectedModelInfo.maxOutputTokens);
    const budget = modelBudget(model2.taskAccounting?.budget);
    const enforcement = document2.createElement("select");
    enforcement.setAttribute("aria-label", "Budget enforcement");
    for (const value of ["observe", "soft", "hard"]) {
      const option = document2.createElement("option");
      option.value = value;
      option.selected = value === budget.enforcement;
      option.textContent = value;
      enforcement.append(option);
    }
    const budgetInputs = Object.fromEntries(Object.entries(budget.limits).map(([key, value]) => [key, numericInput(document2, budgetLabel(key), value ?? 0, key === "repairIterations" ? 0 : 1, 1e9)]));
    const apply = () => {
      const selectedModel = selectedBackend.models.find((item) => item.id === modelSelect.value);
      if (!selectedModel)
        return;
      if (!selectedModel.reasoningEfforts.includes(effortSelect.value)) {
        effortSelect.value = selectedModel.defaultReasoningEffort;
      }
      const limits = Object.freeze(Object.fromEntries(Object.entries(budgetInputs).map(([key, input2]) => [key, Math.max(Number(input2.min), Math.floor(Number(input2.value)))])));
      dispatch(Object.freeze({ type: "agent/configure", backendId: selectedBackend.id, model: selectedModel.id, reasoningEffort: effortSelect.value, outputTokenLimit: Math.min(selectedModel.maxOutputTokens, Math.max(1, Math.floor(Number(outputLimit.value)))), budget: Object.freeze({ schemaVersion: 2, id: budget.id, enforcement: enforcement.value, limits }) }));
    };
    modelSelect.addEventListener("change", () => {
      const next = selectedBackend.models.find((item) => item.id === modelSelect.value);
      if (next) {
        effortSelect.replaceChildren(...next.reasoningEfforts.map((effort) => {
          const option = document2.createElement("option");
          option.value = effort;
          option.textContent = effort;
          option.selected = effort === next.defaultReasoningEffort;
          return option;
        }));
        outputLimit.max = String(next.maxOutputTokens);
        outputLimit.value = String(Math.min(Number(outputLimit.value), next.maxOutputTokens));
      }
      apply();
    });
    for (const input2 of [effortSelect, outputLimit, enforcement, ...Object.values(budgetInputs)])
      input2.addEventListener("change", apply);
    settings.append(labelled(document2, "Model", modelSelect), labelled(document2, "Reasoning", effortSelect), labelled(document2, "Max output", outputLimit), labelled(document2, "Enforcement", enforcement));
    for (const [key, input2] of Object.entries(budgetInputs))
      settings.append(labelled(document2, budgetLabel(key), input2));
    backendControls.append(settings);
  }
  fragment.append(backendControls);
  if (model2.executionGraphs?.length)
    fragment.append(renderExecutionWorkspace(root2, document2, model2.executionGraphs, model2.taskAccounting, dispatch));
  if (model2.taskRuns.length)
    fragment.append(renderTaskWorkspace(document2, model2.taskRuns, model2.taskAccounting, dispatch));
  if (model2.taskAccounting)
    fragment.append(renderTaskCostCard(document2, model2.taskAccounting));
  const status = document2.createElement("p");
  status.className = "chat-connection";
  status.textContent = `Connection: ${model2.connection}`;
  fragment.append(status);
  const feed = document2.createElement("ol");
  feed.className = "chat-feed";
  feed.setAttribute("role", "log");
  feed.setAttribute("aria-live", "polite");
  for (const card2 of model2.cards)
    feed.append(renderCard(document2, card2, dispatch));
  fragment.append(feed);
  const jumpLatest = document2.createElement("button");
  jumpLatest.type = "button";
  jumpLatest.className = "chat-jump-latest";
  jumpLatest.textContent = "\u2193 Latest";
  jumpLatest.setAttribute("aria-label", "Jump to latest agent message");
  fragment.append(jumpLatest);
  const live = document2.createElement("span");
  live.className = "visually-hidden";
  live.setAttribute("aria-live", "polite");
  live.textContent = model2.ariaLive;
  fragment.append(live);
  const composer = document2.createElement("div");
  composer.className = "chat-composer";
  const input = document2.createElement("textarea");
  input.setAttribute("aria-label", "Message the game authoring Agent");
  input.setAttribute("aria-describedby", "chat-composer-status");
  input.value = preservedDraft;
  const send = document2.createElement("button");
  send.type = "button";
  send.textContent = "Send";
  send.disabled = !model2.composer.canSend;
  const sendIntent = () => {
    const prompt = input.value.trim();
    if (!model2.backendId || !model2.composer.canSend || !prompt || new TextEncoder().encode(prompt).byteLength > 16 * 1024)
      return;
    appendOptimisticTurn(document2, feed, prompt);
    input.value = "";
    send.disabled = true;
    feed.scrollTop = feed.scrollHeight;
    dispatch(Object.freeze({ type: "conversation/send", backendId: model2.backendId, prompt }));
  };
  const keyboard2 = new ChatComposerKeyboardController();
  input.addEventListener("compositionstart", () => keyboard2.compositionStart());
  input.addEventListener("compositionend", () => keyboard2.compositionEnd());
  input.addEventListener("keydown", (event) => {
    if (keyboard2.handleKeyDown(event) === "send")
      sendIntent();
  });
  send.addEventListener("click", sendIntent);
  composer.append(input, send);
  if (model2.composer.canCancel) {
    const active = [...model2.cards].reverse().find((item) => item.status === "pending" || item.status === "streaming");
    const cancel = document2.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel turn";
    cancel.disabled = !active || !model2.backendId;
    cancel.addEventListener("click", () => {
      if (active && model2.backendId)
        dispatch(Object.freeze({ type: "conversation/cancel", backendId: model2.backendId, sessionId: active.provenance.sessionId, turnId: active.provenance.turnId }));
    });
    composer.append(cancel);
  }
  if (model2.connection !== "connected") {
    const reconnect = document2.createElement("button");
    reconnect.type = "button";
    reconnect.textContent = "Reconnect";
    reconnect.addEventListener("click", () => dispatch(Object.freeze({ type: "conversation/reconnect" })));
    composer.append(reconnect);
  } else if (!model2.composer.canSend) {
    const retry = document2.createElement("button");
    retry.type = "button";
    retry.textContent = "Refresh connection";
    retry.addEventListener("click", () => dispatch(Object.freeze({ type: "conversation/reconnect" })));
    composer.append(retry);
  }
  const composerStatus = document2.createElement("span");
  composerStatus.id = "chat-composer-status";
  composerStatus.textContent = model2.composer.blockedReason ?? "Ready to send.";
  composer.append(composerStatus);
  fragment.append(composer);
  root2.replaceChildren(fragment);
  executionViewportUpdates.get(root2)?.();
  if (restoreInputFocus) {
    input.focus();
    if (preservedSelection)
      input.setSelectionRange(preservedSelection.start, preservedSelection.end, preservedSelection.direction);
  }
  const syncLatestButton = () => {
    jumpLatest.hidden = chatFeedIsNearLatest(feed);
  };
  if (followLatest)
    feed.scrollTop = feed.scrollHeight;
  else
    feed.scrollTop = Math.min(preservedScrollTop, Math.max(0, feed.scrollHeight - feed.clientHeight));
  feed.addEventListener("scroll", syncLatestButton, { passive: true });
  jumpLatest.addEventListener("click", () => {
    feed.scrollTop = feed.scrollHeight;
    syncLatestButton();
  });
  syncLatestButton();
}
var executionWorkspaceStates = /* @__PURE__ */ new WeakMap();
var executionViewportUpdates = /* @__PURE__ */ new WeakMap();
function renderExecutionWorkspace(root2, document2, graphs, accounting, dispatch) {
  const ordered = [...graphs].sort(compareExecutionGraphs);
  const latest = ordered.at(-1);
  const prior = executionWorkspaceStates.get(root2);
  const state = prior ?? { sessionId: latest.sessionId, followLatest: true, mode: "graph", selectedNodeId: null, query: "", filter: "all", detailMode: "overview", scale: 1, fit: true, scrollLeft: 0, scrollTop: 0, revealSelection: false };
  const selectedGraph = graphs.find((candidate) => candidate.sessionId === state.sessionId);
  if (!selectedGraph)
    state.followLatest = true;
  const graph2 = state.followLatest ? latest : selectedGraph;
  if (state.sessionId !== graph2.sessionId) {
    state.selectedNodeId = null;
    state.query = "";
    state.filter = "all";
    state.fit = true;
    state.scrollLeft = 0;
    state.scrollTop = 0;
  }
  state.sessionId = graph2.sessionId;
  if (state.selectedNodeId && !graph2.nodes.some((node) => node.id === state.selectedNodeId))
    state.selectedNodeId = null;
  executionWorkspaceStates.set(root2, state);
  const workspace = document2.createElement("section");
  workspace.className = "execution-workspace";
  workspace.setAttribute("aria-label", "Agent execution graph and transcript");
  workspace.dataset.sessionId = graph2.sessionId;
  const header = document2.createElement("header");
  header.className = "execution-header";
  const heading = document2.createElement("div");
  const title = document2.createElement("strong");
  title.textContent = graph2.title;
  const status = document2.createElement("span");
  status.className = `execution-status status-${graph2.status}`;
  status.textContent = executionStatusLabel(graph2.status);
  heading.append(title, status);
  const sessionSelect = document2.createElement("select");
  sessionSelect.setAttribute("aria-label", "Agent session");
  for (const [index, candidate] of ordered.entries()) {
    const option = document2.createElement("option");
    option.value = candidate.sessionId;
    option.selected = candidate.sessionId === graph2.sessionId;
    option.textContent = `\u7B2C ${index + 1} \u6BB5 \xB7 ${candidate.nodes.length} \u4E2A\u6B65\u9AA4 \xB7 ${candidate.title} \xB7 ${executionStatusLabel(candidate.status)}`;
    sessionSelect.append(option);
  }
  sessionSelect.addEventListener("change", () => {
    state.sessionId = sessionSelect.value;
    state.followLatest = false;
    state.selectedNodeId = null;
    state.query = "";
    state.filter = "all";
    state.fit = true;
    state.scrollLeft = 0;
    state.scrollTop = 0;
    renderChatPanel(root2, currentChatModel(root2), dispatch);
  });
  const follow = document2.createElement("button");
  follow.type = "button";
  follow.textContent = state.followLatest ? "\u6B63\u5728\u8DDF\u968F\u6700\u65B0" : "\u8DDF\u968F\u6700\u65B0";
  follow.disabled = state.followLatest;
  follow.addEventListener("click", () => {
    state.followLatest = true;
    renderChatPanel(root2, currentChatModel(root2), dispatch);
  });
  header.append(heading, sessionSelect, follow);
  workspace.append(header);
  const summary = document2.createElement("div");
  summary.className = "execution-summary";
  const pressure2 = document2.createElement("div");
  pressure2.className = `execution-pressure pressure-${graph2.context.pressure?.state ?? "unknown"}`;
  const pressureLabel = document2.createElement("span");
  const ratio = graph2.context.pressure?.ratio;
  pressureLabel.textContent = `\u4E0A\u4E0B\u6587 ${ratio === null || ratio === void 0 ? "\u672A\u77E5" : `${Math.round(ratio * 100)}%`} \xB7 ${contextStateLabel(graph2.context.pressure?.state ?? "unknown")}`;
  const meter = document2.createElement("progress");
  meter.max = 100;
  meter.value = ratio === null || ratio === void 0 ? 0 : Math.round(ratio * 100);
  meter.setAttribute("aria-label", pressureLabel.textContent);
  const compact3 = document2.createElement("button");
  compact3.type = "button";
  compact3.textContent = "\u538B\u7F29\u4E0A\u4E0B\u6587";
  compact3.disabled = !graph2.context.compactionAvailable;
  compact3.title = graph2.context.compactionBlockedReason ?? (graph2.context.pressure ? "\u5728\u4E0B\u4E00\u4E2A\u5B89\u5168\u8FB9\u754C\u538B\u7F29\u6A21\u578B\u53EF\u89C1\u4E0A\u4E0B\u6587\uFF1B\u5B8C\u6574\u8BB0\u5F55\u4E0D\u4F1A\u5220\u9664\u3002" : "\u5F53\u524D\u6A21\u578B\u5C1A\u672A\u63D0\u4F9B\u53EF\u9A8C\u8BC1\u7684\u4E0A\u4E0B\u6587\u5BB9\u91CF\u3002");
  compact3.addEventListener("click", () => {
    if (compact3.disabled)
      return;
    compact3.disabled = true;
    dispatch(Object.freeze({ type: "conversation/request-compaction", sessionId: graph2.sessionId, requestId: `compaction-request:${graph2.sessionId}:${graph2.revision}` }));
  });
  pressure2.append(pressureLabel, meter, compact3);
  const totals = document2.createElement("p");
  totals.className = "execution-totals";
  totals.textContent = executionAccountingLabel(graph2, accounting);
  summary.append(pressure2, totals);
  workspace.append(summary);
  const controls = document2.createElement("div");
  controls.className = "execution-controls";
  const graphTab = tabButton(document2, "\u62D3\u6251\u56FE", state.mode === "graph", () => {
    state.mode = "graph";
    renderChatPanel(root2, currentChatModel(root2), dispatch);
  });
  const transcriptTab2 = tabButton(document2, `\u5B8C\u6574\u8BB0\u5F55 ${graph2.transcript.length}`, state.mode === "transcript", () => {
    state.mode = "transcript";
    renderChatPanel(root2, currentChatModel(root2), dispatch);
  });
  const search = document2.createElement("input");
  search.type = "search";
  search.placeholder = "\u641C\u7D22\u6B65\u9AA4\u3001\u5DE5\u5177\u3001\u5B9E\u4F53\u6216\u9519\u8BEF";
  search.setAttribute("aria-label", "Search execution graph");
  search.value = state.query;
  search.addEventListener("change", () => {
    state.query = search.value;
    state.fit = true;
    renderChatPanel(root2, currentChatModel(root2), dispatch);
  });
  const filter = document2.createElement("select");
  filter.setAttribute("aria-label", "Filter execution graph");
  for (const [value, label] of [["all", "\u5168\u90E8"], ["current", "\u5F53\u524D"], ["waiting", "\u7B49\u5F85"], ["failed", "\u5931\u8D25"], ["changes", "\u4FEE\u6539"], ["validation", "\u9A8C\u8BC1"], ["compaction", "\u538B\u7F29"], ["approval", "\u5BA1\u6279"], ["cost-unknown", "\u6210\u672C\u672A\u77E5"]]) {
    const option = document2.createElement("option");
    option.value = value;
    option.textContent = label;
    option.selected = state.filter === value;
    filter.append(option);
  }
  filter.addEventListener("change", () => {
    state.filter = filter.value;
    state.fit = true;
    renderChatPanel(root2, currentChatModel(root2), dispatch);
  });
  controls.append(graphTab, transcriptTab2, search, filter);
  workspace.append(controls);
  if (state.mode === "transcript")
    workspace.append(renderExecutionTranscript(root2, document2, graph2, state, dispatch));
  else
    workspace.append(renderExecutionGraph(root2, document2, graph2, state, dispatch));
  return workspace;
}
var currentChatModels = /* @__PURE__ */ new WeakMap();
function currentChatModel(root2) {
  const value = currentChatModels.get(root2);
  if (!value)
    throw new Error("Chat panel model is unavailable.");
  return value;
}
function renderExecutionGraph(root2, document2, graph2, state, dispatch) {
  const region = document2.createElement("div");
  region.className = "execution-graph-region";
  const toolbar = document2.createElement("div");
  toolbar.className = "execution-graph-toolbar";
  const detail = document2.createElement("button");
  detail.type = "button";
  detail.textContent = state.detailMode === "overview" ? "\u5C55\u5F00\u5168\u90E8" : "\u6298\u53E0\u5DF2\u5B8C\u6210\u8BFB\u53D6";
  detail.addEventListener("click", () => {
    state.detailMode = state.detailMode === "overview" ? "expanded" : "overview";
    state.fit = true;
    renderChatPanel(root2, currentChatModel(root2), dispatch);
  });
  const zoomOut = document2.createElement("button");
  zoomOut.type = "button";
  zoomOut.textContent = "\u2212";
  zoomOut.setAttribute("aria-label", "Zoom out execution graph");
  zoomOut.addEventListener("click", () => {
    state.fit = false;
    state.scale = Math.max(0.01, state.scale / 1.25);
    renderChatPanel(root2, currentChatModel(root2), dispatch);
  });
  const zoomIn = document2.createElement("button");
  zoomIn.type = "button";
  zoomIn.textContent = "+";
  zoomIn.setAttribute("aria-label", "Zoom in execution graph");
  zoomIn.addEventListener("click", () => {
    state.fit = false;
    state.scale = Math.min(1.8, state.scale * 1.25);
    renderChatPanel(root2, currentChatModel(root2), dispatch);
  });
  const fit = document2.createElement("button");
  fit.type = "button";
  fit.textContent = "\u9002\u5E94\u89C6\u56FE";
  fit.addEventListener("click", () => {
    state.fit = true;
    state.scrollLeft = 0;
    state.scrollTop = 0;
    renderChatPanel(root2, currentChatModel(root2), dispatch);
  });
  toolbar.append(detail, zoomOut, zoomIn, fit);
  region.append(toolbar);
  const options = graphFilterOptions(state);
  const layout = layoutExecutionGraph(graph2, { mode: state.detailMode, query: state.query, ...options });
  const count = document2.createElement("span");
  count.className = "execution-node-count";
  count.textContent = `\u663E\u793A ${layout.visibleNodeIds.length}/${graph2.nodes.length} \u4E2A\u6B65\u9AA4`;
  toolbar.append(count);
  const visible = new Set(layout.visibleNodeIds);
  const nodes = new Map(graph2.nodes.map((node) => [node.id, node]));
  const positions = new Map(layout.nodes.map((node) => [node.id, node]));
  const viewport2 = document2.createElement("div");
  viewport2.className = "execution-graph-viewport";
  viewport2.tabIndex = 0;
  viewport2.setAttribute("aria-label", `${layout.visibleNodeIds.length} visible execution nodes. Use Tab or arrow keys to navigate.`);
  const stage = document2.createElement("div");
  stage.className = "execution-graph-stage";
  const canvas = document2.createElement("div");
  canvas.className = "execution-graph-canvas";
  canvas.style.width = `${layout.width}px`;
  canvas.style.height = `${layout.height}px`;
  const svg = document2.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "execution-edges");
  svg.setAttribute("width", String(layout.width));
  svg.setAttribute("height", String(layout.height));
  svg.setAttribute("aria-hidden", "true");
  for (const edge of graph2.edges) {
    if (!visible.has(edge.from) || !visible.has(edge.to))
      continue;
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    const line = document2.createElementNS("http://www.w3.org/2000/svg", "path");
    const x1 = from.x + from.width;
    const y1 = from.y + from.height / 2;
    const x2 = to.x;
    const y2 = to.y + to.height / 2;
    const middle = (x1 + x2) / 2;
    line.setAttribute("d", `M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2} ${y2}`);
    line.setAttribute("class", `edge-${edge.kind}`);
    svg.append(line);
  }
  canvas.append(svg);
  for (const position of layout.nodes) {
    const node = nodes.get(position.id);
    const button2 = document2.createElement("button");
    button2.type = "button";
    button2.id = executionDomId(node.id);
    button2.className = `execution-node kind-${node.kind} status-${node.status}${graph2.criticalPathNodeIds.includes(node.id) ? " is-critical" : ""}${state.selectedNodeId === node.id ? " is-selected" : ""}`;
    button2.style.left = `${position.x}px`;
    button2.style.top = `${position.y}px`;
    button2.style.width = `${position.width}px`;
    button2.style.height = `${position.height}px`;
    button2.dataset.nodeId = node.id;
    button2.dataset.layer = String(position.layer);
    button2.dataset.order = String(position.order);
    button2.tabIndex = state.selectedNodeId === node.id || !state.selectedNodeId && node.id === (graph2.currentNodeIds[0] ?? layout.visibleNodeIds[0]) ? 0 : -1;
    button2.setAttribute("aria-label", `${node.title}. ${executionStatusLabel(node.status)}. ${node.summary}`);
    const kind = document2.createElement("span");
    kind.className = "execution-node-kind";
    kind.textContent = executionKindLabel(node.kind);
    const label = document2.createElement("strong");
    label.textContent = node.title;
    const summary = document2.createElement("span");
    summary.className = "execution-node-summary";
    summary.textContent = node.summary;
    button2.append(kind, label, summary);
    button2.addEventListener("click", () => {
      state.selectedNodeId = node.id;
      renderChatPanel(root2, currentChatModel(root2), dispatch);
    });
    button2.addEventListener("keydown", (event) => navigateGraphNode(event, root2, graph2, layout.nodes, node.id, state, dispatch));
    canvas.append(button2);
  }
  stage.append(canvas);
  viewport2.append(stage);
  region.append(viewport2);
  viewport2.addEventListener("scroll", () => {
    state.scrollLeft = viewport2.scrollLeft;
    state.scrollTop = viewport2.scrollTop;
  }, { passive: true });
  executionViewportUpdates.set(root2, () => {
    if (!(viewport2.clientWidth > 0 && viewport2.clientHeight > 0))
      return;
    if (state.fit)
      state.scale = Math.min(1, Math.max(1, viewport2.clientWidth - 8) / layout.width, Math.max(1, viewport2.clientHeight - 8) / layout.height);
    stage.style.width = `${layout.width * state.scale}px`;
    stage.style.height = `${layout.height * state.scale}px`;
    canvas.style.transform = `scale(${state.scale})`;
    const selectedPosition = state.revealSelection && state.selectedNodeId ? positions.get(state.selectedNodeId) : null;
    if (selectedPosition) {
      state.scrollLeft = (selectedPosition.x + selectedPosition.width / 2) * state.scale - viewport2.clientWidth / 2;
      state.scrollTop = (selectedPosition.y + selectedPosition.height / 2) * state.scale - viewport2.clientHeight / 2;
    }
    viewport2.scrollLeft = state.fit ? 0 : state.scrollLeft;
    viewport2.scrollTop = state.fit ? 0 : state.scrollTop;
    state.revealSelection = false;
  });
  const selected2 = graph2.nodes.find((node) => node.id === state.selectedNodeId) ?? graph2.nodes.find((node) => graph2.currentNodeIds.includes(node.id)) ?? graph2.nodes.at(-1);
  if (selected2)
    region.append(renderExecutionNodeDetail(root2, document2, graph2, selected2, state, dispatch));
  region.append(renderAccessibleGraphList(root2, document2, graph2, state, dispatch));
  return region;
}
function renderExecutionTranscript(root2, document2, graph2, state, dispatch) {
  const region = document2.createElement("section");
  region.className = "execution-transcript";
  region.setAttribute("aria-label", "Complete human transcript");
  const list = document2.createElement("ol");
  const query = state.query.trim().toLocaleLowerCase();
  for (const item of graph2.transcript) {
    if (query && !`${item.title}
${item.body}`.toLocaleLowerCase().includes(query))
      continue;
    const row = document2.createElement("li");
    row.className = `transcript-item transcript-${item.kind} status-${item.status}`;
    row.id = `transcript-${executionDomId(item.id)}`;
    const header = document2.createElement("div");
    const title = document2.createElement("strong");
    title.textContent = item.title;
    const time = document2.createElement("time");
    time.dateTime = item.timestamp;
    time.textContent = new Date(item.timestamp).toLocaleTimeString();
    header.append(title, time);
    const body = document2.createElement("p");
    body.textContent = item.body;
    row.append(header, body);
    if (item.graphNodeIds.length) {
      const locate2 = document2.createElement("button");
      locate2.type = "button";
      locate2.textContent = "\u5728\u62D3\u6251\u4E2D\u5B9A\u4F4D";
      locate2.addEventListener("click", () => {
        selectExecutionNode(state, item.graphNodeIds[0]);
        renderChatPanel(root2, currentChatModel(root2), dispatch);
      });
      row.append(locate2);
    }
    list.append(row);
  }
  region.append(list);
  return region;
}
function renderExecutionNodeDetail(root2, document2, graph2, node, state, dispatch) {
  const aside = document2.createElement("aside");
  aside.className = "execution-node-detail";
  aside.setAttribute("aria-label", `Execution detail: ${node.title}`);
  const heading = document2.createElement("h3");
  heading.textContent = node.title;
  const summary = document2.createElement("p");
  summary.textContent = node.summary;
  aside.append(heading, summary);
  const facts = document2.createElement("dl");
  for (const [label, value] of [["\u72B6\u6001", executionStatusLabel(node.status)], ["\u7C7B\u578B", executionKindLabel(node.kind)], ["\u8017\u65F6", node.durationMs === null ? "unknown" : `${node.durationMs} ms`], ["\u9879\u76EE\u4FEE\u8BA2", node.projectRevisionBefore === null && node.projectRevisionAfter === null ? "unknown" : `r${node.projectRevisionBefore ?? "?"} \u2192 r${node.projectRevisionAfter ?? "?"}`], ["\u5DE5\u5177", node.detail.toolId ? `${node.detail.toolId}${node.detail.toolVersion ? `@${node.detail.toolVersion}` : ""}` : "none"], ["\u6267\u884C\u7C7B\u522B", node.detail.executionClass ?? "unknown"], ["\u4E8B\u52A1", node.detail.transactionId ?? "none"], ["\u8BCA\u65AD", node.detail.diagnostic ?? "none"]]) {
    const term = document2.createElement("dt");
    term.textContent = label;
    const description = document2.createElement("dd");
    description.textContent = value;
    facts.append(term, description);
  }
  aside.append(facts);
  if (node.artifactRefs.length) {
    const artifacts = document2.createElement("details");
    const label = document2.createElement("summary");
    label.textContent = `\u8BC1\u636E\u4E0E\u4EA7\u7269 ${node.artifactRefs.length}`;
    const list = document2.createElement("ul");
    for (const id of node.artifactRefs) {
      const item = document2.createElement("li");
      const code = document2.createElement("code");
      code.textContent = id;
      item.append(code);
      list.append(item);
    }
    artifacts.append(label, list);
    aside.append(artifacts);
  }
  if (node.detail.usageRecordIds.length || node.detail.costRecordIds.length) {
    const accounting = document2.createElement("p");
    accounting.className = "execution-node-accounting";
    accounting.textContent = `Usage ${node.detail.usageRecordIds.join(", ") || "unknown"} \xB7 Cost ${node.detail.costRecordIds.join(", ") || "unknown"}`;
    aside.append(accounting);
  }
  const transcriptItems = graph2.transcript.filter((item) => item.graphNodeIds.includes(node.id));
  if (transcriptItems.length) {
    const locate2 = document2.createElement("button");
    locate2.type = "button";
    locate2.textContent = "\u67E5\u770B\u5BF9\u5E94\u8BB0\u5F55";
    locate2.addEventListener("click", () => {
      state.mode = "transcript";
      renderChatPanel(root2, currentChatModel(root2), dispatch);
    });
    aside.append(locate2);
  }
  return aside;
}
function renderAccessibleGraphList(root2, document2, graph2, state, dispatch) {
  const details = document2.createElement("details");
  details.className = "execution-accessible-list";
  const summary = document2.createElement("summary");
  summary.textContent = "\u4F7F\u7528\u5C42\u7EA7\u5217\u8868\u6D4F\u89C8\u5168\u90E8\u6267\u884C\u6B65\u9AA4";
  const list = document2.createElement("ol");
  for (const node of graph2.nodes) {
    const item = document2.createElement("li");
    const button2 = document2.createElement("button");
    button2.type = "button";
    button2.textContent = `${executionKindLabel(node.kind)} \xB7 ${node.title} \xB7 ${executionStatusLabel(node.status)}`;
    button2.addEventListener("click", () => {
      selectExecutionNode(state, node.id);
      renderChatPanel(root2, currentChatModel(root2), dispatch);
    });
    item.append(button2);
    list.append(item);
  }
  details.append(summary, list);
  return details;
}
function navigateGraphNode(event, root2, graph2, layout, nodeId, state, dispatch) {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home"].includes(event.key))
    return;
  event.preventDefault();
  const current = layout.find((node) => node.id === nodeId);
  if (!current)
    return;
  let candidate = event.key === "Home" ? layout.find((node) => graph2.currentNodeIds.includes(node.id)) ?? layout[0] : void 0;
  if (!candidate && (event.key === "ArrowUp" || event.key === "ArrowDown"))
    candidate = layout.filter((node) => node.layer === current.layer).sort((left, right) => Math.abs(left.order - (current.order + (event.key === "ArrowUp" ? -1 : 1))) - Math.abs(right.order - (current.order + (event.key === "ArrowUp" ? -1 : 1))))[0];
  if (!candidate) {
    const targetLayer = current.layer + (event.key === "ArrowLeft" ? -1 : 1);
    candidate = layout.filter((node) => node.layer === targetLayer).sort((left, right) => Math.abs(left.order - current.order) - Math.abs(right.order - current.order))[0];
  }
  if (candidate) {
    selectExecutionNode(state, candidate.id);
    renderChatPanel(root2, currentChatModel(root2), dispatch);
    root2.querySelector(`#${executionDomId(candidate.id)}`)?.focus({ preventScroll: true });
  }
}
function selectExecutionNode(state, id) {
  state.selectedNodeId = id;
  state.mode = "graph";
  state.query = "";
  state.filter = "all";
  state.detailMode = "expanded";
  state.fit = false;
  state.scale = Math.max(0.75, state.scale);
  state.revealSelection = true;
}
function graphFilterOptions(state) {
  if (state.filter === "current")
    return { statuses: ["running", "waiting", "outcome-unknown"] };
  if (state.filter === "waiting")
    return { statuses: ["waiting", "outcome-unknown"] };
  if (state.filter === "failed")
    return { statuses: ["failed"] };
  if (state.filter === "changes")
    return { kinds: ["transaction", "tool"] };
  if (state.filter === "validation")
    return { kinds: ["evidence", "evaluation"] };
  if (state.filter === "compaction")
    return { kinds: ["compaction"] };
  if (state.filter === "approval")
    return { kinds: ["approval", "question", "plan"] };
  if (state.filter === "cost-unknown")
    return { costUnknown: true };
  return {};
}
function tabButton(document2, label, selected2, action) {
  const button2 = document2.createElement("button");
  button2.type = "button";
  button2.textContent = label;
  button2.setAttribute("role", "tab");
  button2.setAttribute("aria-selected", String(selected2));
  button2.className = selected2 ? "is-selected" : "";
  button2.addEventListener("click", action);
  return button2;
}
function executionDomId(id) {
  return `execution-${id.replace(/[^a-zA-Z0-9_-]/gu, "-")}`;
}
function executionStatusLabel(value) {
  return { pending: "\u5F85\u5904\u7406", running: "\u6267\u884C\u4E2D", waiting: "\u7B49\u5F85\u7528\u6237", completed: "\u5DF2\u5B8C\u6210", failed: "\u5931\u8D25", cancelled: "\u5DF2\u53D6\u6D88", "outcome-unknown": "\u7ED3\u679C\u5F85\u6838\u9A8C" }[value];
}
function executionKindLabel(value) {
  return { goal: "\u76EE\u6807", plan: "\u65B9\u6848", turn: "\u56DE\u5408", "tool-batch": "\u5DE5\u5177\u6279\u6B21", tool: "\u5DE5\u5177", transaction: "\u4FEE\u6539", approval: "\u5BA1\u6279", question: "\u95EE\u9898", compaction: "\u4E0A\u4E0B\u6587\u538B\u7F29", evidence: "\u8BC1\u636E", evaluation: "\u9A8C\u8BC1", repair: "\u4FEE\u590D", result: "\u7ED3\u679C", unknown: "\u672A\u77E5\u6B65\u9AA4" }[value];
}
function contextStateLabel(value) {
  return { normal: "\u6B63\u5E38", warning: "\u63A5\u8FD1\u4E0A\u9650", preparing: "\u51C6\u5907\u538B\u7F29", "compact-required": "\u9700\u8981\u538B\u7F29", emergency: "\u7D27\u6025", unknown: "\u5BB9\u91CF\u672A\u77E5" }[value] ?? value;
}
function executionAccountingLabel(graph2, accounting) {
  const usageRefs = new Set(graph2.nodes.flatMap((node) => node.detail.usageRecordIds));
  const costRefs = new Set(graph2.nodes.flatMap((node) => node.detail.costRecordIds));
  if (!accounting)
    return `Usage ${usageRefs.size || "unknown"} records \xB7 Cost ${costRefs.size || "unknown"} records`;
  const cost = accounting.cost.amountMicros === null || !accounting.cost.currency ? `unknown (${accounting.cost.explanation})` : `${(accounting.cost.amountMicros / 1e6).toFixed(6)} ${accounting.cost.currency}`;
  return `Input ${accounting.usage.inputTokens ?? "unknown"} \xB7 Cached ${accounting.usage.cachedInputTokens ?? "unknown"} \xB7 Output ${accounting.usage.outputTokens ?? "unknown"} \xB7 Cost ${cost}`;
}
function renderTaskWorkspace(document2, runs, accounting, dispatch) {
  const workspace = document2.createElement("section");
  workspace.className = "chat-task-workspace";
  workspace.setAttribute("aria-label", "Agent task status and acceptance evidence");
  const heading = document2.createElement("div");
  heading.className = "chat-task-heading";
  const title = document2.createElement("strong");
  title.textContent = "\u4EFB\u52A1\u72B6\u6001\u4E0E\u9A8C\u6536\u8BC1\u636E";
  const selector = document2.createElement("select");
  selector.setAttribute("aria-label", "Task history");
  const panels = [];
  const ordered = [...runs].reverse();
  for (const [index, run] of ordered.entries()) {
    const option = document2.createElement("option");
    option.value = run.taskId;
    option.selected = index === 0;
    option.textContent = `${run.title} \xB7 ${run.status}`;
    selector.append(option);
    const panel2 = renderTaskRun(document2, run, accounting?.taskId === run.taskId ? accounting : null, dispatch);
    panel2.hidden = index !== 0;
    panels.push(panel2);
  }
  selector.addEventListener("change", () => {
    for (const panel2 of panels)
      panel2.hidden = panel2.dataset.taskId !== selector.value;
  });
  heading.append(title, selector);
  workspace.append(heading, ...panels);
  return workspace;
}
function renderTaskRun(document2, run, accounting, dispatch) {
  const panel2 = document2.createElement("article");
  panel2.className = `chat-task-run task-status-${run.status}`;
  panel2.dataset.taskId = run.taskId;
  const summary = document2.createElement("div");
  summary.className = "chat-task-summary";
  const status = document2.createElement("strong");
  status.textContent = `${taskStatusLabel(run.status)} \xB7 ${taskPhaseLabel(run.phase)}`;
  const repair = document2.createElement("span");
  repair.textContent = `\u4FEE\u590D ${run.repairIteration}/${run.repairLimit}`;
  summary.append(status, repair);
  const request = document2.createElement("p");
  request.textContent = run.requestSummary;
  const config = document2.createElement("p");
  config.className = "chat-task-config";
  config.textContent = `Model ${run.model.id} \xB7 reasoning ${run.model.reasoningEffort} \xB7 max output ${run.model.outputTokenLimit} \xB7 prompt ${run.promptProfile.id}@${run.promptProfile.version} \xB7 r${run.documentRevision ?? "unknown"}`;
  panel2.append(summary, request, config);
  if (run.terminalDiagnostic) {
    const diagnostic = document2.createElement("p");
    diagnostic.className = "chat-task-diagnostic";
    diagnostic.textContent = `\u539F\u56E0\uFF1A${run.terminalDiagnostic}`;
    panel2.append(diagnostic);
  }
  if (run.resumable && run.sessionId && run.turnId) {
    const resume = document2.createElement("button");
    resume.type = "button";
    resume.textContent = "\u4ECE\u5B89\u5168\u68C0\u67E5\u70B9\u7EE7\u7EED";
    resume.addEventListener("click", () => {
      resume.disabled = true;
      dispatch(Object.freeze({ type: "conversation/retry", backendId: run.backendId, sessionId: run.sessionId, turnId: run.turnId }));
    });
    panel2.append(resume);
  }
  panel2.append(renderPhaseRail(document2, run));
  const acceptance = document2.createElement("details");
  acceptance.className = "chat-task-acceptance";
  acceptance.open = run.status === "completed" || run.status === "blocked" || run.status === "failed";
  const acceptanceSummary = document2.createElement("summary");
  const passed = run.acceptance.filter((item) => item.status === "pass").length;
  acceptanceSummary.textContent = run.acceptance.length ? `\u9A8C\u6536\u6807\u51C6 ${passed}/${run.acceptance.length} \u901A\u8FC7` : "\u9A8C\u6536\u6807\u51C6\u5C1A\u672A\u63D0\u4EA4";
  acceptance.append(acceptanceSummary);
  if (run.acceptance.length) {
    const list = document2.createElement("ul");
    for (const item of run.acceptance) {
      const row = document2.createElement("li");
      row.className = `acceptance-${item.status}`;
      const label = document2.createElement("strong");
      label.textContent = `${acceptanceMark(item.status)} ${item.label}`;
      const meta = document2.createElement("span");
      meta.textContent = `${item.category} \xB7 ${item.required ? "\u5FC5\u9700" : "\u53EF\u9009"} \xB7 ${item.visibility === "runner-only" ? "\u4EC5\u9A8C\u6536\u5668\u53EF\u89C1" : "Agent \u53EF\u89C1"}`;
      const assertion = document2.createElement("code");
      assertion.textContent = item.assertion;
      row.append(label, meta, assertion);
      if (item.diagnostic) {
        const diagnostic = document2.createElement("small");
        diagnostic.textContent = item.diagnostic;
        row.append(diagnostic);
      }
      if (item.evidenceIds.length) {
        const refs = document2.createElement("small");
        refs.textContent = `Evidence: ${item.evidenceIds.join(", ")}`;
        row.append(refs);
      }
      list.append(row);
    }
    acceptance.append(list);
  }
  panel2.append(acceptance);
  const evidence = document2.createElement("details");
  evidence.className = "chat-task-evidence";
  evidence.open = run.status === "completed";
  const evidenceSummary = document2.createElement("summary");
  evidenceSummary.textContent = `\u8BC1\u636E ${run.evidence.length}`;
  evidence.append(evidenceSummary);
  const evidenceGrid = document2.createElement("div");
  evidenceGrid.className = "chat-evidence-grid";
  for (const item of run.evidence) {
    const card2 = document2.createElement("article");
    card2.className = `chat-evidence-card evidence-${item.provenanceStatus}`;
    const label = document2.createElement("strong");
    label.textContent = `${item.type} \xB7 ${item.provenanceStatus}`;
    const coordinates = document2.createElement("small");
    coordinates.textContent = `${item.playId} \xB7 tick ${item.tick} / frame ${item.frame} \xB7 r${item.documentRevision} \xB7 ${item.device ?? "device unknown"} \xB7 ${item.viewport ? `${item.viewport.width}\xD7${item.viewport.height}` : "viewport unknown"}`;
    const id = document2.createElement("code");
    id.textContent = item.id;
    card2.append(label, coordinates, id);
    if (item.previewDataUrl) {
      const image = document2.createElement("img");
      image.className = "chat-evidence-preview";
      image.alt = `Screenshot evidence at tick ${item.tick}`;
      image.loading = "lazy";
      image.src = item.previewDataUrl;
      card2.append(image);
    }
    evidenceGrid.append(card2);
  }
  evidence.append(evidenceGrid);
  panel2.append(evidence);
  const timeline = document2.createElement("details");
  timeline.className = "chat-task-timeline";
  const timelineSummary = document2.createElement("summary");
  timelineSummary.textContent = `\u4EFB\u52A1\u65F6\u95F4\u7EBF ${run.timeline.length}`;
  timeline.append(timelineSummary);
  const visible = run.timeline.slice(-100);
  if (visible.length < run.timeline.length) {
    const omitted = document2.createElement("p");
    omitted.textContent = `\u8F83\u65E9\u7684 ${run.timeline.length - visible.length} \u9879\u5DF2\u6298\u53E0\uFF0C\u907F\u514D\u957F\u4EFB\u52A1\u5360\u7528\u8FC7\u591A\u754C\u9762\u8D44\u6E90\u3002`;
    timeline.append(omitted);
  }
  const timelineList = document2.createElement("ol");
  for (const item of visible) {
    const row = document2.createElement("li");
    row.className = `timeline-${item.status}`;
    const label = document2.createElement("strong");
    label.textContent = item.title;
    const detail = document2.createElement("span");
    detail.textContent = `${item.phase} \xB7 ${item.detail}${item.turnId ? ` \xB7 ${item.turnId}` : ""}${item.toolCallId ? ` \xB7 ${item.toolCallId}` : ""}${item.playId ? ` \xB7 ${item.playId}` : ""}${item.tick === null ? "" : ` \xB7 tick ${item.tick}`}`;
    row.append(label, detail);
    timelineList.append(row);
  }
  timeline.append(timelineList);
  panel2.append(timeline);
  if (accounting) {
    const budget = document2.createElement("p");
    budget.className = "chat-task-inline-accounting";
    budget.textContent = `Budget ${accounting.budgetStatus} \xB7 wall ${(accounting.usage.wallTimeMs / 1e3).toFixed(1)}s \xB7 cost ${accounting.cost.amountMicros === null || !accounting.cost.currency ? `unknown (${accounting.cost.explanation})` : `${(accounting.cost.amountMicros / 1e6).toFixed(6)} ${accounting.cost.currency}`}`;
    panel2.append(budget);
  }
  return panel2;
}
function renderPhaseRail(document2, run) {
  const rail = document2.createElement("ol");
  rail.className = "chat-task-phase-rail";
  rail.setAttribute("aria-label", `Current task phase: ${run.phase}`);
  const phases = ["planning", "editing", "validating", "playing", "evaluating", "repairing", "complete", "blocked", "cancelled"];
  const active = phases.indexOf(run.phase);
  for (const [index, phase] of phases.entries()) {
    const item = document2.createElement("li");
    item.textContent = taskPhaseLabel(phase);
    item.className = phase === run.phase ? "is-current" : active >= 0 && index < active ? "is-complete" : "";
    if (phase === run.phase)
      item.setAttribute("aria-current", "step");
    rail.append(item);
  }
  return rail;
}
function taskStatusLabel(value) {
  return { running: "\u6267\u884C\u4E2D", "waiting-user": "\u7B49\u5F85\u7528\u6237", blocked: "\u5DF2\u963B\u585E", completed: "\u5DF2\u5B8C\u6210", failed: "\u5931\u8D25", cancelled: "\u5DF2\u53D6\u6D88" }[value];
}
function taskPhaseLabel(value) {
  return { planning: "\u89C4\u5212", editing: "\u7F16\u8F91", validating: "\u6821\u9A8C", playing: "\u8FD0\u884C", evaluating: "\u9A8C\u6536", repairing: "\u4FEE\u590D", complete: "\u5B8C\u6210", blocked: "\u963B\u585E", cancelled: "\u53D6\u6D88" }[value];
}
function acceptanceMark(value) {
  return { pending: "\u25CB", pass: "\u2713", fail: "\u2715", blocked: "!" }[value];
}
function numericInput(document2, ariaLabel, value, minimum, maximum) {
  const input = document2.createElement("input");
  input.type = "number";
  input.setAttribute("aria-label", ariaLabel);
  input.min = String(minimum);
  input.max = String(maximum);
  input.step = "1";
  input.value = String(value);
  return input;
}
function labelled(document2, text2, control) {
  const label = document2.createElement("label");
  const span = document2.createElement("span");
  span.textContent = text2;
  label.append(span, control);
  return label;
}
function budgetLabel(key) {
  return { inputTokens: "Net-new input tokens", outputTokens: "Output tokens", estimatedCostMicros: "Cost limit (\xB5 currency)", wallTimeMs: "Wall time (ms)", turns: "Turns", toolCalls: "Tool calls", repairIterations: "Repair loops", observationBytes: "Observation bytes" }[key] ?? key;
}
function modelBudget(value) {
  return value ?? Object.freeze({ schemaVersion: 2, id: "budget:conversation-default", enforcement: "hard", limits: Object.freeze({ inputTokens: 2e5, outputTokens: 5e4, estimatedCostMicros: 2e6, wallTimeMs: 6e5, turns: 12, toolCalls: 100, repairIterations: 5, observationBytes: 5e6 }) });
}
function renderTaskCostCard(document2, value) {
  const card2 = document2.createElement("section");
  card2.className = `chat-task-cost chat-task-cost-${value.budgetStatus}`;
  card2.setAttribute("aria-label", "Task usage and cost");
  const title = document2.createElement("strong");
  title.textContent = value.cost.final ? "Task cost \xB7 final" : "Task cost \xB7 current estimate";
  const cost = document2.createElement("p");
  cost.textContent = value.cost.amountMicros === null || !value.cost.currency ? `Cost unknown \u2014 ${value.cost.explanation}` : `${value.cost.status}: ${(value.cost.amountMicros / 1e6).toFixed(6)} ${value.cost.currency}`;
  const usage = document2.createElement("p");
  usage.textContent = `Input ${value.usage.inputTokens ?? "unknown"} \xB7 cached ${value.usage.cachedInputTokens ?? "unknown"} \xB7 output ${value.usage.outputTokens ?? "unknown"} \xB7 reasoning ${value.usage.reasoningTokens ?? "unknown"} \xB7 tools ${value.usage.toolInputBytes + value.usage.toolOutputBytes} B`;
  const contextCache = value.usage.contextCache ? document2.createElement("p") : null;
  if (contextCache && value.usage.contextCache)
    contextCache.textContent = `Context cache: local ${value.usage.contextCache.localArtifactHits} hit / ${value.usage.contextCache.localArtifactMisses} miss \xB7 delta reused ${value.usage.contextCache.deltaReuseBytes} B \xB7 provider eligible ${value.usage.contextCache.providerCacheEligibleBytes} B \xB7 provider hit ${value.usage.contextCache.providerReportedHitTokens ?? "unknown"}`;
  const budget = document2.createElement("p");
  budget.textContent = `Budget: ${value.budgetStatus} (${value.budget.enforcement})${value.cost.cacheSavingMicros === null ? "" : ` \xB7 cache saved \u2248 ${(value.cost.cacheSavingMicros / 1e6).toFixed(6)} ${value.cost.currency}`}`;
  card2.append(title, cost, usage);
  if (contextCache)
    card2.append(contextCache);
  card2.append(budget);
  return card2;
}
function renderCard(document2, card2, dispatch) {
  const item = document2.createElement("li");
  item.className = `chat-card tone-${card2.tone}`;
  item.dataset.kind = card2.kind;
  item.dataset.status = card2.status;
  const content = createChatCardSurface(document2, item, card2.status === "pending" || card2.status === "streaming");
  const title = document2.createElement("h3");
  title.textContent = card2.title;
  content.append(title);
  const body = document2.createElement("p");
  body.textContent = card2.body;
  content.append(body);
  if (card2.details) {
    const details = document2.createElement("details");
    details.className = "chat-tool-details";
    const summary = document2.createElement("summary");
    summary.textContent = card2.details.summary;
    const detailBody = document2.createElement("pre");
    detailBody.textContent = card2.details.body;
    details.append(summary, detailBody);
    content.append(details);
  }
  if (card2.approval) {
    const disclosure = document2.createElement("dl");
    for (const [label, value] of [["Tool", `${card2.approval.toolId}@${card2.approval.toolVersion}`], ["Target", card2.approval.target], ["Effect", card2.approval.effect], ["Risk", card2.approval.risk], ["Base revision", String(card2.approval.baseRevision)], ["Scope", card2.approval.scope], ["Expiry", card2.approval.expiresAt ?? "No wall-clock expiry; exact revision and digests still apply"], ["Arguments", card2.approval.argumentsSummary], ["Preview", card2.approval.previewDiff]]) {
      const term = document2.createElement("dt");
      term.textContent = label;
      const detail = document2.createElement("dd");
      detail.textContent = value;
      disclosure.append(term, detail);
    }
    content.append(disclosure);
  }
  if (card2.planItems) {
    const list = document2.createElement("ul");
    list.className = "chat-plan-items";
    const selections = [];
    for (const plan of card2.planItems) {
      const row = document2.createElement("li");
      const label = document2.createElement("label");
      const checkbox = document2.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = plan.id;
      checkbox.checked = plan.status !== "rejected";
      checkbox.disabled = card2.status !== "pending";
      selections.push(checkbox);
      const title2 = document2.createElement("strong");
      title2.textContent = plan.label;
      label.append(checkbox, title2);
      row.append(label);
      if (plan.details) {
        const details = document2.createElement("p");
        details.textContent = plan.details;
        row.append(details);
      }
      list.append(row);
    }
    if (card2.status === "pending") {
      const review = document2.createElement("div");
      review.className = "chat-plan-review";
      const note = document2.createElement("textarea");
      note.placeholder = "\u53EF\u9009\uFF1A\u8865\u5145\u7EA6\u675F\u3001\u4FEE\u6539\u610F\u89C1\u6216\u5B9E\u73B0\u504F\u597D";
      note.setAttribute("aria-label", "Plan feedback");
      const approve = document2.createElement("button");
      approve.type = "button";
      approve.textContent = "\u6279\u51C6\u5E76\u6267\u884C";
      approve.addEventListener("click", () => {
        const acceptedItemIds = selections.filter((item2) => item2.checked).map((item2) => item2.value);
        if (!acceptedItemIds.length)
          return;
        approve.disabled = true;
        revise.disabled = true;
        dispatch(Object.freeze({ type: "conversation/accept-plan", nodeId: card2.id, acceptedItemIds: Object.freeze(acceptedItemIds), mode: "approve", ...note.value.trim() ? { note: note.value.trim() } : {} }));
      });
      const revise = document2.createElement("button");
      revise.type = "button";
      revise.textContent = "\u8865\u5145\u540E\u91CD\u65B0\u89C4\u5212";
      revise.addEventListener("click", () => {
        const feedback = note.value.trim();
        if (!feedback) {
          note.focus();
          return;
        }
        approve.disabled = true;
        revise.disabled = true;
        dispatch(Object.freeze({ type: "conversation/accept-plan", nodeId: card2.id, acceptedItemIds: Object.freeze([]), mode: "revise", note: feedback }));
      });
      review.append(note, approve, revise);
      content.append(review);
    }
    content.append(list);
  }
  const actions = document2.createElement("div");
  actions.className = "chat-card-actions";
  for (const action of card2.actions) {
    const button2 = document2.createElement("button");
    button2.type = "button";
    button2.textContent = action.label;
    button2.disabled = !action.enabled || !action.intent;
    button2.addEventListener("click", () => {
      if (action.enabled && action.intent && !button2.disabled) {
        button2.disabled = true;
        dispatch(action.intent);
      }
    });
    actions.append(button2);
  }
  if (card2.actions.length)
    content.append(actions);
  return item;
}
function createChatCardSurface(document2, item, waiting) {
  const content = document2.createElement("div");
  content.className = "chat-card-content";
  if (!waiting) {
    item.append(content);
    return content;
  }
  const beam = document2.createElement("hy-border-beam");
  beam.className = "chat-wait-beam";
  beam.setAttribute("thickness", "1.5");
  beam.setAttribute("speed", "1.35");
  beam.setAttribute("count", "2");
  beam.append(content);
  item.append(beam);
  return content;
}
function appendOptimisticTurn(document2, feed, prompt) {
  const append = (kind, title, body, waiting) => {
    const item = document2.createElement("li");
    item.className = `chat-card tone-${waiting ? "progress" : "neutral"} optimistic-card`;
    item.dataset.kind = kind === "user" ? "text" : "progress";
    item.dataset.status = waiting ? "pending" : "completed";
    const content = createChatCardSurface(document2, item, waiting);
    const heading = document2.createElement("h3");
    heading.textContent = title;
    const message = document2.createElement("p");
    message.textContent = body;
    content.append(heading, message);
    feed.append(item);
  };
  append("user", "\u4F60", prompt, false);
  append("progress", "\u6B63\u5728\u5206\u6790\u9700\u6C42", "Agent \u6B63\u5728\u8BFB\u53D6\u9879\u76EE\u4E0A\u4E0B\u6587\u5E76\u89C4\u5212\u4E0B\u4E00\u6B65\u3002", true);
}
function questionCard(base, node) {
  const question = questionFromNode(node);
  const actions = [];
  if (question)
    for (const option of question.options)
      actions.push(Object.freeze({
        id: `answer:${option.id}`,
        label: option.label,
        enabled: node.status === "pending",
        intent: Object.freeze({ type: "conversation/answer-question", nodeId: node.id, answer: Object.freeze({ optionIds: Object.freeze([option.id]) }) })
      }));
  return Object.freeze({ ...base, title: "Question", body: question?.prompt ?? "Invalid question payload.", tone: "warning", actions: Object.freeze(actions), ...question ? { question } : {} });
}
function planCard(base, node) {
  const items = planFromNode(node);
  const fallback = `${items.length} \u4E2A\u5B9E\u65BD\u6B65\u9AA4\u3002\u786E\u8BA4\u540E\u5C06\u81EA\u52A8\u6267\u884C\u4F4E\u98CE\u9669\u7F16\u8F91\uFF1B\u5371\u9669\u80FD\u529B\u4ECD\u4F1A\u5355\u72EC\u8BF7\u6C42\u6388\u6743\u3002`;
  const title = stringValue2(node.content.title, "\u603B\u4F53\u5B9E\u73B0\u65B9\u6848");
  return Object.freeze({ ...base, title: node.status === "pending" ? `\u5F85\u6279\u51C6 \xB7 ${title}` : title, body: stringValue2(node.content.summary, fallback), tone: node.status === "pending" ? "warning" : "neutral", actions: Object.freeze([]), planItems: items });
}
function approvalCard(base, node, now) {
  const approval = approvalFromNode(node);
  const expired = Boolean(approval?.expiresAt && Date.parse(approval.expiresAt) <= now);
  const enabled = Boolean(approval && node.status === "pending" && approval.decision === "pending" && !expired);
  const actions = approval ? [
    Object.freeze({ id: "approval-allow", label: "Allow once", enabled, intent: Object.freeze({ type: "conversation/resolve-approval", approvalId: approval.approvalId, decision: "allow-once" }) }),
    ...approval.effect === "reversible-edit" ? [Object.freeze({ id: "approval-allow-always", label: "Allow always", enabled, intent: Object.freeze({ type: "conversation/resolve-approval", approvalId: approval.approvalId, decision: "allow-always" }) })] : [],
    Object.freeze({ id: "approval-reject", label: "Reject", enabled, intent: Object.freeze({ type: "conversation/resolve-approval", approvalId: approval.approvalId, decision: "reject" }) })
  ] : [];
  const body = approval ? `${approval.effect} on ${approval.target}; decision: ${expired && approval.decision === "pending" ? "expired" : approval.decision}. ${approval.expiresAt ? `Expires at ${approval.expiresAt}.` : "No wall-clock expiry; exact revision, arguments and preview still invalidate it."} Scope: ${approval.scope}.${approval.effect === "reversible-edit" ? " Allow always is limited to this tool/version and target for the current project session." : " Trusted code and runtime start require exact one-shot approval."}` : "Invalid approval payload; actions are disabled.";
  return Object.freeze({ ...base, title: "Approval required", body, tone: "danger", actions: Object.freeze(actions), ...approval ? { approval } : {} });
}
function diagnosticCard(base, node) {
  const retryable = node.content.retryable === true;
  const actions = retryable ? [Object.freeze({ id: "retry", label: "Retry turn", enabled: true, intent: Object.freeze({ type: "conversation/retry", backendId: node.provenance.backendId, sessionId: node.provenance.sessionId, turnId: node.provenance.turnId }) })] : [];
  return Object.freeze({ ...base, title: `Diagnostic \xB7 ${stringValue2(node.content.code, "unknown")}`, body: stringValue2(node.content.message, "No safe diagnostic message."), tone: node.content.severity === "error" ? "danger" : "warning", actions: Object.freeze(actions) });
}
function completionCard(base, node) {
  const terminal = stringValue2(node.content.terminalStatus, node.status);
  const retry = terminal === "failed" || terminal === "cancelled" || terminal === "interrupted";
  const actions = retry ? [Object.freeze({ id: "retry", label: "Retry turn", enabled: true, intent: Object.freeze({ type: "conversation/retry", backendId: node.provenance.backendId, sessionId: node.provenance.sessionId, turnId: node.provenance.turnId }) })] : [];
  return Object.freeze({ ...base, title: `Turn ${terminal}`, body: stringValue2(node.content.summary, "Turn finished."), tone: terminal === "completed" ? "success" : "danger", actions: Object.freeze(actions) });
}
function toolResultCard(base, node) {
  const toolId = stringValue2(node.content.toolId, "unknown");
  const status = node.status === "failed" ? "\u5931\u8D25" : node.status === "cancelled" ? "\u5DF2\u53D6\u6D88" : "\u5B8C\u6210";
  const result2 = card(base, `${status} \xB7 ${toolLabel(toolId)}`, stringValue2(node.content.summary, "\u5DE5\u5177\u8C03\u7528\u5DF2\u5B8C\u6210\u3002"), node.status === "failed" ? "danger" : "success");
  const details = stringValue2(node.content.details, "");
  return details ? Object.freeze({ ...result2, details: Object.freeze({ summary: "\u67E5\u770B\u5DE5\u5177\u8FD4\u56DE\u6570\u636E", body: details }) }) : result2;
}
function toolLabel(toolId) {
  return {
    "project.snapshot": "\u8BFB\u53D6\u9879\u76EE",
    "scene.list-entities": "\u8BFB\u53D6\u573A\u666F",
    "entity.get": "\u8BFB\u53D6\u7269\u4F53",
    "script.get": "\u8BFB\u53D6\u811A\u672C",
    "diagnostics.query": "\u8BFB\u53D6\u8BCA\u65AD",
    "entity.create": "\u521B\u5EFA\u7269\u4F53",
    "entity.rename": "\u91CD\u547D\u540D\u7269\u4F53",
    "transform.set": "\u7F16\u8F91 Transform",
    "material.set": "\u8BBE\u7F6E\u6750\u8D28",
    "studio.plan.propose": "\u63D0\u4EA4\u5B9E\u73B0\u65B9\u6848",
    "script.propose": "\u6821\u9A8C\u811A\u672C\u63D0\u6848",
    "script.apply": "\u63D0\u4EA4\u811A\u672C",
    "preview.validate": "\u6821\u9A8C\u8FD0\u884C\u8BA1\u5212",
    "preview.start": "\u542F\u52A8\u9884\u89C8",
    "preview.stop": "\u505C\u6B62\u9884\u89C8"
  }[toolId] ?? toolId;
}
function card(base, title, body, tone) {
  return Object.freeze({ ...base, title: safeText(title, 240), body: safeText(body), tone, actions: Object.freeze([]) });
}
function stringValue2(value, fallback) {
  return typeof value === "string" ? safeText(value) : fallback;
}
function progressBody(content) {
  const message = stringValue2(content.message, "Working\u2026");
  return typeof content.current === "number" && typeof content.total === "number" ? `${message} ${content.current}/${content.total}` : message;
}

// packages/studio-shell/dist/panels/logs/index.js
var defaultFilters = Object.freeze({ severity: Object.freeze([]), kinds: Object.freeze([]), traverseCorrelation: false, pageSize: 50 });

// packages/studio-shell/dist/index.js
var STUDIO_PANEL_IDS = Object.freeze({
  hierarchy: asStableId("studio.panel.hierarchy"),
  viewport: asStableId("studio.panel.viewport"),
  inspector: asStableId("studio.panel.inspector"),
  assets: asStableId("studio.panel.assets"),
  script: asStableId("studio.panel.script"),
  chat: asStableId("studio.panel.chat"),
  logs: asStableId("studio.panel.logs")
});
var studioWorkspaceLayoutToken = createStudioServiceToken("studio.workspace-layout");
var studioPanelContributionKind = asStableId("studio.contribution.panel");
var DEFAULT_STUDIO_PANELS = Object.freeze([
  panel(STUDIO_PANEL_IDS.hierarchy, "Hierarchy", "left", 10),
  panel(STUDIO_PANEL_IDS.inspector, "Inspector", "left", 20),
  panel(STUDIO_PANEL_IDS.viewport, "Viewport", "center", 10),
  panel(STUDIO_PANEL_IDS.assets, "Assets", "bottom", 10),
  panel(STUDIO_PANEL_IDS.script, "Script", "bottom", 20),
  panel(STUDIO_PANEL_IDS.chat, "Chat", "right", 10, false),
  panel(STUDIO_PANEL_IDS.logs, "Logs", "right", 20, false)
]);
function panel(id, title, region, order, placeholder = true) {
  return Object.freeze({ id, editorKind: "panel", title, region, order, placeholder });
}

// packages/studio-shell/dist/g09-execution-graph-app.ts
window.addEventListener("error", (event) => {
  document.body.dataset.g09Status = "failed";
  document.body.dataset.g09Error = event.error?.stack ?? event.message;
});
var backendId = "backend:g09-ui";
var sessionId = "session:g09-ui";
var turnId = "turn:g09-ui";
var pressure = { maxInputTokens: 1e5, reservedOutputTokens: 1e4, reservedSafetyTokens: 1e4, usedInputTokens: 64e3, ratio: 0.8, measurement: "tokenizer-estimated", state: "compact-required" };
var afterPressure = { ...pressure, usedInputTokens: 48e3, ratio: 0.6, state: "normal" };
var compaction = { id: "compaction:g09-ui", reason: "manual", coveredStartSequence: 1, coveredEndSequence: 4, before: pressure, after: afterPressure, sourceSurfaceGeneration: 0, targetSurfaceGeneration: 1, summaryArtifactId: "artifact:summary", pinnedFactDigests: [], validation: "passed", diagnostic: null };
var makeOp = (sequence2, kind, options = {}) => ({ schemaVersion: 1, id: "op:" + sequence2, sessionId, sequence: sequence2, kind, timestamp: new Date(Date.UTC(2026, 8, 2, 0, 0, sequence2)).toISOString(), turnId: options.turnId === void 0 ? turnId : options.turnId, stepId: null, batchId: options.batchId ?? null, nodeId: options.nodeId ?? null, parentOpId: options.parentOpId ?? null, dependsOn: options.dependsOn ?? [], projectRevision: options.projectRevision ?? null, artifactRefs: options.artifactRefs ?? [], payload: options.payload ?? {}, payloadDigest: "sha256:" + String(sequence2).padStart(64, "0") });
var ops = [
  makeOp(0, "session.created", { turnId: null, payload: { activeGoal: "\u521B\u5EFA\u5E76\u9A8C\u8BC1\u4E00\u4E2A\u8DE8\u7C7B\u578B\u6E38\u620F\u4EA4\u4E92" } }),
  makeOp(1, "turn.started", { payload: { title: "\u5B9E\u73B0\u6E38\u620F\u4EA4\u4E92" } }),
  makeOp(2, "user.message", { artifactRefs: ["artifact:user"] }),
  makeOp(3, "tool-batch.planned", { batchId: "batch:1" }),
  makeOp(4, "tool-batch.started", { batchId: "batch:1" }),
  makeOp(5, "tool-batch.planned", { batchId: "batch:1", nodeId: "node:scene", payload: { toolId: "scene.diff", executionClass: "parallel-read" } }),
  makeOp(6, "tool.started", { batchId: "batch:1", nodeId: "node:scene", payload: { toolId: "scene.diff" } }),
  makeOp(7, "tool-batch.planned", { batchId: "batch:1", nodeId: "node:diagnostics", payload: { toolId: "diagnostics.query", executionClass: "parallel-read" } }),
  makeOp(8, "tool.started", { batchId: "batch:1", nodeId: "node:diagnostics", payload: { toolId: "diagnostics.query" } }),
  makeOp(9, "tool.completed", { batchId: "batch:1", nodeId: "node:scene", payload: { toolId: "scene.diff", status: "completed" } }),
  makeOp(10, "tool.completed", { batchId: "batch:1", nodeId: "node:diagnostics", payload: { toolId: "diagnostics.query", status: "completed" } }),
  makeOp(11, "document.committed", { projectRevision: 9, artifactRefs: ["receipt:9"], payload: { transactionId: "transaction:9", beforeRevision: 8, afterRevision: 9, memberNodeIds: ["node:scene"] } }),
  makeOp(12, "approval.requested", { nodeId: "approval:run", payload: { approvalId: "approval:run", barrierKind: "runtime-start", reason: "\u8FD0\u884C\u9694\u79BB\u9884\u89C8" } }),
  makeOp(13, "approval.resolved", { nodeId: "approval:run", payload: { approvalId: "approval:run", resolution: "allow-once" } }),
  makeOp(14, "evidence.captured", { nodeId: "evidence:screenshot", projectRevision: 9, artifactRefs: ["artifact:screenshot"], payload: { evidenceType: "screenshot", transactionId: "transaction:9", summary: "\u8FD0\u884C\u753B\u9762\u5DF2\u91C7\u96C6", pressure } }),
  makeOp(15, "evaluation.completed", { nodeId: "evaluation:1", projectRevision: 9, artifactRefs: ["artifact:evaluator"], payload: { status: "passed", transactionId: "transaction:9", summary: "\u4EA4\u4E92\u9A8C\u6536\u901A\u8FC7" } }),
  makeOp(16, "compaction.completed", { nodeId: "compaction:g09-ui", artifactRefs: ["artifact:summary"], payload: { phase: "completed", compaction } }),
  makeOp(17, "tool-batch.completed", { batchId: "batch:1", payload: { status: "completed" } }),
  makeOp(18, "assistant.message", { artifactRefs: ["artifact:assistant"] }),
  makeOp(19, "turn.completed", { payload: { status: "completed", summary: "\u6E38\u620F\u4EA4\u4E92\u5DF2\u5B8C\u6210\u5E76\u9A8C\u8BC1" } })
];
var transcript = [{ id: "transcript:user", opId: "op:2", role: "user", content: "\u521B\u5EFA\u4E00\u4E2A\u53EF\u8FD0\u884C\u5E76\u7ECF\u8FC7\u9A8C\u8BC1\u7684\u6E38\u620F\u3002", timestamp: ops[2].timestamp }, { id: "transcript:assistant", opId: "op:18", role: "assistant", content: "\u5B9E\u73B0\u3001\u8FD0\u884C\u548C\u9A8C\u8BC1\u5DF2\u7ECF\u5B8C\u6210\u3002", timestamp: ops[18].timestamp }];
var graph = projectExecutionGraph({ sessionId, activeGoal: "\u521B\u5EFA\u5E76\u9A8C\u8BC1\u4E00\u4E2A\u8DE8\u7C7B\u578B\u6E38\u620F\u4EA4\u4E92", status: "completed", ops, transcript });
var backend = { id: backendId, label: "Fixture", kind: "harness-api-key", state: "ready", authMode: "api-key", protocolVersion: "fixture", capabilities: { resume: true, questions: true, structuredTools: true, backendApprovals: false, usage: true, rateLimits: true }, promptProfile: null, rateLimits: [], models: [{ id: "fixture-model", label: "Fixture", reasoningEfforts: ["high"], defaultReasoningEffort: "high", maxOutputTokens: 8192, isDefault: true }], selectedModel: "fixture-model", selectedReasoningEffort: "high", outputTokenLimit: 4096 };
var snapshot = { revision: 1, connection: "connected", busy: false, backendId, backends: [backend], taskAccounting: { taskId: "task:g09-ui", budgetStatus: "within", budget: { schemaVersion: 2, id: "budget:g09-ui", enforcement: "hard", limits: { inputTokens: 1e5, outputTokens: 1e4, estimatedCostMicros: 1e6, wallTimeMs: 6e5, turns: 30, toolCalls: 100, repairIterations: 4, observationBytes: 1e6 } }, usage: { inputTokens: 12e3, cachedInputTokens: 4e3, outputTokens: 1200, reasoningTokens: 600, toolInputBytes: 1e3, toolOutputBytes: 2e3, wallTimeMs: 8e3, contextCache: { localArtifactHits: 5, localArtifactMisses: 1, deltaReuseBytes: 4096, providerCacheEligibleBytes: 8192, providerReportedHitTokens: null } }, cost: { status: "unknown", amountMicros: null, currency: null, cacheSavingMicros: null, explanation: "Provider subscription did not expose billable cost.", final: true } }, taskRuns: [], executionGraphs: [graph], events: [] };
var root = document.querySelector("#root");
var intents = [];
var projector = new ConversationProjector();
var model = presentChatPanel(projector.reset(snapshot));
var renderStarted = performance.now();
renderChatPanel(root, model, (intent) => intents.push(intent));
var renderMs = performance.now() - renderStarted;
var graphVisible = !!root.querySelector('[aria-label="Agent execution graph and transcript"]') && root.querySelectorAll(".execution-node").length > 3 && root.querySelectorAll(".execution-edges path").length > 0;
var firstNode = root.querySelector(".execution-node");
firstNode?.focus();
firstNode?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
var keyboard = document.activeElement?.classList.contains("execution-node") === true;
var compact2 = [...root.querySelectorAll("button")].find((button2) => button2.textContent === "\u538B\u7F29\u4E0A\u4E0B\u6587");
compact2?.click();
compact2?.click();
var idempotent = intents.filter((intent) => intent.type === "conversation/request-compaction").length === 1;
var transcriptTab = [...root.querySelectorAll('[role="tab"]')].find((button2) => button2.textContent.startsWith("\u5B8C\u6574\u8BB0\u5F55"));
transcriptTab?.click();
var transcriptVisible = !!root.querySelector(".execution-transcript") && root.textContent.includes("\u5B9E\u73B0\u3001\u8FD0\u884C\u548C\u9A8C\u8BC1\u5DF2\u7ECF\u5B8C\u6210");
var locate = [...root.querySelectorAll("button")].find((button2) => button2.textContent === "\u5728\u62D3\u6251\u4E2D\u5B9A\u4F4D");
locate?.click();
var accessible = !!root.querySelector(".execution-accessible-list") && root.textContent.includes("\u4F7F\u7528\u5C42\u7EA7\u5217\u8868\u6D4F\u89C8\u5168\u90E8\u6267\u884C\u6B65\u9AA4");
var largeOps = [makeOp(0, "session.created", { turnId: null }), makeOp(1, "turn.started"), makeOp(2, "tool-batch.planned", { batchId: "batch:large" }), makeOp(3, "tool-batch.started", { batchId: "batch:large" })];
var sequence = 4;
for (let i = 0; i < 1e3; i++) {
  const nodeId = "node:large:" + i;
  largeOps.push(makeOp(sequence++, "tool-batch.planned", { batchId: "batch:large", nodeId, payload: { toolId: "scene.query", executionClass: "parallel-read" } }), makeOp(sequence++, "tool.started", { batchId: "batch:large", nodeId, payload: { toolId: "scene.query" } }), makeOp(sequence++, "tool.completed", { batchId: "batch:large", nodeId, payload: { toolId: "scene.query", status: "completed" } }));
}
largeOps.push(makeOp(sequence++, "tool-batch.completed", { batchId: "batch:large", payload: { status: "completed" } }), makeOp(sequence++, "turn.completed", { payload: { status: "completed" } }));
var projectionStarted = performance.now();
var largeGraph = projectExecutionGraph({ sessionId, ops: largeOps });
var projectionMs = performance.now() - projectionStarted;
var layoutStarted = performance.now();
var largeLayout = layoutExecutionGraph(largeGraph);
var layoutMs = performance.now() - layoutStarted;
var makeLater = (id, count, day) => projectExecutionGraph({ sessionId: id, activeGoal: "\u9636\u6BB5 " + day, ops: ops.slice(0, count).map((op) => ({ ...op, sessionId: id, id: id + ":" + op.id, timestamp: op.timestamp.replace("2026-09-02", day) })) });
var shortGraph = makeLater("session:short", 3, "2026-09-03");
var nextGraph = makeLater("session:next", 20, "2026-09-04");
var show = (graphs) => renderChatPanel(root, presentChatPanel(projector.reset({ ...snapshot, executionGraphs: graphs })), (intent) => intents.push(intent));
var button = (label) => [...root.querySelectorAll("button")].find((item) => item.textContent === label);
var activeSession = () => root.querySelector(".execution-workspace")?.dataset.sessionId;
show([graph, shortGraph]);
var followsNewShortSession = activeSession() === shortGraph.sessionId;
var history = root.querySelector('[aria-label="Agent session"]');
history.value = graph.sessionId;
history.dispatchEvent(new Event("change"));
show([graph, shortGraph, nextGraph]);
var preservesHistorySelection = activeSession() === graph.sessionId;
button("\u8DDF\u968F\u6700\u65B0").click();
var followsLatest = activeSession() === nextGraph.sessionId;
var fits = () => {
  const viewport2 = root.querySelector(".execution-graph-viewport"), region = root.querySelector(".execution-graph-region"), bounds = viewport2.getBoundingClientRect(), regionBounds = region.getBoundingClientRect();
  return viewport2.clientWidth > 100 && viewport2.clientHeight > 100 && bounds.bottom <= regionBounds.bottom + 1 && [...root.querySelectorAll(".execution-node")].every((node) => {
    const rect = node.getBoundingClientRect();
    return rect.left >= bounds.left && rect.top >= bounds.top && rect.right <= bounds.right + 1 && rect.bottom <= bounds.bottom + 1;
  });
};
button("\u5C55\u5F00\u5168\u90E8")?.click();
button("\u9002\u5E94\u89C6\u56FE").click();
var fitsWholeGraph = fits() && !!root.querySelector(".edge-contains");
for (let index = 0; index < 9; index++) root.querySelector('[aria-label="Zoom in execution graph"]').click();
var viewport = root.querySelector(".execution-graph-viewport");
viewport.scrollTop = 120;
viewport.scrollLeft = 100;
viewport.dispatchEvent(new Event("scroll"));
var scroll = { left: viewport.scrollLeft, top: viewport.scrollTop };
show([graph, shortGraph, nextGraph]);
viewport = root.querySelector(".execution-graph-viewport");
var preservesScroll = scroll.top > 0 && viewport.scrollTop === scroll.top && viewport.scrollLeft === scroll.left;
var lastStep = [...root.querySelectorAll(".execution-accessible-list button")].at(-1);
lastStep.click();
var selected = root.querySelector(".execution-node.is-selected");
var selectedBounds = selected.getBoundingClientRect();
var viewBounds = root.querySelector(".execution-graph-viewport").getBoundingClientRect();
var locatesOffscreenStep = selectedBounds.left >= viewBounds.left && selectedBounds.top >= viewBounds.top && selectedBounds.right <= viewBounds.right && selectedBounds.bottom <= viewBounds.bottom;
button("\u9002\u5E94\u89C6\u56FE").click();
window.runNarrowGraphCheck = () => {
  show([graph, shortGraph, nextGraph]);
  button("\u9002\u5E94\u89C6\u56FE").click();
  return fits();
};
var result = { graph: graphVisible, transcript: transcriptVisible, keyboard, idempotent, accessible, followsNewShortSession, preservesHistorySelection, followsLatest, fitsWholeGraph, preservesScroll, locatesOffscreenStep, digest: /^sha256:[a-f0-9]{64}$/.test(graph.digest), parallel: graph.edges.some((edge) => edge.kind === "parallel-with"), large: largeGraph.nodes.filter((node) => node.kind === "tool").length === 1e3 && largeLayout.visibleNodeIds.length < 100, renderBudget: renderMs < 1500, projectionBudget: projectionMs < 1500, layoutBudget: layoutMs < 100, renderMs, projectionMs, layoutMs };
document.body.dataset.g09Result = JSON.stringify(result);
document.body.dataset.g09Status = Object.entries(result).filter(([key]) => !key.endsWith("Ms")).every(([, value]) => value === true) ? "passed" : "failed";
if (document.body.dataset.g09Status === "failed") document.body.dataset.g09Error = JSON.stringify(result);
