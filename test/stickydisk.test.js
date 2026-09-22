const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const {
  DEFAULT_GC_KEEP_DURATION,
  endpointFromPort,
  builderName,
  renderBuildkitConfig,
  run,
  runBuildkitFinalize,
  startBuilder,
} = require("../src/buildkit");
const {
  ASSIGNMENT_MAX_DELAY_MS,
  ASSIGNMENT_MIN_DELAY_MS,
  StickyDiskAmbiguousMountError,
  StickyDiskDegradedError,
  StickyDiskError,
  assignmentDelay,
  configuration,
  request,
} = require("../src/client");
const { runFinalize, runMount } = require("../src/stickydisk");
const { options: guestOptions } = require("../scripts/buildkit-guest-e2e");

function environment(extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stickydisk-test-"));
  return {
    INPUT_KEY: "npm-cache",
    INPUT_PATH: "/workspace/.npm",
    INPUT_COMMIT: "auto",
    "INPUT_FAIL-ON-ERROR": "false",
    HOME: "/home/runner",
    GITHUB_WORKSPACE: "/work/repository",
    GITHUB_OUTPUT: path.join(directory, "output"),
    GITHUB_STATE: path.join(directory, "state"),
    GITHUB_STEP_SUMMARY: path.join(directory, "summary"),
    RUNNER_TEMP: directory,
    TENKI_STICKYDISK_URL: "https://sticky.tenki.test/",
    TENKI_STICKYDISK_TOKEN: "capability",
    ...extra,
  };
}

test("masks the runner capability in step logs before any request", async () => {
  const lines = [];
  const env = environment();
  await runMount({
    environment: env,
    write: (line) => lines.push(line),
    mount: async () => ({ mounted: true, source: "miss", publication: "pending", allocation_id: "a1" }),
  });
  await runFinalize({
    environment: { ...env, STATE_allocation_id: "a1" },
    write: (line) => lines.push(line),
    finalize: async () => ({ publication: "pending" }),
  });
  assert.deepEqual(lines, ["::add-mask::capability\n", "::add-mask::capability\n"]);
});

test("requires an HTTPS endpoint and a capability", () => {
  assert.throws(() => configuration(environment({ TENKI_STICKYDISK_URL: "http://sticky.test" })), StickyDiskError);
  assert.throws(
    () => configuration(environment({ TENKI_STICKYDISK_URL: "https://sticky.test/?token=value" })),
    StickyDiskError,
  );
  assert.throws(() => configuration(environment({ TENKI_STICKYDISK_TOKEN: "" })), StickyDiskError);
  assert.equal(configuration(environment()).endpoint, "https://sticky.tenki.test");
});

test("retries delayed assignment responses with one stable idempotency key", async () => {
  let calls = 0;
  let clock = 0;
  const delays = [];
  const idempotencyKeys = [];
  const result = await request(
    "/v1/stickydisk/mount",
    {},
    {
      environment: environment(),
      now: () => clock,
      random: () => 0,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        clock += milliseconds;
      },
      fetchImpl: async (_url, requestOptions) => {
        calls += 1;
        idempotencyKeys.push(requestOptions.headers["Idempotency-Key"]);
        if (calls < 4) return new Response("assignment pending", { status: 425, headers: { "retry-after": "2" } });
        return Response.json({ mounted: true, source: "hit", generation: "g1", allocation_id: "allocation-1" });
      },
    },
  );
  assert.equal(calls, 4);
  assert.deepEqual(delays, [2_000, 2_000, 2_000]);
  assert.equal(idempotencyKeys[0], idempotencyKeys[1]);
  assert.equal(result.generation, "g1");
});

test("exhausted assignment retries fail within their separate budget", async () => {
  let clock = 0;
  const delays = [];
  await assert.rejects(
    request(
      "/v1/stickydisk/mount",
      {},
      {
        environment: environment(),
        now: () => clock,
        random: () => 0,
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
          clock += milliseconds;
        },
        fetchImpl: async () => new Response("assignment pending", { status: 425, headers: { "retry-after": "2" } }),
      },
    ),
    /did not become ready/,
  );
  assert.deepEqual(delays, [2_000, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000]);
});

