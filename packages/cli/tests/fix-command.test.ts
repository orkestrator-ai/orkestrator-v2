import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { classifyInvocation } from "../src/client.js";
import {
  buildFixPrompt,
  collectFixFacts,
  FIX_ISSUE_REPOSITORY,
  FIX_AGENTS,
  FIX_HELP,
  parseFixArguments,
  resolveFixAgent,
  runFix,
} from "../src/client/fix.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface FixSandbox {
  root: string;
  bin: string;
  dataDir: string;
  tmp: string;
  record: string;
}

async function sandbox(): Promise<FixSandbox> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "orkestrator-fix-test-")));
  roots.push(root);
  const created = {
    root,
    bin: path.join(root, "bin"),
    dataDir: path.join(root, "data"),
    tmp: path.join(root, "tmp"),
    record: path.join(root, "record.json"),
  };
  await Promise.all([
    mkdir(created.bin),
    mkdir(path.join(created.dataDir, "logs"), { recursive: true }),
    mkdir(created.tmp),
  ]);
  return created;
}

/** A stand-in agent that records how it was started, optionally leaves a draft, and exits. */
async function fakeAgent(directory: string, name: string, exitCode = 0): Promise<string> {
  const file = path.join(directory, name);
  await writeFile(
    file,
    [
      "#!/usr/bin/env bun",
      'import { writeFileSync } from "node:fs";',
      "writeFileSync(process.env.FIX_TEST_RECORD, JSON.stringify({",
      "  args: process.argv.slice(2),",
      "  cwd: process.cwd(),",
      "  opencodeAutoupdate: process.env.OPENCODE_DISABLE_AUTOUPDATE ?? null,",
      "  claudeAutoupdater: process.env.DISABLE_AUTOUPDATER ?? null,",
      "}));",
      'if (process.env.FIX_TEST_DRAFT) writeFileSync("issue.md", "## Summary\\n");',
      `process.exit(${exitCode});`,
      "",
    ].join("\n"),
  );
  await chmod(file, 0o755);
  return file;
}

function captureIo(env: NodeJS.ProcessEnv) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { env, stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) },
    out,
    err,
  };
}

function testEnv(box: FixSandbox, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  // `bun` must stay reachable for the fake agents' shebang.
  return {
    PATH: `${box.bin}:${path.dirname(process.execPath)}`,
    HOME: box.root,
    ORKESTRATOR_CLI_CONFIG_DIR: path.join(box.root, "cli"),
    FIX_TEST_RECORD: box.record,
    ...extra,
  };
}

describe("--fix classification", () => {
  test("routes --fix to the fix mode before any service or client handling", () => {
    expect(classifyInvocation(["--fix", "claude"])).toEqual({
      mode: "fix",
      argv: ["--fix", "claude"],
    });
    expect(classifyInvocation(["--fix=codex"]).mode).toBe("fix");
    expect(classifyInvocation(["--data-dir", "/tmp/x", "--fix", "codex"]).mode).toBe("fix");
    expect(classifyInvocation(["--fix"]).mode).toBe("fix");
    expect(classifyInvocation([]).mode).toBe("serve");
    expect(classifyInvocation(["project", "list"]).mode).toBe("client");
  });
});

describe("parseFixArguments", () => {
  test("accepts every agent in either spelling and an optional data directory", () => {
    expect(parseFixArguments(["--fix", "claude"])).toEqual({ kind: "run", agent: "claude" });
    expect(parseFixArguments(["--fix=OpenCode"])).toEqual({ kind: "run", agent: "opencode" });
    expect(parseFixArguments(["--fix", "codex", "--data-dir", "/srv/data"])).toEqual({
      kind: "run",
      agent: "codex",
      dataDir: "/srv/data",
    });
    expect(parseFixArguments(["--data-dir=/srv/data", "--fix", "codex"])).toEqual({
      kind: "run",
      agent: "codex",
      dataDir: "/srv/data",
    });
  });

  test("shows help with or without an agent", () => {
    expect(parseFixArguments(["--fix", "--help"])).toEqual({ kind: "help" });
    expect(parseFixArguments(["--fix", "claude", "-h"])).toEqual({ kind: "help" });
  });

  test("refuses missing, unknown, repeated and stray arguments without echoing them", () => {
    expect(parseFixArguments(["--fix"])).toMatchObject({ kind: "error" });
    expect(parseFixArguments(["--fix", "--data-dir", "/x"])).toMatchObject({ kind: "error" });
    expect(parseFixArguments(["--fix", "claude", "--data-dir"])).toMatchObject({ kind: "error" });
    expect(parseFixArguments(["--fix", "claude", "--fix", "codex"])).toMatchObject({
      kind: "error",
    });
    expect(parseFixArguments(["--fix", "cursor"])).toMatchObject({ kind: "error" });
    expect(parseFixArguments(["--fix", "claude", "--json"])).toMatchObject({ kind: "error" });
    const stray = parseFixArguments(["--fix", "claude", "the login page is broken"]);
    expect(stray.kind).toBe("error");
    expect(JSON.stringify(stray)).not.toContain("login");
    const unknown = parseFixArguments(["--fix", "my secret agent"]);
    expect(JSON.stringify(unknown)).not.toContain("secret");
  });
});

