const fs = require("node:fs");
const path = require("node:path");

function input(name, environment = process.env) {
  const githubName = `INPUT_${name.toUpperCase()}`;
  const compatibilityName = `INPUT_${name.replaceAll("-", "_").toUpperCase()}`;
  return (environment[githubName] || environment[compatibilityName] || "").trim();
}

function requiredInput(name, environment = process.env) {
  const value = input(name, environment);
  if (!value) throw new Error(`Missing required input: ${name}`);
  return value;
}

function booleanInput(name, environment = process.env) {
  const value = input(name, environment).toLowerCase();
  if (value === "true") return true;
  if (value === "false" || value === "") return false;
  throw new Error(`Input ${name} must be true or false`);
}

function commitInput(environment = process.env) {
  const value = input("commit", environment) || "auto";
  if (value !== "auto" && value !== "never") throw new Error("Input commit must be auto or never");
  return value;
}

function safeValue(value) {
  return String(value ?? "").replace(/[\r\n]/g, "");
}

function appendEnvironmentFile(file, key, value) {
  if (!file) return;
  fs.appendFileSync(file, `${key}=${safeValue(value)}\n`, "utf8");
}

function setOutput(name, value, environment = process.env) {
  appendEnvironmentFile(environment.GITHUB_OUTPUT, name, value);
}

function setEnvironment(name, value, environment = process.env) {
  appendEnvironmentFile(environment.GITHUB_ENV, name, value);
}

function saveState(name, value, environment = process.env) {
  appendEnvironmentFile(environment.GITHUB_STATE, name, value);
}

// The runner exports the capability as plain env, so every step could echo it; masking hides it in step logs.
function maskSecret(value, write = (line) => process.stdout.write(line)) {
  const secret = safeValue(value);
  if (secret) write(`::add-mask::${secret}\n`);
}

function summary(lines, environment = process.env) {
  if (!environment.GITHUB_STEP_SUMMARY) return;
  fs.appendFileSync(environment.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`, "utf8");
}

function stateDirectory(environment = process.env) {
  return environment.RUNNER_TEMP ? path.resolve(environment.RUNNER_TEMP) : "";
}

function resolveTarget(value, environment = process.env) {
  if (value === "~" || value.startsWith("~/")) {
    if (!environment.HOME) throw new Error("HOME is required to resolve a sticky disk path");
    return path.resolve(environment.HOME, value.slice(2));
  }
  if (path.isAbsolute(value)) return path.resolve(value);
  if (!environment.GITHUB_WORKSPACE) throw new Error("GITHUB_WORKSPACE is required for a relative sticky disk path");
  return path.resolve(environment.GITHUB_WORKSPACE, value);
}

module.exports = {
  booleanInput,
  commitInput,
  input,
  maskSecret,
  requiredInput,
  resolveTarget,
  safeValue,
  saveState,
  setEnvironment,
  setOutput,
  stateDirectory,
  summary,
};
