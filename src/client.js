const crypto = require("node:crypto");

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_ATTEMPTS = 3;
const MAX_RESPONSE_BYTES = 16 * 1024;
const ASSIGNMENT_RETRY_BUDGET_MS = 15_000;
const ASSIGNMENT_MIN_DELAY_MS = 250;
const ASSIGNMENT_MAX_DELAY_MS = 5_000;

class StickyDiskError extends Error {}
class StickyDiskDegradedError extends StickyDiskError {}
class StickyDiskAmbiguousMountError extends StickyDiskError {}
class StickyDiskSafeFallbackError extends StickyDiskError {}

const EXPLICIT_FALLBACK_CODES = new Set(["allocation_disabled", "key_disabled", "quota_exceeded", "storage_disabled"]);
const MOUNT_SOURCES = new Set(["hit", "miss", "readonly", "fallback"]);

function configuration(environment = process.env) {
  const url = environment.TENKI_STICKYDISK_URL;
  const token = environment.TENKI_STICKYDISK_TOKEN;
  if (!url || !token) throw new StickyDiskError("Sticky disk capability is unavailable on this runner");

  let endpoint;
  try {
    endpoint = new URL(url);
  } catch {
    throw new StickyDiskError("Sticky disk endpoint is invalid");
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new StickyDiskError("Sticky disk endpoint must be a plain HTTPS URL");
  }
  return { endpoint: endpoint.toString().replace(/\/$/, ""), token };
}

function retryable(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function delay(attempt, sleep, random = Math.random) {
  const jitter = Math.floor(random() * 100);
  return sleep(150 * 2 ** attempt + jitter);
}

function assignmentDelay(response, remainingBudget, random = Math.random, now = Date.now) {
  const retryAfter = response.headers.get("retry-after") || "";
  const seconds = Number(retryAfter);
  const retryAfterDate = Date.parse(retryAfter);
  const requestedDelay = Number.isFinite(seconds)
    ? seconds * 1_000
    : Number.isFinite(retryAfterDate)
      ? Math.max(0, retryAfterDate - now())
      : ASSIGNMENT_MIN_DELAY_MS;
  const boundedDelay = Math.min(ASSIGNMENT_MAX_DELAY_MS, Math.max(ASSIGNMENT_MIN_DELAY_MS, requestedDelay));
  const delayedWithJitter = Math.min(ASSIGNMENT_MAX_DELAY_MS, boundedDelay + Math.floor(random() * 100));
  return delayedWithJitter <= remainingBudget ? delayedWithJitter : null;
}

function validResponse(route, payload) {
  if (!payload || typeof payload !== "object") return false;
  if (route !== "/v1/stickydisk/mount") return true;
  if (typeof payload.mounted !== "boolean" || !MOUNT_SOURCES.has(payload.source)) return false;
  if (payload.source === "fallback") return payload.mounted === false;
  return !payload.mounted || (typeof payload.allocation_id === "string" && payload.allocation_id.length > 0);
}

async function request(route, body, options = {}) {
  const context = requestContext(route, body, options);
  let ambiguousMount = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let outcome;
    try {
      outcome = await responseOutcome(context, attempt, ambiguousMount);
    } catch (error) {
      outcome = exceptionOutcome(error, context.route, attempt, ambiguousMount);
    }
    ambiguousMount ||= outcome.ambiguousMount;
    if (outcome.type === "success") return outcome.payload;
    if (outcome.type === "terminal") throw outcome.error;
    if (outcome.type === "assignment") {
      const assignmentRetryDelay = assignmentDelay(
        outcome.response,
        context.assignmentDeadline - context.now(),
        context.random,
        context.now,
      );
      if (assignmentRetryDelay === null) throw assignmentError(ambiguousMount);
      await context.sleep(assignmentRetryDelay);
      attempt -= 1;
    } else {
      await delay(attempt, context.sleep, context.random);
    }
  }
  throw new StickyDiskError("Sticky disk request failed");
}

function requestContext(route, body, options) {
  const environment = options.environment || process.env;
  const { endpoint, token } = configuration(environment);
  const encodedBody = JSON.stringify(body);
  const now = options.now || Date.now;
  return {
    assignmentDeadline: now() + ASSIGNMENT_RETRY_BUDGET_MS,
    encodedBody,
    endpoint,
    fetchImpl: options.fetchImpl || fetch,
    idempotencyKey: crypto
      .createHash("sha256")
      .update(token + "\u0000" + route + "\u0000" + encodedBody)
      .digest("hex"),
    now,
    random: options.random || Math.random,
    route,
    sleep: options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    token,
  };
}

