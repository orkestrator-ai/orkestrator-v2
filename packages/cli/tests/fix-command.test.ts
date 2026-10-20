import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { classifyInvocation } from "../src/client.js";
import {
  buildFixPrompt,
  collectFixFacts,
  FIX_ISSUE_REPOSITORY,
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
  const root = await mkdtemp(path.join(tmpdir(), "orkestrator-fix-test-"));
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
    expect(classifyInvocation(["--data-dir", "/tmp/x", "--fix", "grok"]).mode).toBe("fix");
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
    expect(parseFixArguments(["--data-dir=/srv/data", "--fix", "grok"])).toEqual({
      kind: "run",
      agent: "grok",
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
    expect(resolveFixAgent("grok", { env: testEnv(box), dataDir: box.dataDir })).toBeNull();
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

  test("starts Claude Code in a scratch directory with the prompt and the data directory", async () => {
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
    expect(record!.args.slice(1)).toEqual(["--add-dir", box.dataDir]);
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

  test("passes Codex and Grok the prompt as their only argument", async () => {
    const box = await sandbox();
    for (const agent of ["codex", "grok"]) {
      await fakeAgent(box.bin, agent);
      const { record } = await run(box, ["--fix", agent, "--data-dir", box.dataDir]);
      expect(record!.args).toHaveLength(1);
      expect(record!.args[0]).toContain(`orkestrator --fix ${agent}`);
    }
  });

  test("reports a missing agent and invalid input without launching anything", async () => {
    const box = await sandbox();
    const missing = await run(box, ["--fix", "grok", "--data-dir", box.dataDir]);
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
