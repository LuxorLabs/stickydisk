const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { input, requiredInput, resolveTarget, saveState, setOutput, stateDirectory, summary } = require("./action");
const { runFinalize, runMount } = require("./stickydisk");

const DEFAULT_GC_KEEP_DURATION = "192h";
const DEFAULT_GC_KEEP_RATIO = 0.9;
const CONFIG_MOUNT = "/etc/buildkit/buildkitd.toml";

function durationInput(name, environment, fallback) {
  const value = input(name, environment) || fallback;
  if (!/^[0-9]+(ns|us|ms|s|m|h)$/.test(value)) throw new Error(`Input ${name} must be a Go duration such as 192h`);
  return value;
}

function integerInput(name, environment, { min }) {
  const value = input(name, environment);
  if (!value) return null;
  if (!/^[0-9]+$/.test(value) || Number(value) < min)
    throw new Error(`Input ${name} must be an integer of at least ${min}`);
  return Number(value);
}

// BuildKit's built-in size policy is replaced once any policy is configured, so the size cap stays explicit.
function gcKeepBytes(environment, statePath, statfs) {
  const configured = integerInput("gc-keep-bytes", environment, { min: 1 });
  if (configured) return configured;
  try {
    const stats = statfs(statePath);
    const total = Number(stats.blocks) * Number(stats.bsize);
    return total > 0 ? Math.floor(total * DEFAULT_GC_KEEP_RATIO) : null;
  } catch {
    return null;
  }
}

function renderBuildkitConfig({ keepDuration, keepBytes, maxParallelism }) {
  const lines = ["[worker.oci]"];
  if (maxParallelism) lines.push(`max-parallelism = ${maxParallelism}`);
  lines.push("[[worker.oci.gcpolicy]]", "all = true", `keepDuration = "${keepDuration}"`);
  if (keepBytes) lines.push(`keepBytes = ${keepBytes}`);
  return `${lines.join("\n")}\n`;
}

function writeBuildkitConfig(environment, statePath, owner, statfs) {
  const directory = stateDirectory(environment);
  if (!directory) throw new Error("RUNNER_TEMP is required to write the BuildKit configuration");
  const settings = {
    keepDuration: durationInput("gc-keep-duration", environment, DEFAULT_GC_KEEP_DURATION),
    keepBytes: gcKeepBytes(environment, statePath, statfs),
    maxParallelism: integerInput("max-parallelism", environment, { min: 1 }),
  };
  const file = path.join(directory, `stickydisk-buildkitd-${owner}.toml`);
  fs.writeFileSync(file, renderBuildkitConfig(settings), { encoding: "utf8", mode: 0o600 });
  return { file, settings };
}

function builderName(environment = process.env) {
  const configured = input("builder-name", environment);
  const generated = `stickydisk-${environment.GITHUB_RUN_ID || process.pid}-${environment.GITHUB_ACTION || "buildkit"}`;
  const value = configured || generated;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(value)) throw new Error("BuildKit builder name is invalid");
  return value;
}

function run(command, args, options = {}) {
  const execute = options.execute || spawn;
  const operation = options.operation || "BuildKit Docker command";
  return new Promise((resolve, reject) => {
    const child = execute(command, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = "";
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const append = (chunk) => {
      stdout = `${stdout}${chunk}`.slice(0, 16 * 1024);
    };
    child.stdout?.on("data", (chunk) => {
      append(chunk);
    });
    child.stderr?.on("data", append);
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(`${operation} timed out`)));
    }, options.commandTimeoutMs || 30_000);
    child.on("error", () => finish(() => reject(new Error(`${operation} could not start`))));
    child.on("close", (code, signal) => {
      if (code === 0) finish(() => resolve(stdout.trim()));
      else {
        const outcome = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
        finish(() => reject(new Error(`${operation} failed (${outcome})`)));
      }
    });
  });
}

function endpointFromPort(value) {
  const endpoint = value.trim().split(/\s+/)[0];
  if (!/^127\.0\.0\.1:\d+$/.test(endpoint)) throw new Error("BuildKit daemon did not expose a loopback port");
  return `tcp://${endpoint}`;
}

function ownershipToken() {
  return randomUUID().replaceAll("-", "");
}

async function containerOwned(container, owner, options) {
  if (!container || !owner) return false;
  const value = await run(
    "docker",
    ["inspect", "--format", '{{ index .Config.Labels "io.luxorlabs.stickydisk.owner" }}', container],
    options,
  ).catch(() => "");
  return value === owner;
}

async function builderOwned(name, endpoint, options) {
  if (!name || !endpoint) return false;
  const inspection = await run("docker", ["buildx", "inspect", name], options).catch(() => "");
  return inspection.includes(endpoint);
}