describe("agent resolution", () => {
  test("prefers the agent on PATH, then the managed toolchain copy", async () => {
    const box = await sandbox();
    const managedDir = path.join(box.dataDir, "toolchains", "bin", "current");
    await mkdir(managedDir, { recursive: true });
    const managed = await fakeAgent(managedDir, "codex");
    expect(resolveFixAgent("codex", { env: testEnv(box), dataDir: box.dataDir })).toMatchObject({
      executable: managed,
      source: "managed",
    });
    const onPath = await fakeAgent(box.bin, "codex");
    expect(resolveFixAgent("codex", { env: testEnv(box), dataDir: box.dataDir })).toMatchObject({
      executable: onPath,
      source: "path",
    });
    expect(resolveFixAgent("opencode", { env: testEnv(box), dataDir: box.dataDir })).toBeNull();
  });
});

describe("the fix prompt", () => {
  test("describes this machine and the whole report-and-file workflow", async () => {
    const box = await sandbox();
    await writeFile(
      path.join(box.dataDir, "config.json"),
      JSON.stringify({ global: { debugLogging: true } }),
    );
    await writeFile(path.join(box.dataDir, "logs", "orkestrator-ai-2026-10-20.log"), "line\n");
    await writeFile(
      path.join(box.dataDir, "backend-instance.json"),
      JSON.stringify({ appVersion: "2.23.0", pid: process.pid, authFile: "/secret/token" }),
    );
    const facts = await collectFixFacts({
      resolved: {
        agent: { name: "claude", displayName: "Claude Code", args: () => [] },
        executable: "/usr/local/bin/claude",
        source: "path",
      },
      version: "2.23.0",
      dataDir: box.dataDir,
      workDir: path.join(box.tmp, "work"),
      env: testEnv(box),
      now: new Date("2026-10-20T12:00:00Z"),
    });
    expect(facts.debugLogging).toBe(true);
    expect(facts.backend).toEqual({ appVersion: "2.23.0", pid: process.pid, running: true });
    expect(facts.recentLogs.map((log) => log.name)).toEqual(["orkestrator-ai-2026-10-20.log"]);

    const prompt = buildFixPrompt(facts);
    expect(prompt).toContain(`https://github.com/${FIX_ISSUE_REPOSITORY}`);
    expect(prompt).toContain(`gh issue create --repo ${FIX_ISSUE_REPOSITORY}`);
    expect(prompt).toContain(path.join(box.tmp, "work", "issue.md"));
    expect(prompt).toContain(box.dataDir);
    expect(prompt).toContain("orkestrator-ai-2026-10-20.log");
    expect(prompt).toContain("debug logging is on");
    expect(prompt).toContain("version 2.23.0");
    expect(prompt).toContain("Stay read-only");
    expect(prompt).toContain("Do not file anything until I explicitly approve");
    expect(prompt).toContain("gateway-auth.json");
    expect(prompt).toContain("public");
    // The descriptor's auth file path is a credential pointer and stays out of the prompt.
    expect(prompt).not.toContain("/secret/token");
  });

  test("tells the agent how to turn logging on when it is off", async () => {
    const box = await sandbox();
    const facts = await collectFixFacts({
      resolved: {
        agent: { name: "codex", displayName: "Codex", args: () => [] },
        executable: "/usr/local/bin/codex",
        source: "path",
      },
      version: "2.23.0",
      dataDir: box.dataDir,
      workDir: box.tmp,
      env: testEnv(box),
    });
    const prompt = buildFixPrompt(facts);
    expect(prompt).toContain("debug logging is off");
    expect(prompt).toContain("Settings → Debug → Save Logs for Debugging");
    expect(prompt).toContain("Log files: none");
  });
});

