const {
  commitInput,
  booleanInput,
  maskSecret,
  requiredInput,
  resolveTarget,
  saveState,
  setOutput,
  summary,
} = require("./action");
const {
  StickyDiskAmbiguousMountError,
  StickyDiskDegradedError,
  StickyDiskError,
  finalize,
  mount,
} = require("./client");

const SOURCES = new Set(["hit", "miss", "readonly", "fallback"]);

function responseFields(response) {
  const source = SOURCES.has(response.source) ? response.source : "fallback";
  return {
    mounted: response.mounted === true && source !== "fallback",
    source,
    generation:
      typeof response.generation === "string" || Number.isSafeInteger(response.generation)
        ? String(response.generation)
        : "",
    allocationId: typeof response.allocation_id === "string" ? response.allocation_id : "",
    fallbackReason: typeof response.fallback_reason === "string" ? response.fallback_reason : "",
    previousOutcome: typeof response.previous_outcome === "string" ? response.previous_outcome : "",
    publication: typeof response.publication === "string" ? response.publication : "pending",
  };
}

function publishFields(fields, environment = process.env) {
  setOutput("mounted", fields.mounted, environment);
  setOutput("source", fields.source, environment);
  setOutput("generation", fields.generation, environment);
}

function mountSummary(fields, environment = process.env) {
  const lines = ["### Sticky disk", `- Mount mode: ${fields.source}`, `- Generation: ${fields.generation || "none"}`];
  if (fields.fallbackReason) lines.push(`- Fallback reason: ${fields.fallbackReason}`);
  if (fields.previousOutcome) lines.push(`- Previous candidate: ${fields.previousOutcome}`);
  lines.push(`- Publication: ${fields.publication}`);
  summary(lines, environment);
}

async function runMount(options = {}) {
  const environment = options.environment || process.env;
  maskSecret(environment.TENKI_STICKYDISK_TOKEN, options.write);
  const client = options.mount || mount;
  const failOnError = booleanInput("fail-on-error", environment);
  const commit = commitInput(environment);
  const request = {
    key: requiredInput("key", environment),
    path: resolveTarget(requiredInput("path", environment), environment),
    commit,
    fail_on_error: failOnError,
  };
  try {
    const fields = responseFields(await client(request, options));
    if (failOnError && fields.source === "fallback") throw new StickyDiskError("Sticky disk storage is unavailable");
    publishFields(fields, environment);
    if (fields.mounted && fields.allocationId) {
      saveState("allocation_id", fields.allocationId, environment);
      saveState("commit_intent", commit === "auto" && fields.publication === "pending", environment);
    }
    mountSummary(fields, environment);
    return fields;
  } catch (error) {
    if (error instanceof StickyDiskDegradedError || error instanceof StickyDiskAmbiguousMountError) {
      summary(
        ["### Sticky disk", "- Mount mode: degraded", "- Storage state: unknown", "- Publication: not requested"],
        environment,
      );
      throw error;
    }
    if (failOnError) throw error;
    const fields = {
      mounted: false,
      source: "fallback",
      generation: "",
      allocationId: "",
      fallbackReason: "storage unavailable",
      previousOutcome: "",
      publication: "not requested",
    };
    publishFields(fields, environment);
    mountSummary(fields, environment);
    return fields;
  }
}

async function runFinalize(options = {}) {
  const environment = options.environment || process.env;
  maskSecret(environment.TENKI_STICKYDISK_TOKEN, options.write);
  const allocationId = environment.STATE_allocation_id;
  if (!allocationId) return null;
  const commitIntent = options.commitIntent ?? environment.STATE_commit_intent === "true";
  const failOnError = booleanInput("fail-on-error", environment);
  try {
    const response = await (options.finalize || finalize)(
      { allocation_id: allocationId, commit_intent: commitIntent },
      options,
    );
    const publication = typeof response.publication === "string" ? response.publication : "pending";
    summary(["### Sticky disk finalization", `- Publication: ${publication}`], environment);
    return response;
  } catch (error) {
    summary(
      ["### Sticky disk finalization", "- Publication: pending", "- Finalization request was not accepted"],
      environment,
    );
    if (failOnError) throw error;
    return null;
  }
}

module.exports = {
  StickyDiskAmbiguousMountError,
  StickyDiskDegradedError,
  StickyDiskError,
  mountSummary,
  publishFields,
  responseFields,
  runFinalize,
  runMount,
};