test("assignment exhaustion falls back when the action is not strict", async () => {
  let clock = 0;
  const env = environment();
  const fields = await runMount({
    environment: env,
    mount: () =>
      request(
        "/v1/stickydisk/mount",
        {},
        {
          environment: env,
          now: () => clock,
          random: () => 0,
          sleep: async (milliseconds) => {
            clock += milliseconds;
          },
          fetchImpl: async () => new Response("assignment pending", { status: 425, headers: { "retry-after": "5" } }),
        },
      ),
  });
  assert.equal(fields.source, "fallback");
});

test("assignment retry delays clamp hostile Retry-After values", () => {
  const response = (retryAfter) => new Response("", { status: 425, headers: { "retry-after": retryAfter } });
  assert.equal(
    assignmentDelay(response("999999"), 10_000, () => 0),
    ASSIGNMENT_MAX_DELAY_MS,
  );
  assert.equal(
    assignmentDelay(response("-1"), 10_000, () => 0),
    ASSIGNMENT_MIN_DELAY_MS,
  );
  assert.equal(
    assignmentDelay(response("nope"), 10_000, () => 0),
    ASSIGNMENT_MIN_DELAY_MS,
  );
  assert.equal(
    assignmentDelay(response("5"), 4_999, () => 0),
    null,
  );
});