describe("runFix", () => {
  async function run(box: FixSandbox, argv: string[], env: NodeJS.ProcessEnv = {}) {
    const capture = captureIo(testEnv(box, env));
    const exitCode = await runFix(argv, { version: "2.23.0", io: capture.io, tmpDir: box.tmp });
    const record = existsSync(box.record)
      ? (JSON.parse(await readFile(box.record, "utf8")) as {
          args: string[];
          cwd: string;
          opencodeAutoupdate: string | null;
          claudeAutoupdater: string | null;
        })
      : null;
    return { exitCode, record, ...capture };
  }

  test("starts Claude Code in a scratch directory with the prompt and only the logs directory", async () => {
    const box = await sandbox();
    await fakeAgent(box.bin, "claude", 7);
    const { exitCode, record, err } = await run(box, [
      "--fix",
      "claude",
      "--data-dir",
      box.dataDir,
    ]);
    expect(exitCode).toBe(7);
    // `--add-dir` is variadic: anything after it would be read as a directory.
    expect(record!.args).toHaveLength(3);
    expect(record!.args[0]).toContain(`orkestrator --fix claude`);
    expect(record!.args.slice(1)).toEqual(["--add-dir", path.join(box.dataDir, "logs")]);
    expect(path.basename(record!.cwd)).toStartWith("orkestrator-fix-");
    // A PATH install is the user's own and keeps its updater.
    expect(record!.claudeAutoupdater).toBeNull();
    expect(err.join("")).toContain("Starting Claude Code");
    // Nothing was drafted, so the scratch directory is gone.
    expect(await readdir(box.tmp)).toEqual([]);
  });

  test("passes OpenCode its prompt flag and pinned environment", async () => {
    const box = await sandbox();
    await fakeAgent(box.bin, "opencode");
    const { exitCode, record } = await run(box, ["--fix=opencode"], {
      ORKESTRATOR_DATA_DIR: box.dataDir,
    });
    expect(exitCode).toBe(0);
    expect(record!.args[0]).toBe("--prompt");
    expect(record!.args[1]).toContain(box.dataDir);
    expect(record!.opencodeAutoupdate).toBe("1");
  });

  test("uses the managed copy with its pinned environment and keeps a draft", async () => {
    const box = await sandbox();
    const managedDir = path.join(box.dataDir, "toolchains", "bin", "current");
    await mkdir(managedDir, { recursive: true });
    await fakeAgent(managedDir, "claude");
    const { exitCode, record, err } = await run(
      box,
      ["--fix", "claude", "--data-dir", box.dataDir],
      { FIX_TEST_DRAFT: "1" },
    );
    expect(exitCode).toBe(0);
    expect(record!.claudeAutoupdater).toBe("1");
    const [work] = await readdir(box.tmp);
    expect(await readFile(path.join(box.tmp, work!, "issue.md"), "utf8")).toContain("Summary");
    expect(err.join("")).toContain("issue draft are in");
  });

  test("passes Codex the prompt as its only argument", async () => {
    const box = await sandbox();
    await fakeAgent(box.bin, "codex");
    const { record } = await run(box, ["--fix", "codex", "--data-dir", box.dataDir]);
    expect(record!.args).toHaveLength(1);
    expect(record!.args[0]).toContain("orkestrator --fix codex");
  });

  test("does not advertise or launch Grok without a verified prompt contract", async () => {
    const box = await sandbox();
    await fakeAgent(box.bin, "grok");
    expect(FIX_AGENTS.map((agent) => agent.name)).not.toContain("grok");
    expect(FIX_HELP).not.toContain("grok");
    const result = await run(box, ["--fix", "grok"]);
    expect(result.exitCode).toBe(2);
    expect(result.record).toBeNull();
  });

  test.each(["direct", "symlink"])("protects managed Claude found on PATH (%s)", async (kind) => {
    const box = await sandbox();
    const managedDir = path.join(box.dataDir, "toolchains", "bin", "current");
    await mkdir(managedDir, { recursive: true });
    const managed = await fakeAgent(managedDir, "claude");
    if (kind === "symlink") await symlink(managed, path.join(box.bin, "claude"));
    const env = testEnv(box, {
      PATH: `${kind === "direct" ? managedDir : box.bin}:${path.dirname(process.execPath)}`,
    });
    expect(resolveFixAgent("claude", { env, dataDir: box.dataDir })?.source).toBe("managed");
    const { record } = await run(box, ["--fix", "claude", "--data-dir", box.dataDir], env);
    expect(record!.claudeAutoupdater).toBe("1");
  });

  test("preserves user-installed Claude updater settings even with a managed copy", async () => {
    const box = await sandbox();
    await fakeAgent(box.bin, "claude");
    const managedDir = path.join(box.dataDir, "toolchains", "bin", "current");
    await mkdir(managedDir, { recursive: true });
    await fakeAgent(managedDir, "claude");
    const { record } = await run(box, ["--fix", "claude", "--data-dir", box.dataDir], {
      DISABLE_AUTOUPDATER: "0",
    });
    expect(record!.claudeAutoupdater).toBe("0");
  });

  test.each(["missing-data", "missing-logs"])(
    "omits Claude's directory grant for %s",
    async (kind) => {
      const box = await sandbox();
      await fakeAgent(box.bin, "claude");
      const dataDir = kind === "missing-data" ? path.join(box.root, "absent") : box.dataDir;
      if (kind === "missing-logs") await rm(path.join(dataDir, "logs"), { recursive: true });
      const { record } = await run(box, ["--fix", "claude", "--data-dir", dataDir]);
      expect(record!.args).toHaveLength(1);
      expect(existsSync(path.join(dataDir, "logs"))).toBe(false);
    },
  );

  test("formats synchronous spawn failure and cleans empty scratch space", async () => {
    const box = await sandbox();
    await fakeAgent(box.bin, "codex");
    const capture = captureIo(testEnv(box));
    const status = await runFix(["--fix", "codex", "--data-dir", box.dataDir], {
      version: "2.23.0",
      io: capture.io,
      tmpDir: box.tmp,
      spawn: () => {
        throw new Error("raw exception with private prompt");
      },
    });
    expect(status).toBe(1);
    expect(capture.err.join("")).toContain("error [agent-failed]");
    expect(capture.err.join("")).not.toContain("raw exception");
    expect(await readdir(box.tmp)).toEqual([]);
  });

  test("cleans listeners and scratch space when child completion rejects", async () => {
    const box = await sandbox();
    await fakeAgent(box.bin, "codex");
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    const before = signals.map((signal) => process.listeners(signal));
    const capture = captureIo(testEnv(box));
    const status = await runFix(["--fix", "codex", "--data-dir", box.dataDir], {
      version: "2.23.0",
      io: capture.io,
      tmpDir: box.tmp,
      spawn: () => ({ exited: Promise.reject(new Error("completion failed")), kill: () => {} }),
    });
    expect(status).toBe(1);
    expect(signals.map((signal) => process.listeners(signal))).toEqual(before);
    expect(await readdir(box.tmp)).toEqual([]);
  });

  test("reports a missing agent and invalid input without launching anything", async () => {
    const box = await sandbox();
    const missing = await run(box, ["--fix", "codex", "--data-dir", box.dataDir]);
    expect(missing.exitCode).toBe(3);
    expect(missing.err.join("")).toContain("error [not-found]");
    const invalid = await run(box, ["--fix", "nope"]);
    expect(invalid.exitCode).toBe(2);
    expect(invalid.err.join("")).toContain("error [invalid-input]");
    const help = await run(box, ["--fix", "--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.out.join("")).toContain("Usage: orkestrator --fix AGENT");
    expect(await readdir(box.tmp)).toEqual([]);
  });
});

async function factsFor(box: FixSandbox) {
  return collectFixFacts({
    resolved: {
      agent: FIX_AGENTS[0]!,
      executable: "/test/claude",
      source: "path",
    },
    version: "2.23.0",
    dataDir: box.dataDir,
    workDir: box.tmp,
    env: testEnv(box),
  });
}

describe("managed installation layouts", () => {
  test.each(["digest-set", "base"])(
    "resolves agents and reports the %s directory",
    async (layout) => {
      const box = await sandbox();
      const binDir = path.join(
        box.dataDir,
        "toolchains",
        "bin",
        ...(layout === "base" ? [] : ["abc123"]),
      );
      await mkdir(binDir, { recursive: true });
      const executable = await fakeAgent(binDir, "claude");
      expect(resolveFixAgent("claude", { env: testEnv(box), dataDir: box.dataDir })).toMatchObject({
        executable,
        source: "managed",
      });
      expect((await factsFor(box)).toolchainBinDir).toBe(binDir);
      const capture = captureIo(testEnv(box));
      let updater: string | undefined;
      expect(
        await runFix(["--fix", "claude", "--data-dir", box.dataDir], {
          version: "2.23.0",
          io: capture.io,
          tmpDir: box.tmp,
          spawn: (_command, options) => {
            updater = options.env.DISABLE_AUTOUPDATER;
            return { exited: Promise.resolve(0), kill: () => {} };
          },
        }),
      ).toBe(0);
      expect(updater).toBe("1");
    },
  );

  test("does not guess among several desktop activation sets", async () => {
    const box = await sandbox();
    for (const digest of ["abc123", "def456"]) {
      const directory = path.join(box.dataDir, "toolchains", "bin", digest);
      await mkdir(directory, { recursive: true });
      await fakeAgent(directory, "claude");
    }
    expect(resolveFixAgent("claude", { env: testEnv(box), dataDir: box.dataDir })).toBeNull();
  });

  test.each(["current", "gh-latest", "gh"])("discovers managed gh in %s", async (layout) => {
    const box = await sandbox();
    const root = path.join(box.dataDir, "toolchains");
    let expected: string;
    if (layout === "current") {
      const set = path.join(root, "bin", "abc123");
      await mkdir(set, { recursive: true });
      expected = await fakeAgent(set, "gh");
      await symlink("abc123", path.join(root, "bin", "current"));
    } else {
      for (const version of ["2.9.0", "2.100.0"]) {
        const dir = path.join(root, layout, version, ...(layout === "gh" ? ["darwin-arm64"] : []));
        await mkdir(dir, { recursive: true });
        await fakeAgent(dir, "gh");
      }
      expected = path.join(
        root,
        layout,
        "2.100.0",
        ...(layout === "gh" ? ["darwin-arm64"] : []),
        "gh",
      );
    }
    const facts = await factsFor(box);
    expect(facts.managedGh).toBe(expected);
    expect(buildFixPrompt(facts)).toContain(expected);
  });

  test("prefers activated gh over a newer gh-latest installation", async () => {
    const box = await sandbox();
    const activated = path.join(box.dataDir, "toolchains", "bin", "current");
    const latest = path.join(box.dataDir, "toolchains", "gh-latest", "2.100.0");
    await mkdir(activated, { recursive: true });
    await mkdir(latest, { recursive: true });
    const expected = await fakeAgent(activated, "gh");
    await fakeAgent(latest, "gh");
    expect((await factsFor(box)).managedGh).toBe(expected);
  });
});

describe("diagnostic backend selection", () => {
  test.each(["empty", "unrelated", "matching"])(
    "handles %s saved connections without changing configuration",
    async (kind) => {
      const box = await sandbox();
      const descriptor = path.join(box.dataDir, "backend-instance.json");
      await writeFile(descriptor, JSON.stringify({ pid: process.pid }));
      const configDir = path.join(box.root, "cli");
      const configFile = path.join(configDir, "connections.json");
      const config = JSON.stringify({
        version: 1,
        defaultConnection: "remote",
        connections: {
          remote: {
            kind: "endpoint",
            url: "https://elsewhere.example",
            credentialFile: "/private/token",
          },
          ...(kind === "matching"
            ? { local: { kind: "descriptor", descriptorPath: descriptor } }
            : {}),
        },
      });
      if (kind !== "empty") {
        await mkdir(configDir);
        await writeFile(configFile, config, { mode: 0o600 });
      }
      const facts = await factsFor(box);
      const prompt = buildFixPrompt(facts);
      if (kind === "matching") {
        expect(facts.diagnosticConnection).toBe("local");
        expect(prompt).toContain("host status --connection local");
        expect(prompt).toContain("connection check --connection local");
      } else {
        expect(facts.diagnosticConnection).toBeNull();
        expect(prompt).not.toContain("host status");
        expect(prompt).not.toContain("connection check");
        expect(prompt).toContain("No saved CLI connection was verified");
      }
      expect(prompt).not.toContain("elsewhere.example");
      expect(prompt).not.toContain("/private/token");
      if (kind === "empty") expect(existsSync(configDir)).toBe(false);
      else expect(await readFile(configFile, "utf8")).toBe(config);
    },
  );
});

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path.basename(file)}`);
    await Bun.sleep(10);
  }
}

test("live child suppresses parent SIGINT, receives termination signals, and releases listeners", async () => {
  const box = await sandbox();
  const agent = path.join(box.bin, "codex");
  const ready = path.join(box.root, "ready");
  const term = path.join(box.root, "term");
  const interrupted = path.join(box.root, "interrupted");
  const resultFile = path.join(box.root, "result.json");
  await writeFile(
    agent,
    `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
process.on("SIGINT", () => writeFileSync(${JSON.stringify(interrupted)}, "unexpected"));
process.on("SIGTERM", () => writeFileSync(${JSON.stringify(term)}, "forwarded"));
process.on("SIGHUP", () => process.exit(7));
setInterval(() => {}, 1000);
writeFileSync(${JSON.stringify(ready)}, "ready");
`,
  );
  await chmod(agent, 0o755);
  const runner = path.join(box.root, "runner.ts");
  await writeFile(
    runner,
    `
import { runFixProcess } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/client/fix.ts"))};
const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
const before = signals.map(signal => process.listenerCount(signal));
const status = await runFixProcess(["--fix", "codex", "--data-dir", ${JSON.stringify(box.dataDir)}], "2.23.0");
await Bun.write(${JSON.stringify(resultFile)}, JSON.stringify({ status, before, after: signals.map(signal => process.listenerCount(signal)) }));
`,
  );
  const child = Bun.spawn([process.execPath, runner], {
    env: testEnv(box, { TMPDIR: box.tmp }),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    await waitForFile(ready);
    child.kill("SIGINT");
    // Wait for another forwarded signal to establish the runner stayed alive.
    child.kill("SIGTERM");
    await waitForFile(term);
    expect(existsSync(interrupted)).toBe(false);
    child.kill("SIGHUP");
    await waitForFile(resultFile);
    expect(await child.exited).toBe(0);
    const result = JSON.parse(await readFile(resultFile, "utf8"));
    expect(result.status).toBe(7);
    expect(result.after).toEqual(result.before);
    expect(await readdir(box.tmp)).toEqual([]);
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
});

test("packaged launcher dispatches fix without importing a backend or creating data", async () => {
  const box = await sandbox();
  const packageDir = path.join(box.root, "package");
  await mkdir(path.join(packageDir, "bin"), { recursive: true });
  await mkdir(path.join(packageDir, "dist"));
  await copyFile(
    path.resolve(import.meta.dir, "../bin/orkestrator.js"),
    path.join(packageDir, "bin", "orkestrator.js"),
  );
  await copyFile(
    path.resolve(import.meta.dir, "../dist/client.js"),
    path.join(packageDir, "dist", "client.js"),
  );
  await writeFile(
    path.join(packageDir, "package.json"),
    JSON.stringify({ type: "module", version: "2.23.0" }),
  );
  // Any accidental backend import fails this fixture immediately.
  await writeFile(path.join(packageDir, "dist", "main.js"), 'throw new Error("BACKEND_IMPORTED");');
  await fakeAgent(box.bin, "claude", 7);
  const dataDir = path.join(box.root, "absent-data");
  for (const [argv, expected] of [
    [["--fix", "--help"], 0],
    [["--fix", "grok"], 2],
    [["--fix", "claude", "--data-dir", dataDir], 7],
  ] as const) {
    const child = Bun.spawn(
      [process.execPath, path.join(packageDir, "bin", "orkestrator.js"), ...argv],
      {
        env: testEnv(box, { ORKESTRATOR_DATA_DIR: dataDir, TMPDIR: box.tmp }),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      const [stdout, stderr, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ argv, status }).toEqual({ argv, status: expected });
      expect(stdout + stderr).not.toContain("BACKEND_IMPORTED");
      expect(existsSync(dataDir)).toBe(false);
      expect(existsSync(path.join(box.root, "cli"))).toBe(false);
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
      await child.exited;
    }
  }
  expect(await readdir(box.tmp)).toEqual([]);
  const record = JSON.parse(await readFile(box.record, "utf8"));
  expect(record.args).toHaveLength(1);
  expect(record.args[0]).toContain("orkestrator --fix claude");
});
