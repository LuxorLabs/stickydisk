#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, spawn } = require("node:child_process");

const actionRoot = path.resolve(__dirname, "..");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stickydisk-buildkit-smoke-"));
const statePath = path.join(temporaryRoot, "state");
const certificatePath = path.join(temporaryRoot, "certificate.pem");
const privateKeyPath = path.join(temporaryRoot, "private-key.pem");
const outputPath = path.join(temporaryRoot, "output");
const summaryPath = path.join(temporaryRoot, "summary");
const dockerWrapperDirectory = path.join(temporaryRoot, "bin");
const createdBuilders = [];
const createdContainers = [];
const mountedOverlays = [];
const namePrefix = path.basename(temporaryRoot).toLowerCase();
let server;
let serverPort;
let finalized = 0;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "pipe", encoding: "utf8", timeout: 120000, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
}

function docker(args) {
  return run("sudo", ["-n", "docker", ...args]);
}

function cleanup() {
  for (const builder of createdBuilders) {
    try {
      docker(["buildx", "rm", builder]);
    } catch {}
  }
  for (const container of createdContainers) {
    try {
      docker(["rm", "--force", container]);
    } catch {}
  }
  if (server) server.close();
  for (const mount of mountedOverlays.reverse()) run("sudo", ["-n", "umount", mount]);
  run("sudo", ["-n", "chown", "-R", `${process.getuid()}:${process.getgid()}`, temporaryRoot]);
  run("sudo", ["-n", "chmod", "-R", "u+rwX", temporaryRoot]);
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

function stateEnvironment(base) {
  const state = fs.readFileSync(base.GITHUB_STATE, "utf8");
  return state.split("\n").reduce((environment, line) => {
    const [key, value] = line.split("=", 2);
    if (key) environment[`STATE_${key}`] = value;
    return environment;
  }, {});
}

function actionEnvironment(name) {
  const stateFile = path.join(temporaryRoot, `${name}.state`);
  const environment = {
    ...process.env,
    INPUT_KEY: "buildkit-smoke",
    INPUT_PATH: statePath,
    INPUT_COMMIT: "auto",
    "INPUT_FAIL-ON-ERROR": "true",
    INPUT_BUILDER_NAME: name,
    GITHUB_OUTPUT: outputPath,
    GITHUB_STATE: stateFile,
    GITHUB_STEP_SUMMARY: summaryPath,
    TENKI_STICKYDISK_URL: `https://127.0.0.1:${serverPort}`,
    TENKI_STICKYDISK_TOKEN: "smoke-capability",
    NODE_EXTRA_CA_CERTS: certificatePath,
    PATH: `${dockerWrapperDirectory}:${process.env.PATH}`,
  };
  return environment;
}

function executeAction(script, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd: actionRoot, env: environment, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited with ${code}`))));
  });
}

function containerExists(container) {
  try {
    docker(["inspect", container]);
    return true;
  } catch {
    return false;
  }
}

async function exerciseBuilder(name, requireMarker) {
  const environment = actionEnvironment(name);
  createdBuilders.push(name);
  await executeAction("src/buildkit-main.js", environment);
  const state = stateEnvironment(environment);
  const container = state.STATE_buildkit_container;
  assert.match(container, new RegExp(`^${name}-daemon-[a-f0-9]+$`));
  createdContainers.push(container);
  const command = docker(["inspect", container, "--format", "{{json .Config.Cmd}}"]).trim();
  assert.match(command, /--oci-worker-snapshotter=native/);
  if (requireMarker) docker(["exec", container, "test", "-f", "/var/lib/buildkit/stickydisk-smoke-marker"]);
  else docker(["exec", container, "touch", "/var/lib/buildkit/stickydisk-smoke-marker"]);
  const contextDirectory = path.join(temporaryRoot, "context");
  const build = docker([
    "buildx",
    "build",
    "--builder",
    name,
    "--progress",
    "plain",
    "--output",
    `type=local,dest=${path.join(temporaryRoot, name)}`,
    contextDirectory,
  ]);
  if (requireMarker) assert.match(build, /CACHED/);
  await executeAction("src/buildkit-post.js", { ...environment, ...stateEnvironment(environment) });
  assert.equal(containerExists(container), false);
}

function exerciseConsumerOverlays() {
  const lower = path.join(temporaryRoot, "lower");
  const first = path.join(temporaryRoot, "first");
  const second = path.join(temporaryRoot, "second");
  const mounts = [first, second];
  fs.mkdirSync(lower);
  fs.writeFileSync(path.join(lower, "value"), "base\n");
  for (const mount of mounts) {
    const upper = `${mount}-upper`;
    const work = `${mount}-work`;
    fs.mkdirSync(upper);
    fs.mkdirSync(work);
    fs.mkdirSync(mount);
    run("sudo", [
      "-n",
      "mount",
      "-t",
      "overlay",
      "overlay",
      "-o",
      `lowerdir=${lower},upperdir=${upper},workdir=${work}`,
      mount,
    ]);
    mountedOverlays.push(mount);
  }
  try {
    fs.writeFileSync(path.join(first, "value"), "first\n");
    assert.equal(fs.readFileSync(path.join(second, "value"), "utf8"), "base\n");
    assert.equal(fs.readFileSync(path.join(lower, "value"), "utf8"), "base\n");
  } finally {
    for (const mount of mounts.reverse()) {
      run("sudo", ["-n", "umount", mount]);
      mountedOverlays.splice(mountedOverlays.indexOf(mount), 1);
    }
  }
}

async function main() {
  run("sudo", ["-n", "docker", "version", "--format", "{{.Server.Version}}"]);
  fs.mkdirSync(statePath);
  fs.mkdirSync(path.join(temporaryRoot, "context"));
  fs.writeFileSync(path.join(temporaryRoot, "context", "Dockerfile"), "FROM scratch\nCOPY value /value\n");
  fs.writeFileSync(path.join(temporaryRoot, "context", "value"), "sticky disk build cache\n");
  fs.mkdirSync(dockerWrapperDirectory);
  fs.writeFileSync(path.join(dockerWrapperDirectory, "docker"), '#!/bin/sh\nexec sudo -n docker "$@"\n', {
    mode: 0o755,
  });
  run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    privateKeyPath,
    "-out",
    certificatePath,
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    "-days",
    "1",
  ]);
  server = https.createServer(
    { key: fs.readFileSync(privateKeyPath), cert: fs.readFileSync(certificatePath) },
    (request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        assert.equal(request.headers.authorization, "Bearer smoke-capability");
        assert.match(request.headers["idempotency-key"] || "", /^[a-f0-9]{64}$/);
        if (request.url === "/v1/stickydisk/mount") {
          const mounted = JSON.parse(body);
          assert.equal(mounted.path, statePath);
          response.end(
            JSON.stringify({
              mounted: true,
              source: "miss",
              generation: 1,
              allocation_id: "smoke-allocation",
              publication: "pending",
            }),
          );
          return;
        }
        if (request.url === "/v1/stickydisk/finalize") {
          const finalizedBody = JSON.parse(body);
          assert.deepEqual(finalizedBody, { allocation_id: "smoke-allocation", commit_intent: true });
          finalized += 1;
          response.end(JSON.stringify({ publication: "pending" }));
          return;
        }
        response.statusCode = 404;
        response.end("not found");
      });
    },
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverPort = server.address().port;
  exerciseConsumerOverlays();
  await exerciseBuilder(`${namePrefix}-first`, false);
  await exerciseBuilder(`${namePrefix}-second`, true);
  assert.equal(finalized, 2);
  console.log(
    "BuildKit local-state lifecycle smoke passed. This verifies local bind-mounted state and overlay isolation, not Ceph-backed sandbox storage.",
  );
}

main().then(cleanup, (error) => {
  cleanup();
  console.error(error.message);
  process.exitCode = 1;
});