test("storage degradation fails without publishing fallback outputs", async () => {
  const env = environment();
  await assert.rejects(
    runMount({
      environment: env,
      mount: () =>
        request(
          "/v1/stickydisk/mount",
          {},
          { environment: env, fetchImpl: async () => Response.json({ code: "storage_degraded" }, { status: 503 }) },
        ),
    }),
    StickyDiskDegradedError,
  );
  assert.equal(fs.existsSync(env.GITHUB_OUTPUT), false);
  assert.match(fs.readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"), /Storage state: unknown/);
});

test("ambiguous mount failures fail instead of claiming an uncached fallback", async () => {
  const env = environment();
  await assert.rejects(
    runMount({
      environment: env,
      mount: () =>
        request(
          "/v1/stickydisk/mount",
          {},
          { environment: env, sleep: async () => {}, fetchImpl: async () => new Response("", { status: 500 }) },
        ),
    }),
    StickyDiskAmbiguousMountError,
  );
  assert.equal(fs.existsSync(env.GITHUB_OUTPUT), false);
});

test("mount conflicts and exhausted transport failures remain ambiguous", async () => {
  const env = environment();
  await assert.rejects(
    request(
      "/v1/stickydisk/mount",
      {},
      { environment: env, sleep: async () => {}, fetchImpl: async () => new Response("", { status: 409 }) },
    ),
    StickyDiskAmbiguousMountError,
  );
  await assert.rejects(
    request(
      "/v1/stickydisk/mount",
      {},
      {
        environment: env,
        sleep: async () => {},
        fetchImpl: async () => {
          throw new Error("timeout");
        },
      },
    ),
    StickyDiskAmbiguousMountError,
  );
});

test("malformed and oversized successful mount responses remain ambiguous", async () => {
  const env = environment();
  await assert.rejects(
    request(
      "/v1/stickydisk/mount",
      {},
      { environment: env, sleep: async () => {}, fetchImpl: async () => new Response("not json", { status: 200 }) },
    ),
    StickyDiskAmbiguousMountError,
  );
  await assert.rejects(
    request(
      "/v1/stickydisk/mount",
      {},
      {
        environment: env,
        sleep: async () => {},
        fetchImpl: async () => new Response("x".repeat(16 * 1024 + 1), { status: 200 }),
      },
    ),
    StickyDiskAmbiguousMountError,
  );
});

test("invalid successful mount contracts remain ambiguous", async () => {
  const env = environment();
  const invalidResponses = [
    { mounted: true, source: "unknown", allocation_id: "allocation-1" },
    { mounted: true, source: "fallback", allocation_id: "allocation-1" },
    { mounted: true, source: "hit" },
  ];
  for (const payload of invalidResponses) {
    await assert.rejects(
      request(
        "/v1/stickydisk/mount",
        {},
        { environment: env, sleep: async () => {}, fetchImpl: async () => Response.json(payload) },
      ),
      StickyDiskAmbiguousMountError,
    );
  }
});

test("an earlier ambiguous mount remains ambiguous through a safe response", async () => {
  const env = environment();
  let calls = 0;
  await assert.rejects(
    request(
      "/v1/stickydisk/mount",
      {},
      {
        environment: env,
        sleep: async () => {},
        fetchImpl: async () => {
          calls += 1;
          if (calls === 1) throw new Error("network failure");
          return Response.json({ code: "quota_exceeded" }, { status: 409 });
        },
      },
    ),
    StickyDiskAmbiguousMountError,
  );
});

test("an invalid success remains ambiguous when assignment retries exhaust", async () => {
  const env = environment();
  let calls = 0;
  let clock = 0;
  await assert.rejects(
    request(
      "/v1/stickydisk/mount",
      {},
      {
        environment: env,
        now: () => clock,
        random: () => 0,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
        fetchImpl: async () => {
          calls += 1;
          if (calls === 1) return new Response("invalid", { status: 200 });
          return new Response("pending", { status: 425, headers: { "retry-after": "5" } });
        },
      },
    ),
    StickyDiskAmbiguousMountError,
  );
});

test("explicit pre-attachment allocation failures still fall back", async () => {
  const env = environment();
  const fields = await runMount({
    environment: env,
    mount: () =>
      request(
        "/v1/stickydisk/mount",
        {},
        { environment: env, fetchImpl: async () => Response.json({ code: "quota_exceeded" }, { status: 409 }) },
      ),
  });
  assert.equal(fields.source, "fallback");
});

test("a publisher auto mount saves publication intent", async () => {
  const env = environment();
  let mountRequest;
  const fields = await runMount({
    environment: env,
    mount: async (requestBody) => {
      mountRequest = requestBody;
      return { mounted: true, source: "miss", allocation_id: "allocation-1", publication: "pending" };
    },
  });
  assert.equal(fields.source, "miss");
  assert.equal(mountRequest.path, "/workspace/.npm");
  assert.match(fs.readFileSync(env.GITHUB_OUTPUT, "utf8"), /mounted=true/);
  assert.equal(fs.readFileSync(env.GITHUB_STATE, "utf8"), "allocation_id=allocation-1\ncommit_intent=true\n");
});

test("Branch Protection consumers finalize auto mounts without publication", async () => {
  for (const response of [
    { mounted: true, source: "miss", allocation_id: "consumer-miss", publication: "not_requested" },
    {
      mounted: true,
      source: "readonly",
      generation: 1,
      allocation_id: "consumer-readonly",
      publication: "not_requested",
    },
  ]) {
    const env = environment();
    await runMount({ environment: env, mount: async () => response });
    const state = fs
      .readFileSync(env.GITHUB_STATE, "utf8")
      .split("\n")
      .reduce((values, line) => {
        const [key, value] = line.split("=", 2);
        if (key) values[`STATE_${key}`] = value;
        return values;
      }, {});
    let body;
    await runFinalize({
      environment: { ...env, ...state },
      finalize: async (requestBody) => {
        body = requestBody;
        return { publication: "not_requested" };
      },
    });
    assert.deepEqual(body, { allocation_id: response.allocation_id, commit_intent: false });
    assert.equal(
      fs.readFileSync(env.GITHUB_STATE, "utf8"),
      `allocation_id=${response.allocation_id}\ncommit_intent=false\n`,
    );
  }
});

test("commit never finalizes a mounted allocation without publication", async () => {
  const env = environment({ INPUT_COMMIT: "never" });
  await runMount({
    environment: env,
    mount: async () => ({
      mounted: true,
      source: "miss",
      allocation_id: "allocation-1",
      publication: "not_requested",
    }),
  });
  assert.equal(fs.readFileSync(env.GITHUB_STATE, "utf8"), "allocation_id=allocation-1\ncommit_intent=false\n");
});

test("strict mount failures fail the action", async () => {
  await assert.rejects(
    runMount({
      environment: environment({ "INPUT_FAIL-ON-ERROR": "true" }),
      mount: async () => {
        throw new Error("unavailable");
      },
    }),
    /unavailable/,
  );
});

test("strict mode rejects a server fallback and resolves tilde paths", async () => {
  await assert.rejects(
    runMount({
      environment: environment({ "INPUT_FAIL-ON-ERROR": "true", INPUT_PATH: "~/.npm" }),
      mount: async () => ({ mounted: false, source: "fallback" }),
    }),
    /unavailable/,
  );
});

test("fallback responses never claim a mount or save an allocation", async () => {
  const env = environment();
  const fields = await runMount({
    environment: env,
    mount: async () => ({ mounted: true, source: "fallback", allocation_id: "allocation-1" }),
  });
  assert.equal(fields.mounted, false);
  assert.equal(fs.existsSync(env.GITHUB_STATE), false);
});

test("finalizes only a saved allocation and commits auto mode", async () => {
  const env = environment({ STATE_allocation_id: "allocation-1", STATE_commit_intent: "true" });
  let body;
  await runFinalize({
    environment: env,
    finalize: async (requestBody) => {
      body = requestBody;
      return { publication: "pending" };
    },
  });
  assert.deepEqual(body, { allocation_id: "allocation-1", commit_intent: true });
  assert.equal(await runFinalize({ environment: environment() }), null);
});

test("BuildKit names and ports are constrained before Docker executes", () => {
  assert.equal(builderName(environment({ INPUT_BUILDER_NAME: "cache.builder-1" })), "cache.builder-1");
  assert.throws(() => builderName(environment({ INPUT_BUILDER_NAME: "bad name" })), /invalid/);
  assert.equal(endpointFromPort("127.0.0.1:43210\n"), "tcp://127.0.0.1:43210");
  assert.throws(() => endpointFromPort("0.0.0.0:43210"), /loopback/);
});

test("BuildKit Docker failures identify the safe lifecycle stage", async () => {
  const execute = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      child.stderr.emit("data", "sensitive daemon output");
      child.emit("close", 125);
    });
    return child;
  };
  let error;
  try {
    await run("docker", ["run"], { execute, operation: "BuildKit daemon start" });
  } catch (failure) {
    error = failure;
  }
  assert.ok(error);
  assert.equal(error.message, "BuildKit daemon start failed (exit code 125)");
  assert.doesNotMatch(error.message, /sensitive/);
});

