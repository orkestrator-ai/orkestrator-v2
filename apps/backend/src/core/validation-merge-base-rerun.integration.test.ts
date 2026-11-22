import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostTestScheduler } from "@orkestrator/protocol/node/host-test-scheduler";
import { withTemporaryStorage } from "./storage-test-support.js";
import { createEnvironment } from "./storage-shared-core.js";
import type { CommandContext } from "./commands-context.js";
import type { Environment } from "./models.js";
import { CommandFailedError, runCommand } from "./shell.js";
import {
  triageValidationFailures,
  withMergeBaseAdmission,
} from "./validation-failure-triage-service.js";
import { mergeBaseRerunExec } from "./validation-merge-base-process.js";

test("real Git and Bun compare outcomes with the managed executable and separate local ports", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "baseline-triage-")));
  await withTemporaryStorage(async (storage) => {
    const currentId = randomUUID();
    const worktree = join(root, "workspace");
    const bin = join(root, "bin");
    const calls = join(root, "bun-calls");
    mkdirSync(worktree);
    mkdirSync(bin);
    const bun = join(bin, "bun");
    writeFileSync(bun, `#!/bin/bash\necho called >> "${calls}"\nexec "${process.execPath}" "$@"\n`);
    chmodSync(bun, 0o700);
    const environment = {
      id: currentId,
      projectId: "baseline-fixture",
      environmentType: "local",
      worktreePath: worktree,
    } as Environment;
    const git = async (...args: string[]) =>
      (await runCommand("git", args, { cwd: worktree })).stdout.trim();
    const write = (file: string, text: string) => writeFileSync(join(worktree, file), text);
    let normalPort: number | null = null;
    let baselineCheckout: string | undefined;
    try {
      await storage.addEnvironment({
        ...createEnvironment(environment.projectId, { environmentType: "local" }),
        ...environment,
      });
      normalPort = await storage.environmentIsolation.assignEnvironmentPortBase(currentId);
      expect(normalPort).not.toBeNull();
      await git("init", "--quiet");
      await git("config", "user.email", "fixture@example.invalid");
      await git("config", "user.name", "Baseline Fixture");
      mkdirSync(join(worktree, "packages", "fixture", "src"), { recursive: true });
      mkdirSync(join(worktree, "packages", "preloaded", "src"), { recursive: true });
      mkdirSync(join(worktree, "tests"));
      write("package.json", JSON.stringify({ name: "fixture-root", workspaces: ["packages/*"] }));
      write("bunfig.toml", '[test]\npreload = ["./tests/root-only.ts"]\n');
      write("tests/root-only.ts", 'throw new Error("root bunfig cannot run package tests");\n');
      write(
        "packages/fixture/package.json",
        JSON.stringify({
          name: "fixture",
          scripts: {
            test: "bun run build && bun test --preload ../../tests/setup-node.ts src --parallel",
            build: "bun build.ts",
          },
        }),
      );
      write("packages/fixture/build.ts", 'await Bun.write("generated.txt", "built");');
      write("tests/setup-node.ts", 'process.env.FIXTURE_PRELOAD = "named-preload";');
      write("packages/fixture/src/behavior.ts", "export const current = false;\n");
      write(
        "packages/fixture/src/été.test.ts",
        `
import { expect, test } from "bun:test";
import { current } from "./behavior";
test("shared assertion", () => expect(1).toBe(2));
test("diagnostics differ", () => { throw new Error(current ? "new regression" : "old failure"); });
(current ? test : test.skip)("runs only on head", () => { throw new Error("head only"); });
test("needs package build and preload", async () => {
  expect(await Bun.file("generated.txt").text()).toBe("built");
  expect(process.env.FIXTURE_PRELOAD).toBe("named-preload");
  expect(process.env.ORKESTRATOR_PORT_BASE).toBeDefined();
  expect(process.env.COMPOSE_PROJECT_NAME).toBeDefined();
  if (current) throw new Error("new regression");
});
`,
      );
      write(
        "packages/fixture/src/load.test.ts",
        `
import { current } from "./behavior";
import { test } from "bun:test";
if (!current) throw new Error("failed while loading the file");
test("never reached", () => { throw new Error("head only"); });
`,
      );
      write(
        "packages/preloaded/package.json",
        JSON.stringify({
          name: "preloaded",
          scripts: { test: "bun test src --parallel" },
        }),
      );
      write("packages/preloaded/bunfig.toml", '[test]\npreload = ["./preload.ts"]\n');
      write(
        "packages/preloaded/preload.ts",
        `
import { current } from "../fixture/src/behavior";
if (!current) throw new Error("baseline preload failed");
`,
      );
      write(
        "packages/preloaded/src/preload.test.ts",
        `
import { test } from "bun:test";
test("missing after preload failure", () => { throw new Error("head only"); });
`,
      );
      await runCommand(process.execPath, ["install", "--ignore-scripts"], { cwd: worktree });
      await git("add", "package.json", "bun.lock", "bunfig.toml", "packages", "tests");
      await git("commit", "-qm", "base");
      const base = await git("rev-parse", "HEAD");
      await git("update-ref", "refs/remotes/origin/main", base);
      write("packages/fixture/src/behavior.ts", "export const current = true;\n");
      await git("commit", "-qam", "head");
      const head = await git("rev-parse", "HEAD");
      await git("update-ref", "refs/remotes/origin/main", head);
      const packageDir = join(worktree, "packages", "fixture");
      await runCommand(process.execPath, ["run", "build"], { cwd: packageDir });
      const recorded = async (cwd: string, ...args: string[]) => {
        try {
          return (
            await runCommand(
              "bash",
              [
                "-c",
                'exec "$@" 2>&1',
                "fixture",
                process.execPath,
                "test",
                "--parallel=1",
                ...args,
              ],
              {
                cwd: join(worktree, cwd),
                env: {
                  ...process.env,
                  CLAUDECODE: "",
                  // Validation inside GitHub Actions records Bun's annotated output.
                  GITHUB_ACTIONS: "true",
                  ORKESTRATOR_PORT_BASE: String(normalPort),
                  COMPOSE_PROJECT_NAME: "validated-fixture",
                },
              },
            )
          ).stdout;
        } catch (error) {
          if (!(error instanceof CommandFailedError)) throw error;
          return error.stdout;
        }
      };
      mkdirSync(join(worktree, ".orkestrator"));
      write(
        ".orkestrator/stderr.txt",
        await recorded(
          "packages/fixture",
          "--preload",
          "../../tests/setup-node.ts",
          "./src/été.test.ts",
          "./src/load.test.ts",
        ),
      );
      write(
        ".orkestrator/preload-stderr.txt",
        await recorded("packages/preloaded", "./src/preload.test.ts"),
      );
      const seenEnv: NodeJS.ProcessEnv[] = [];
      // The rerun inherits the backend's environment, as it does under CI.
      const ambientActions = process.env.GITHUB_ACTIONS;
      process.env.GITHUB_ACTIONS = "true";
      const result = await triageValidationFailures({
        environment,
        context: {
          storage,
          toolchainBinDir: bin,
          resourceRoot: root,
          appRoot: root,
        } as CommandContext,
        runner: async (command, args, timeoutMs, env) => {
          if (command !== "git") {
            expect(command).toBe(bun);
            expect(env).toBeDefined();
            seenEnv.push(env!);
            if (args.some((arg) => arg.includes("worktree add"))) baselineCheckout = args.at(-2);
          }
          return (await runCommand(command, args, { cwd: worktree, timeoutMs, env })).stdout;
        },
        headRef: head,
        baseRef: base,
        changedFiles: ["packages/fixture/src/behavior.ts"],
        commands: [
          {
            command: "bun test --cwd packages/fixture --preload ../../tests/setup-node.ts",
            cwd: "packages/fixture",
            status: "failed",
            stdoutPath: null,
            stderrPath: ".orkestrator/stderr.txt",
          },
          {
            command: "bun test --cwd packages/preloaded",
            cwd: "packages/preloaded",
            status: "failed",
            stdoutPath: null,
            stderrPath: ".orkestrator/preload-stderr.txt",
          },
        ],
      }).finally(() => {
        if (ambientActions === undefined) delete process.env.GITHUB_ACTIONS;
        else process.env.GITHUB_ACTIONS = ambientActions;
      });
      expect(result.limitation).toBeUndefined();
      const failures = new Map(
        result.triage!.commands.flatMap((command) =>
          command.failures.map((failure) => [failure.name, failure] as const),
        ),
      );
      expect(result.triage?.mergeBase).toBe(base);
      expect(failures.get("shared assertion")?.reasons).toContain("failed-on-merge-base");
      expect(failures.get("diagnostics differ")?.verdict).toBe("related");
      expect(failures.get("diagnostics differ")?.reasons).not.toContain("failed-on-merge-base");
      expect(failures.get("runs only on head")?.reasons).not.toContain("passed-on-merge-base");
      expect(failures.get("needs package build and preload")?.reasons).toContain(
        "passed-on-merge-base",
      );
      expect(failures.get("never reached")?.reasons).not.toContain("passed-on-merge-base");
      expect(failures.get("missing after preload failure")?.reasons).toBeDefined();
      expect(failures.get("missing after preload failure")?.reasons).not.toContain(
        "passed-on-merge-base",
      );
      expect(result.triage?.limitations).toEqual(
        expect.arrayContaining([
          expect.stringContaining("skipped or unreported"),
          expect.stringContaining("lacked matching failure diagnostics"),
          expect.stringContaining("load.test.ts on the merge base (error outside any test)"),
          expect.stringContaining("preload.test.ts on the merge base (error outside any test)"),
        ]),
      );
      expect(seenEnv.length).toBeGreaterThan(5);
      expect(new Set(seenEnv.map((env) => env.ORKESTRATOR_PORT_BASE)).size).toBe(1);
      expect(seenEnv[0]?.ORKESTRATOR_PORT_BASE).not.toBe(String(normalPort));
      expect(seenEnv[0]?.COMPOSE_PROJECT_NAME).toMatch(/^ork-[a-f0-9]{12}$/);
      expect(readFileSync(calls, "utf8").split("\n").filter(Boolean).length).toBeGreaterThan(5);
      expect(baselineCheckout).toBeDefined();
      expect(existsSync(baselineCheckout!)).toBe(false);
      expect(await git("worktree", "list", "--porcelain")).not.toContain(baselineCheckout!);
    } finally {
      // The UUID checkout belongs to this test, including on assertion failure.
      if (baselineCheckout && existsSync(baselineCheckout)) {
        await git("worktree", "remove", "--force", baselineCheckout).catch(() => undefined);
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
}, 45_000);

test("baseline admission waits behind work consuming the scheduler capacity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "baseline-scheduler-"));
  const scheduler = createHostTestScheduler({ directory, workers: 1, memoryMiB: 512 });
  const blocker = scheduler.enqueue({ owner: "a".repeat(64), workers: 1, memoryMiB: 512 });
  try {
    expect(scheduler.poll(blocker).state).toBe("running");
    let entered = false;
    const queued = withMergeBaseAdmission(
      scheduler,
      "b".repeat(64),
      async () => {
        entered = true;
      },
      2_000,
    );
    expect(entered).toBe(false);
    scheduler.release(blocker);
    await queued;
    expect(entered).toBe(true);
  } finally {
    scheduler.release(blocker);
    scheduler.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

const containerImage = process.env.ORKESTRATOR_BASELINE_TEST_IMAGE;
test.skipIf(!containerImage)(
  "Docker timeout reaps the in-container group before cleanup",
  async () => {
    const name = `ork-baseline-fixture-${randomUUID()}`;
    const { stdout } = await runCommand("docker", [
      "run",
      "--detach",
      "--network=none",
      "--entrypoint",
      "/bin/sleep",
      "--name",
      name,
      containerImage!,
      "60",
    ]);
    const container = stdout.trim();
    try {
      const runner = async (command: string, args: string[], timeoutMs?: number) =>
        (await runCommand("docker", ["exec", container, command, ...args], { timeoutMs })).stdout;
      const exec = mergeBaseRerunExec(runner);
      const result = await exec(
        `
      mkdir /tmp/fixture
      sleep 30 & child=$!
      printf '%s %s\\n' "$$" "$child"
      wait "$child"
    `,
        [],
        500,
      );
      expect(result).toMatchObject({ timedOut: true, quiescent: true, exitCode: null });
      const [parent, child] = result.output.trim().split(" ");
      expect(parent).toMatch(/^\d+$/);
      expect(child).toMatch(/^\d+$/);
      const cleanup = await exec(
        `
      for pid in "$@"; do
        if [ -r "/proc/$pid/stat" ]; then
          tail=$(cat "/proc/$pid/stat"); state=\${tail##*) }
          case "$state" in Z*) ;; *) exit 1 ;; esac
        fi
      done
      rmdir /tmp/fixture
    `,
        [parent!, child!],
        1_000,
      );
      expect(cleanup).toMatchObject({ quiescent: true, exitCode: 0 });
    } finally {
      await runCommand("docker", ["rm", "--force", container]);
    }
  },
  20_000,
);
