#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { run, startBuilder, stopBuilder } = require("../src/buildkit");

function options(argumentsList) {
  const parsed = {};
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!key.startsWith("--") || !value)
      throw new Error("Usage: --state-path PATH --mode publisher|consumer --expect cold|warm [--image IMAGE]");
    parsed[key.slice(2)] = value;
  }
  if (!path.isAbsolute(parsed["state-path"] || "")) throw new Error("--state-path must be absolute");
  if (!new Set(["publisher", "consumer"]).has(parsed.mode)) throw new Error("--mode must be publisher or consumer");
  if (!new Set(["cold", "warm"]).has(parsed.expect)) throw new Error("--expect must be cold or warm");
  return parsed;
}

function actionState(environment) {
  const values = fs.readFileSync(environment.GITHUB_STATE, "utf8").trim().split("\n");
  return values.reduce((state, value) => {
    const [key, item] = value.split("=", 2);
    state[`STATE_${key}`] = item;
    return state;
  }, {});
}

async function execute(argumentsList = process.argv.slice(2)) {
  const parsed = options(argumentsList);
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "stickydisk-buildkit-guest-"));
  const stateFile = path.join(temporaryDirectory, "state");
  const builder = `stickydisk-guest-${process.pid}-${randomUUID().slice(0, 8)}`;
  const environment = {
    ...process.env,
    HOME: process.env.HOME || temporaryDirectory,
    GITHUB_WORKSPACE: process.env.GITHUB_WORKSPACE || temporaryDirectory,
    RUNNER_TEMP: temporaryDirectory,
    GITHUB_STATE: stateFile,
    INPUT_PATH: parsed["state-path"],
    INPUT_BUILDER_NAME: builder,
    INPUT_IMAGE: parsed.image || "moby/buildkit:buildx-stable-1",
  };
  const context = path.join(temporaryDirectory, "context");
  const output = path.join(temporaryDirectory, "output");
  fs.mkdirSync(context);
  fs.writeFileSync(path.join(context, "Dockerfile"), "FROM scratch\nCOPY payload /payload\n");
  fs.writeFileSync(path.join(context, "payload"), "sticky disk cache payload\n");

  try {
    const name = await startBuilder({ environment, commandTimeoutMs: 90_000 });
    const buildOutput = await run(
      "docker",
      ["buildx", "build", "--builder", name, "--progress", "plain", "--output", `type=local,dest=${output}`, context],
      { commandTimeoutMs: 90_000 },
    );
    assert.equal(fs.readFileSync(path.join(output, "payload"), "utf8"), "sticky disk cache payload\n");
    if (parsed.expect === "warm") assert.match(buildOutput, /CACHED/);
    if (parsed.expect === "cold") assert.doesNotMatch(buildOutput, /CACHED/);
    console.log(`BuildKit ${parsed.mode} ${parsed.expect} check passed.`);
  } finally {
    if (fs.existsSync(stateFile)) await stopBuilder({ environment: { ...environment, ...actionState(environment) } });
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  execute().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { actionState, execute, options };