test("BuildKit stops before sticky disk finalization", async () => {
  const calls = [];
  const execute = (_command, args) => {
    calls.push(args.join(" "));
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (args[0] === "inspect") child.stdout.emit("data", "owner-1");
      if (args[0] === "buildx" && args[1] === "inspect") child.stdout.emit("data", "tcp://127.0.0.1:43210");
      child.emit("close", 0);
    });
    return child;
  };
  const env = environment({
    STATE_allocation_id: "allocation-1",
    STATE_commit_intent: "true",
    STATE_buildkit_builder: "cache",
    STATE_buildkit_builder_created: "true",
    STATE_buildkit_builder_endpoint: "tcp://127.0.0.1:43210",
    STATE_buildkit_container: "cache-daemon",
    STATE_buildkit_container_created: "true",
    STATE_buildkit_owner: "owner-1",
    STATE_buildkit_ready: "true",
  });
  await runBuildkitFinalize({
    environment: env,
    execute,
    finalize: async () => {
      calls.push("finalize");
      return { publication: "pending" };
    },
  });
  assert.deepEqual(calls, [
    'inspect --format {{ index .Config.Labels "io.luxorlabs.stickydisk.owner" }} cache-daemon',
    "buildx inspect cache",
    "stop --time 20 cache-daemon",
    "buildx rm cache",
    "rm cache-daemon",
    "finalize",
  ]);
});

test("a failed BuildKit cleanup finalizes without publication", async () => {
  const calls = [];
  const execute = (_command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (args[0] === "inspect") child.stdout.emit("data", "owner-1");
      if (args[0] === "buildx" && args[1] === "inspect") child.stdout.emit("data", "tcp://127.0.0.1:43210");
      child.emit("close", args[0] === "stop" ? 1 : 0);
    });
    return child;
  };
  const env = environment({
    STATE_allocation_id: "allocation-1",
    STATE_commit_intent: "true",
    STATE_buildkit_builder: "cache",
    STATE_buildkit_builder_created: "true",
    STATE_buildkit_builder_endpoint: "tcp://127.0.0.1:43210",
    STATE_buildkit_container: "cache-daemon",
    STATE_buildkit_container_created: "true",
    STATE_buildkit_owner: "owner-1",
    STATE_buildkit_ready: "true",
  });
  await assert.rejects(
    runBuildkitFinalize({
      environment: env,
      execute,
      finalize: async (body) => {
        calls.push(body);
        return { publication: "discarded" };
      },
    }),
    /cleanup/,
  );
  assert.deepEqual(calls, [{ allocation_id: "allocation-1", commit_intent: false }]);
});

