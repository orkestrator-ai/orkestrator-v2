import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  installFakeClaudeApiFixture,
  REVIEW_QUALIFICATION_COMMIT,
} from "./container-fake-claude-install";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "claude-install-"));
  roots.push(root);
  mkdirSync(path.join(root, ".claude"));
  const settings = path.join(root, ".claude/settings.json");
  const backup = path.join(root, "orkestrator-qa-claude-settings.json");
  const scriptFile = path.join(root, "orkestrator-qa-fake-claude-api.ts");
  const original =
    JSON.stringify(
      {
        hooks: { Stop: [{ hooks: [{ type: "command", command: "preserved-hook" }] }] },
        permissions: { defaultMode: "default" },
        env: { KEEP: "original", ANTHROPIC_BASE_URL: "https://original.invalid" },
      },
      null,
      2,
    ) + "\n";
  writeFileSync(settings, original);
  let stopped = 0;
  const deps = {
    asNode: (script: string, input?: string) => {
      // Execute the production shell snippets, scoped to an isolated fake home
      // and scratch directory. Never use the host's Claude settings or /tmp names.
      const result = spawnSync(
        "sh",
        ["-c", script.replaceAll("/tmp/orkestrator-qa-", `${root}/orkestrator-qa-`)],
        {
          env: { ...process.env, HOME: root },
          input,
          encoding: "utf8",
          timeout: 5_000,
        },
      );
      if (result.status !== 0) throw new Error("fixture shell failed");
    },
    startServer: (_args: string[]) => {},
    stopServer: () => {
      stopped += 1;
    },
    waitUntilReady: async () => {},
    source: "// fixture server source",
  };
  const restored = () => {
    expect(readFileSync(settings, "utf8")).toBe(original);
    expect(existsSync(backup)).toBe(false);
    expect(existsSync(scriptFile)).toBe(false);
    expect(existsSync(`${settings}.qa`)).toBe(false);
  };
  return { deps, settings, backup, original, restored, stopped: () => stopped };
}

test("preserves hooks, consent and other environment settings, then restores exact bytes", async () => {
  const f = fixture();
  const undo = await installFakeClaudeApiFixture(f.deps);
  const installed = JSON.parse(readFileSync(f.settings, "utf8"));
  const original = JSON.parse(f.original);
  expect(installed.hooks).toEqual(original.hooks);
  expect(installed.permissions).toEqual(original.permissions);
  expect(installed.env.KEEP).toBe("original");
  expect(installed.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:47123");
  undo();
  undo();
  f.restored();
});

test("interrupted install followed by another install keeps the first backup", async () => {
  const f = fixture();
  await installFakeClaudeApiFixture(f.deps); // Simulate interruption: no undo.
  const undo = await installFakeClaudeApiFixture(f.deps);
  expect(readFileSync(f.backup, "utf8")).toBe(f.original);
  undo();
  f.restored();
  const nextUndo = await installFakeClaudeApiFixture(f.deps);
  nextUndo();
  f.restored();
});

test("readiness failure after settings mutation restores settings and stops the server", async () => {
  const f = fixture();
  await expect(
    installFakeClaudeApiFixture({
      ...f.deps,
      waitUntilReady: async () => {
        throw new Error("not ready");
      },
    }),
  ).rejects.toThrow("not ready");
  f.restored();
  expect(f.stopped()).toBe(1);
});

test("server start failure before settings mutation cleans up the partial install", async () => {
  const f = fixture();
  await expect(
    installFakeClaudeApiFixture({
      ...f.deps,
      startServer: () => {
        throw new Error("start failed");
      },
    }),
  ).rejects.toThrow("start failed");
  f.restored();
});

test("settings merge failure preserves the original and removes temporary output", async () => {
  const f = fixture();
  await expect(
    installFakeClaudeApiFixture({
      ...f.deps,
      asNode: (script, input) => {
        f.deps.asNode(script.replace("jq --argjson", "false --argjson"), input);
      },
    }),
  ).rejects.toThrow("fixture shell failed");
  f.restored();
});

test("assertion failure after installation runs the same finally undo as the spec", async () => {
  const f = fixture();
  const run = async () => {
    const undo = await installFakeClaudeApiFixture(f.deps);
    try {
      throw new Error("assertion failed");
    } finally {
      undo();
    }
  };
  await expect(run()).rejects.toThrow("assertion failed");
  f.restored();
});

test("starts the server with the signal spec's delay by default, or the caller's arguments", async () => {
  const f = fixture();
  const started: string[][] = [];
  const startServer = (args: string[]) => {
    started.push(args);
  };
  (await installFakeClaudeApiFixture({ ...f.deps, startServer }))();
  (
    await installFakeClaudeApiFixture({
      ...f.deps,
      startServer,
      serverArgs: ["--log", "/tmp/orkestrator-qa-review-steps.jsonl"],
    })
  )();
  expect(started).toEqual([
    [
      "bun",
      "/tmp/orkestrator-qa-fake-claude-api.ts",
      "--port",
      "47123",
      "--reply-delay-ms",
      "3000",
    ],
    [
      "bun",
      "/tmp/orkestrator-qa-fake-claude-api.ts",
      "--port",
      "47123",
      "--log",
      "/tmp/orkestrator-qa-review-steps.jsonl",
    ],
  ]);
  f.restored();
});

test("managed-settings failure restores settings, stops the server and removes partial state", async () => {
  const f = fixture();
  let partial = false;
  await expect(
    installFakeClaudeApiFixture({
      ...f.deps,
      installAdditional: () => {
        partial = true;
        throw new Error("managed settings failed");
      },
      undoAdditional: () => {
        partial = false;
      },
    }),
  ).rejects.toThrow("managed settings failed");
  f.restored();
  expect(f.stopped()).toBe(1);
  expect(partial).toBe(false);
});

test("qualification commit can run twice in the same fixture checkout", () => {
  const root = mkdtempSync(path.join(tmpdir(), "review-commit-"));
  roots.push(root);
  const run = (script: string) => {
    const result = spawnSync("sh", ["-c", script], { cwd: root, encoding: "utf8", timeout: 5_000 });
    expect(result.status).toBe(0);
    return result.stdout;
  };
  run("git init -q");
  run(REVIEW_QUALIFICATION_COMMIT);
  const firstHead = run("git rev-parse HEAD");
  run(REVIEW_QUALIFICATION_COMMIT);
  expect(run("git rev-parse HEAD")).toBe(firstHead);
  expect(run("git status --porcelain")).toBe("");
});