async function startBuilder(options = {}) {
  const environment = options.environment || process.env;
  const name = builderName(environment);
  const statePath = resolveTarget(requiredInput("path", environment), environment);
  const owner = ownershipToken();
  const container = `${name}-daemon-${owner}`;
  const image = input("image", environment) || "moby/buildkit:buildx-stable-1";
  const config = writeBuildkitConfig(environment, statePath, owner, options.statfs || fs.statfsSync);
  saveState("buildkit_container", container, environment);
  saveState("buildkit_owner", owner, environment);
  try {
    await run(
      "docker",
      [
        "run",
        "--detach",
        "--name",
        container,
        "--label",
        `io.luxorlabs.stickydisk.owner=${owner}`,
        "--privileged",
        "--publish",
        "127.0.0.1::1234",
        "--volume",
        `${statePath}:/var/lib/buildkit`,
        "--volume",
        `${config.file}:${CONFIG_MOUNT}:ro`,
        image,
        "--addr",
        "tcp://0.0.0.0:1234",
        "--config",
        CONFIG_MOUNT,
        "--oci-worker-snapshotter=native",
      ],
      { ...options, operation: "BuildKit daemon start" },
    );
    saveState("buildkit_container_created", "true", environment);
    const endpoint = endpointFromPort(
      await run("docker", ["port", container, "1234/tcp"], { ...options, operation: "BuildKit daemon port discovery" }),
    );
    await run("docker", ["buildx", "create", "--name", name, "--driver", "remote", "--use", endpoint], {
      ...options,
      operation: "BuildKit builder registration",
    });
    saveState("buildkit_builder", name, environment);
    saveState("buildkit_builder_endpoint", endpoint, environment);
    saveState("buildkit_builder_created", "true", environment);
    saveState("buildkit_ready", "true", environment);
  } catch (error) {
    if (await containerOwned(container, owner, options)) {
      await run("docker", ["stop", "--time", "20", container], options).catch(() => {});
      await run("docker", ["rm", container], options)
        .then(() => saveState("buildkit_container_created", "false", environment))
        .catch(() => {});
    }
    throw error;
  }
  setOutput("name", name, environment);
  summary(
    [
      "### Sticky disk BuildKit",
      `- Builder: ${name}`,
      "- Snapshotter: native",
      `- GC keep duration: ${config.settings.keepDuration}`,
      `- GC keep bytes: ${config.settings.keepBytes ?? "BuildKit default"}`,
      `- Max parallelism: ${config.settings.maxParallelism ?? "BuildKit default"}`,
    ],
    environment,
  );
  return name;
}

async function stopBuilder(options = {}) {
  const environment = options.environment || process.env;
  const name = environment.STATE_buildkit_builder;
  const endpoint = environment.STATE_buildkit_builder_endpoint;
  const container = environment.STATE_buildkit_container;
  const owner = environment.STATE_buildkit_owner;
  const failures = [];
  const ownsContainer = await containerOwned(container, owner, options);
  const ownsBuilder =
    environment.STATE_buildkit_builder_created === "true" && (await builderOwned(name, endpoint, options));
  if (environment.STATE_buildkit_container_created === "true" && !ownsContainer) failures.push("daemon ownership");
  if (environment.STATE_buildkit_builder_created === "true" && !ownsBuilder) failures.push("builder ownership");
  if (ownsContainer)
    await run("docker", ["stop", "--time", "20", container], options).catch(() => failures.push("daemon"));
  if (ownsBuilder) await run("docker", ["buildx", "rm", name], options).catch(() => failures.push("builder metadata"));
  if (ownsContainer) await run("docker", ["rm", container], options).catch(() => failures.push("daemon"));
  if (failures.length) throw new Error("BuildKit cleanup did not complete");
}

async function runBuildkitMount(options = {}) {
  const environment = options.environment || process.env;
  const fields = await runMount(options);
  await startBuilder(options);
  return fields;
}

async function runBuildkitFinalize(options = {}) {
  const environment = options.environment || process.env;
  try {
    await stopBuilder(options);
  } catch (error) {
    await runFinalize({ ...options, commitIntent: false });
    throw error;
  }
  return runFinalize({ ...options, commitIntent: environment.STATE_buildkit_ready === "true" && options.commitIntent });
}

module.exports = {
  DEFAULT_GC_KEEP_DURATION,
  DEFAULT_GC_KEEP_RATIO,
  builderName,
  builderOwned,
  containerOwned,
  endpointFromPort,
  ownershipToken,
  renderBuildkitConfig,
  run,
  runBuildkitFinalize,
  runBuildkitMount,
  startBuilder,
  stopBuilder,
};