test("a builder name collision never removes user-owned Buildx metadata", async () => {
  const calls = [];
  let owner = "";
  const execute = (_command, args) => {
    calls.push(args.join(" "));
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      const label = args.indexOf("--label");
      if (label >= 0) owner = args[label + 1].split("=")[1];
      if (args[0] === "port") child.stdout.emit("data", "127.0.0.1:43210\n");
      if (args[0] === "inspect") child.stdout.emit("data", owner);
      child.emit("close", args[0] === "buildx" && args[1] === "create" ? 1 : 0);
    });
    return child;
  };
  await assert.rejects(
    startBuilder({ environment: environment({ INPUT_BUILDER_NAME: "cache" }), execute }),
    /BuildKit builder registration failed \(exit code 1\)/,
  );
  assert.equal(
    calls.some((call) => call === "buildx rm cache"),
    false,
  );
  assert.equal(
    calls.some((call) => call.startsWith("rm --force")),
    false,
  );
  assert.equal(
    calls.some((call) => call.startsWith("stop --time 20")),
    true,
  );
});

test("a missing Docker daemon checks ownership without removing a container", async () => {
  const calls = [];
  const execute = (_command, args) => {
    calls.push(args.join(" "));
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => child.emit("close", 1));
    return child;
  };
  await assert.rejects(
    startBuilder({ environment: environment({ INPUT_BUILDER_NAME: "cache" }), execute }),
    /BuildKit daemon start failed \(exit code 1\)/,
  );
  assert.deepEqual(calls.length, 2);
  assert.match(calls[0], /^run --detach --name cache-daemon-/);
  assert.match(calls[1], /^inspect --format/);
});

test("a timed-out Docker start cleans up its owned container", async () => {
  const calls = [];
  let owner;
  const execute = (_command, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    if (args[0] === "run") {
      owner = args[args.indexOf("--label") + 1].split("=")[1];
      return child;
    }
    queueMicrotask(() => {
      if (args[0] === "inspect") child.stdout.emit("data", owner);
      child.emit("close", 0);
    });
    return child;
  };
  await assert.rejects(startBuilder({ environment: environment(), execute, commandTimeoutMs: 10 }), /timed out/);
  assert.deepEqual(
    calls.map((args) => args[0]),
    ["run", "inspect", "stop", "rm"],
  );
});

test("post-job cleanup removes an owned container whose startup never completed", async () => {
  const calls = [];
  const execute = (_command, args) => {
    calls.push(args[0]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (args[0] === "inspect") child.stdout.emit("data", "owner-1");
      child.emit("close", 0);
    });
    return child;
  };
  await runBuildkitFinalize({
    environment: environment({
      STATE_allocation_id: "allocation-1",
      STATE_commit_intent: "true",
      STATE_buildkit_container: "cache-daemon",
      STATE_buildkit_owner: "owner-1",
    }),
    execute,
    finalize: async (body) => {
      assert.equal(body.commit_intent, false);
      calls.push("finalize");
      return { publication: "discarded" };
    },
  });
  assert.deepEqual(calls, ["inspect", "stop", "rm", "finalize"]);
});

test("a partial BuildKit start finalizes without publication", async () => {
  let body;
  await runBuildkitFinalize({
    environment: environment({ STATE_allocation_id: "allocation-1", STATE_commit_intent: "true" }),
    finalize: async (requestBody) => {
      body = requestBody;
      return { publication: "discarded" };
    },
  });
  assert.deepEqual(body, { allocation_id: "allocation-1", commit_intent: false });
});

test("guest BuildKit E2E options require trusted absolute state paths", () => {
  assert.deepEqual(guestOptions(["--state-path", "/mnt/sticky/buildkit", "--mode", "publisher", "--expect", "cold"]), {
    "state-path": "/mnt/sticky/buildkit",
    mode: "publisher",
    expect: "cold",
  });
  assert.throws(
    () => guestOptions(["--state-path", "relative", "--mode", "publisher", "--expect", "cold"]),
    /absolute/,
  );
  assert.throws(() => guestOptions(["--state-path", "/mnt/sticky", "--mode", "writer", "--expect", "cold"]), /mode/);
});