async function responseOutcome(context, attempt, ambiguousMount) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await sendRequest(context, controller.signal);
    const payload = await responseBody(response);
    if (response.ok) return successfulResponseOutcome(context.route, payload, attempt);
    return failedResponseOutcome(context.route, response, payload, attempt, ambiguousMount);
  } finally {
    clearTimeout(timeout);
  }
}

async function sendRequest(context, signal) {
  return context.fetchImpl(context.endpoint + context.route, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + context.token,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Idempotency-Key": context.idempotencyKey,
    },
    body: context.encodedBody,
    redirect: "error",
    signal,
  });
}

function successfulResponseOutcome(route, payload, attempt) {
  if (validResponse(route, payload)) return { type: "success", payload, ambiguousMount: false };
  if (route === "/v1/stickydisk/mount")
    return retryOrTerminal(attempt, true, new StickyDiskAmbiguousMountError("Sticky disk mount outcome is unknown"));
  return retryOrTerminal(attempt, false, new StickyDiskError("Sticky disk response is invalid"));
}

function failedResponseOutcome(route, response, payload, attempt, ambiguousMount) {
  const classified = classifiedResponseError(payload, ambiguousMount);
  if (classified) return { type: "terminal", error: classified, ambiguousMount };
  const uncertain =
    ambiguousMount || (route === "/v1/stickydisk/mount" && (response.status === 409 || response.status >= 500));
  if (response.status === 425) return { type: "assignment", response, ambiguousMount: uncertain };
  const error = responseError(response.status, uncertain);
  return retryable(response.status)
    ? retryOrTerminal(attempt, uncertain, error)
    : { type: "terminal", error, ambiguousMount: uncertain };
}

function classifiedResponseError(payload, ambiguousMount) {
  if (payload?.code === "storage_degraded") return new StickyDiskDegradedError("Sticky disk storage is degraded");
  if (!EXPLICIT_FALLBACK_CODES.has(payload?.code)) return null;
  return ambiguousMount
    ? new StickyDiskAmbiguousMountError("Sticky disk mount outcome is unknown")
    : new StickyDiskSafeFallbackError("Sticky disk allocation is unavailable");
}

function exceptionOutcome(error, route, attempt, ambiguousMount) {
  if (
    error instanceof StickyDiskDegradedError ||
    error instanceof StickyDiskAmbiguousMountError ||
    error instanceof StickyDiskSafeFallbackError
  ) {
    return { type: "terminal", error, ambiguousMount };
  }
  const uncertain = ambiguousMount || route === "/v1/stickydisk/mount";
  const terminalError = uncertain
    ? new StickyDiskAmbiguousMountError("Sticky disk mount outcome is unknown")
    : error instanceof StickyDiskError
      ? error
      : new StickyDiskError("Sticky disk request failed");
  return retryOrTerminal(attempt, uncertain, terminalError);
}

function retryOrTerminal(attempt, ambiguousMount, error) {
  return attempt === MAX_ATTEMPTS - 1 ? { type: "terminal", error, ambiguousMount } : { type: "retry", ambiguousMount };
}

function responseError(status, ambiguousMount) {
  return ambiguousMount
    ? new StickyDiskAmbiguousMountError("Sticky disk mount outcome is unknown")
    : new StickyDiskError("Sticky disk service returned " + status);
}

function assignmentError(ambiguousMount) {
  return ambiguousMount
    ? new StickyDiskAmbiguousMountError("Sticky disk mount outcome is unknown")
    : new StickyDiskSafeFallbackError("Sticky disk assignment did not become ready");
}

async function responseBody(response) {
  const declaredLength = Number(response.headers.get("content-length") || "0");
  if (declaredLength > MAX_RESPONSE_BYTES) throw new StickyDiskError("Sticky disk response is too large");
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new StickyDiskError("Sticky disk response is too large");
    }
    chunks.push(value);
  }
  try {
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

async function mount(requestBody, options) {
  return request("/v1/stickydisk/mount", requestBody, options);
}

async function finalize(requestBody, options) {
  return request("/v1/stickydisk/finalize", requestBody, options);
}

module.exports = {
  ASSIGNMENT_MAX_DELAY_MS,
  ASSIGNMENT_MIN_DELAY_MS,
  ASSIGNMENT_RETRY_BUDGET_MS,
  EXPLICIT_FALLBACK_CODES,
  StickyDiskAmbiguousMountError,
  StickyDiskDegradedError,
  StickyDiskError,
  StickyDiskSafeFallbackError,
  assignmentDelay,
  configuration,
  finalize,
  mount,
  request,
  responseBody,
  validResponse,
};