function buildkitStartExecute(calls) {
  return (_command, args) => {
    calls.push(args.join(" "));
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (args[0] === "port") child.stdout.emit("data", "127.0.0.1:43210\n");
      child.emit("close", 0);
    });
    return child;
  };
}

test("BuildKit config renders a time and size policy with optional parallelism", () => {
  assert.equal(
    renderBuildkitConfig({ keepDuration: "48h", keepBytes: 1024, maxParallelism: 2 }),
    '[worker.oci]\nmax-parallelism = 2\n[[worker.oci.gcpolicy]]\nall = true\nkeepDuration = "48h"\nkeepBytes = 1024\n',
  );
  assert.equal(
    renderBuildkitConfig({ keepDuration: "192h", keepBytes: null, maxParallelism: null }),
    '[worker.oci]\n[[worker.oci.gcpolicy]]\nall = true\nkeepDuration = "192h"\n',
  );
});

test("the BuildKit daemon mounts a config sized to the sticky disk by default", async () => {
  const calls = [];
  const env = environment({
    INPUT_BUILDER_NAME: "cache",
    INPUT_PATH: "/var/lib/buildkit",
    "INPUT_MAX-PARALLELISM": "3",
  });
  await startBuilder({
    environment: env,
    execute: buildkitStartExecute(calls),
    statfs: (target) => {
      assert.equal(target, "/var/lib/buildkit");
      return { blocks: 1000n, bsize: 4096n };
    },
  });
  const runCall = calls[0].split(" ");
  const configVolume = runCall[runCall.indexOf("--volume", runCall.indexOf("--volume") + 1) + 1];
  const [file, mount, mode] = configVolume.split(":");
  assert.equal(mount, "/etc/buildkit/buildkitd.toml");
  assert.equal(mode, "ro");
  assert.ok(file.startsWith(env.RUNNER_TEMP), "config lives in RUNNER_TEMP");
  assert.deepEqual(runCall.slice(runCall.indexOf("--addr")), [
    "--addr",
    "tcp://0.0.0.0:1234",
    "--config",
    "/etc/buildkit/buildkitd.toml",
    "--oci-worker-snapshotter=native",
  ]);
  assert.equal(
    fs.readFileSync(file, "utf8"),
    `[worker.oci]\nmax-parallelism = 3\n[[worker.oci.gcpolicy]]\nall = true\nkeepDuration = "${DEFAULT_GC_KEEP_DURATION}"\nkeepBytes = ${Math.floor(4096000 * 0.9)}\n`,
  );
  assert.match(fs.readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"), /GC keep duration: 192h/);
});

test("explicit BuildKit GC inputs win and invalid ones fail before the daemon starts", async () => {
  const calls = [];
  const env = environment({
    INPUT_BUILDER_NAME: "cache",
    "INPUT_GC-KEEP-DURATION": "24h",
    "INPUT_GC-KEEP-BYTES": "5000",
  });
  await startBuilder({
    environment: env,
    execute: buildkitStartExecute(calls),
    statfs: () => ({ blocks: 1n, bsize: 1n }),
  });
  const runCall = calls[0].split(" ");
  const file = runCall[runCall.indexOf("--volume", runCall.indexOf("--volume") + 1) + 1].split(":")[0];
  assert.match(fs.readFileSync(file, "utf8"), /keepDuration = "24h"\nkeepBytes = 5000\n$/);
  for (const invalid of [
    { "INPUT_GC-KEEP-DURATION": "8 days" },
    { "INPUT_GC-KEEP-BYTES": "-1" },
    { "INPUT_MAX-PARALLELISM": "0" },
  ]) {
    const rejected = [];
    await assert.rejects(
      startBuilder({
        environment: environment({ INPUT_BUILDER_NAME: "cache", ...invalid }),
        execute: buildkitStartExecute(rejected),
      }),
      /Input /,
    );
    assert.deepEqual(rejected, [], "no daemon starts with an invalid GC input");
  }
});

test("a disabled key is an explicit safe fallback", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: "sticky disk key is disabled", code: "key_disabled" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  const env = environment();
  const fields = await runMount({ environment: env, fetchImpl, sleep: async () => {} });
  assert.equal(fields.source, "fallback");
  assert.equal(fields.mounted, false);
  assert.match(fs.readFileSync(env.GITHUB_OUTPUT, "utf8"), /source=fallback/);
});
