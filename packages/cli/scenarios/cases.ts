import { spawnSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PublicReceipt } from "@orkestrator/protocol/public-api";
import type {
  PublicEnvironmentSummary,
  PublicProjectSummary,
} from "@orkestrator/protocol/public-api-resources";
import {
  configureConnection,
  createFixtureRepository,
  exists,
  expectThat,
  type CliResult,
  type ScenarioContext,
} from "./harness.js";

/**
 * The credential-free scenario matrix plus opt-in live/container cases.
 * Each scenario records created IDs as cleanup steps immediately, so a
 * failure part-way still removes what it made.
 */

export interface ScenarioDefinition {
  name: string;
  description: string;
  /** Requires live provider credentials (`--provider`). */
  live?: boolean;
  /** Runs only for this environment type unless unspecified. */
  environmentTypes?: Array<"local" | "container">;
  run(context: ScenarioContext): Promise<void>;
}

function receiptOf(result: CliResult): PublicReceipt {
  const receipt = result.envelope?.receipt;
  expectThat(receipt, `${result.argv.slice(0, 3).join(" ")} returned no receipt`);
  return receipt;
}

async function addFixtureProject(
  context: ScenarioContext,
  name: string,
  files?: Record<string, string>,
) {
  const fixture = await createFixtureRepository(context.root, name, files);
  const { result } = await context.cli.ok<{ project: PublicProjectSummary }>(
    ["project", "add", "--path", fixture.projectPath, "--request-id", `${name}-add`],
    "project add",
  );
  const projectId = result.project.id;
  context.cleanup.push({
    label: `remove project ${projectId}`,
    run: async () => {
      await context.cli.run(["--json", "project", "remove", projectId], {
        stage: "cleanup project",
      });
    },
  });
  return { ...fixture, projectId };
}

async function createEnvironment(
  context: ScenarioContext,
  projectId: string,
  name: string,
  extra: string[] = [],
): Promise<PublicEnvironmentSummary> {
  const { result } = await context.cli.ok<{ environment: PublicEnvironmentSummary }>(
    [
      "environment",
      "create",
      "--project",
      projectId,
      "--type",
      context.environmentType,
      "--name",
      name,
      "--request-id",
      `${name}-create`,
      ...extra,
    ],
    "environment create",
  );
  const environmentId = result.environment.id;
  context.cleanup.unshift({
    label: `delete environment ${environmentId}`,
    run: async () => {
      await context.cli.run(
        ["--json", "environment", "delete", environmentId, "--wait", "deleted", "--timeout", "3m"],
        {
          stage: "cleanup environment",
        },
      );
    },
  });
  return result.environment;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

export const SCENARIOS: ScenarioDefinition[] = [
  {
    name: "read-only",
    description:
      "Packaged client → real gateway: identity, discovery, pure JSON, no extra service.",
    async run(context) {
      const help = await context.cli.run(["help"], {
        stage: "help without backend",
        expectCode: 0,
      });
      expectThat(
        help.stdout.includes("Client commands never start a backend"),
        "help text missing",
      );
      await configureConnection(context);
      const check = await context.cli.ok<{
        capabilities: { installationId: string; availableActions: string[] };
      }>(["connection", "check"], "connection check");
      expectThat(
        check.result.capabilities.installationId === context.backend.descriptor.installationId,
        "connection check reported a different installation",
      );
      expectThat(
        check.result.capabilities.availableActions.includes("environment.exec"),
        "exec not advertised",
      );
      await context.cli.ok(["project", "list"], "project list");
      await context.cli.ok(["environment", "list"], "environment list");
      const before = await readdir(context.backend.dataDir);
      await context.cli.run(["version"], { stage: "version", expectCode: 0 });
      // A client command never initialises or writes the backend's data dir.
      expectThat(
        JSON.stringify(await readdir(context.backend.dataDir)) === JSON.stringify(before),
        "client touched the data dir",
      );
      const ids = await context.cli.run(["project", "list", "--output", "id"], {
        stage: "id output",
        expectCode: 0,
      });
      expectThat(ids.stdout === "", "id output of an empty list is not empty");
    },
  },
  {
    name: "local-lifecycle",
    description:
      "Real Git fixture: register, create at a pinned base, start ready, configure, rename, fork, stop, delete.",
    async run(context) {
      await configureConnection(context);
      const fixture = await addFixtureProject(context, "lifecycle");
      const environment = await createEnvironment(context, fixture.projectId, "lifecycle-a", [
        "--base-branch",
        "main",
        "--base-commit",
        fixture.head,
      ]);
      const started = await context.cli.ok<{ environment: PublicEnvironmentSummary }>(
        ["environment", "start", environment.id, "--wait", "ready", "--timeout", "3m"],
        "start --wait ready",
      );
      const ready = started.result.environment;
      expectThat(ready.ready && ready.setup.phase === "ready", "environment is not setup-ready");
      if (context.environmentType === "local") {
        expectThat(
          ready.workspacePath && (await exists(ready.workspacePath)),
          "worktree was not created",
        );
        expectThat(
          git(ready.workspacePath!, ["rev-parse", "HEAD"]) === fixture.head,
          "worktree is not at the pinned base",
        );
      }
      expectThat(ready.base.commit === fixture.head, "recorded base commit differs");
      const configured = await context.cli.ok<{ settings: { revision: string } }>(
        [
          "environment",
          "config",
          "set",
          environment.id,
          "--set",
          "agent.claude.model=opus",
          "--expected-revision",
          ready.settingsRevision,
        ],
        "config set",
      );
      const stale = await context.cli.run(
        [
          "--json",
          "environment",
          "config",
          "set",
          environment.id,
          "--set",
          "agent.claude.model=sonnet",
          "--expected-revision",
          ready.settingsRevision,
        ],
        { stage: "stale config set", expectCode: 8 },
      );
      expectThat(
        stale.envelope && !stale.envelope.ok && stale.envelope.error.code === "revision-conflict",
        "stale revision accepted",
      );
      expectThat(
        configured.result.settings.revision !== ready.settingsRevision,
        "revision did not advance",
      );
      const renamed = await context.cli.ok<{ branch: string }>(
        ["environment", "rename", environment.id, "lifecycle-renamed"],
        "rename",
      );
      expectThat(
        renamed.result.branch.includes("lifecycle-renamed"),
        "branch was not renamed with the environment",
      );
      if (context.environmentType === "local") {
        const forked = await context.cli.ok<{ environment: PublicEnvironmentSummary }>(
          ["environment", "fork", environment.id, "--type", "local"],
          "fork",
        );
        const forkId = forked.result.environment.id;
        context.cleanup.unshift({
          label: `delete fork ${forkId}`,
          run: async () => {
            await context.cli.run(
              ["--json", "environment", "delete", forkId, "--wait", "deleted", "--timeout", "3m"],
              { stage: "cleanup fork" },
            );
          },
        });
        await context.cli.ok(
          ["environment", "delete", forkId, "--wait", "deleted", "--timeout", "3m"],
          "delete fork",
        );
      }
      await context.cli.ok(
        ["environment", "stop", environment.id, "--wait", "stopped", "--timeout", "2m"],
        "stop",
      );
      await context.cli.ok(
        ["environment", "delete", environment.id, "--wait", "deleted", "--timeout", "3m"],
        "delete",
      );
      if (context.environmentType === "local" && ready.workspacePath) {
        expectThat(!(await exists(ready.workspacePath)), "worktree survived deletion");
      }
      const gone = await context.cli.run(["--json", "environment", "get", environment.id], {
        stage: "get deleted",
        expectCode: 3,
      });
      expectThat(gone.envelope && !gone.envelope.ok, "deleted environment still readable");
    },
  },
  {
    name: "retry-and-retention",
    description:
      "Same key replays, changed intent conflicts, and a deleted resource is not recreated by a replay.",
    async run(context) {
      await configureConnection(context);
      const fixture = await addFixtureProject(context, "retry");
      const args = [
        "environment",
        "create",
        "--project",
        fixture.projectId,
        "--type",
        context.environmentType,
        "--name",
        "retry-env",
        "--request-id",
        "retry-key",
      ];
      const first = await context.cli.ok<{ environment: { id: string } }>(args, "create");
      const replay = await context.cli.ok<{ environment: { id: string } }>(args, "replay");
      expectThat(
        replay.result.environment.id === first.result.environment.id,
        "replay created a second environment",
      );
      expectThat(replay.envelope.receipt?.replayed === true, "replay was not marked replayed");
      const conflict = await context.cli.run(
        [
          "--json",
          "environment",
          "create",
          "--project",
          fixture.projectId,
          "--type",
          context.environmentType,
          "--name",
          "other",
          "--request-id",
          "retry-key",
        ],
        { stage: "conflicting reuse", expectCode: 8 },
      );
      expectThat(
        conflict.envelope &&
          !conflict.envelope.ok &&
          conflict.envelope.error.code === "request-conflict",
        "conflict not reported",
      );
      await context.cli.ok(
        [
          "environment",
          "delete",
          first.result.environment.id,
          "--wait",
          "deleted",
          "--timeout",
          "3m",
        ],
        "delete",
      );
      const afterDelete = await context.cli.ok(args, "replay after delete");
      expectThat(
        afterDelete.envelope.receipt?.replayed === true,
        "replay after delete re-executed",
      );
      const listed = await context.cli.ok<{ items: unknown[] }>(
        ["environment", "list", "--project", fixture.projectId],
        "list",
      );
      expectThat(
        listed.result.items.length === 0,
        "a deleted environment was recreated by a replay",
      );
      const byKey = await context.cli.ok(
        ["run", "get", "--request-id", "retry-key", "--action", "environment.create"],
        "run get by key",
      );
      expectThat(
        byKey.envelope.receipt?.operationId === first.envelope.receipt?.operationId,
        "lookup by key found another operation",
      );
    },
  },
  {
    name: "setup-failure",
    description:
      "A failing setup fails `--wait ready` with its reason; a launch's first prompt is never sent.",
    environmentTypes: ["local"],
    async run(context) {
      await configureConnection(context);
      const fixture = await addFixtureProject(context, "setupfail", {
        "README.md": "# setup failure\n",
        "orkestrator-ai.json": JSON.stringify({ setupLocal: "echo failing setup; exit 7" }),
      });
      const environment = await createEnvironment(context, fixture.projectId, "setup-fails");
      const failed = await context.cli.run(
        ["--json", "environment", "start", environment.id, "--wait", "ready", "--timeout", "3m"],
        { stage: "start fails", expectCode: 1 },
      );
      expectThat(
        failed.envelope && !failed.envelope.ok && failed.envelope.error.code === "setup-failed",
        "setup failure not reported",
      );
      const promptFile = path.join(context.root, "launch-prompt.txt");
      await writeFile(promptFile, "This prompt must never be sent.\n");
      const launch = await context.cli.run(
        [
          "--json",
          "environment",
          "launch",
          "--project",
          fixture.projectId,
          "--type",
          "local",
          "--agent",
          "claude",
          "--name",
          "launch-fails",
          "--prompt-file",
          promptFile,
          "--request-id",
          "launch-fail",
        ],
        { stage: "launch" },
      );
      const launchReceipt = launch.envelope?.receipt;
      expectThat(launchReceipt, "launch returned no receipt");
      const launchedEnvironment = launchReceipt.resources.environmentId!;
      context.cleanup.unshift({
        label: `delete launched ${launchedEnvironment}`,
        run: async () => {
          await context.cli.run(
            [
              "--json",
              "environment",
              "delete",
              launchedEnvironment,
              "--wait",
              "deleted",
              "--timeout",
              "3m",
            ],
            { stage: "cleanup launch" },
          );
        },
      });
      const settled = await context.cli.run(
        ["--json", "run", "wait", launchReceipt.operationId, "--timeout", "3m"],
        { stage: "launch wait" },
      );
      const receipt = settled.envelope?.receipt as PublicReceipt;
      expectThat(receipt.state === "partial", `launch ended ${receipt.state}, expected partial`);
      expectThat(
        receipt.dispatch?.state === "not-sent",
        "the first prompt was dispatched despite failed setup",
      );
    },
  },
  {
    name: "client-exit",
    description:
      "Ctrl+C stops only observation; another process reconnects to the same receipt and sees it finish.",
    environmentTypes: ["local"],
    async run(context) {
      await configureConnection(context);
      const fixture = await addFixtureProject(context, "slowsetup", {
        "README.md": "# slow setup\n",
        "orkestrator-ai.json": JSON.stringify({ setupLocal: "sleep 4" }),
      });
      const environment = await createEnvironment(context, fixture.projectId, "client-exit");
      const interrupted = await context.cli.run(
        ["--json", "environment", "start", environment.id, "--wait", "ready", "--timeout", "3m"],
        { stage: "interrupted wait", signalAfterMs: { signal: "SIGINT", afterMs: 2_500 } },
      );
      expectThat(
        interrupted.code === 130,
        `interrupted wait exited ${interrupted.code}, expected 130`,
      );
      const receipt = interrupted.envelope?.receipt;
      expectThat(receipt, "no receipt was printed on interruption");
      const resumed = await context.cli.run(
        ["--json", "run", "wait", receipt.operationId, "--timeout", "3m"],
        {
          stage: "reconnect",
          expectCode: 0,
        },
      );
      expectThat(
        receiptOf(resumed).state === "succeeded",
        "the start did not finish after the client exited",
      );
      const ready = await context.cli.ok<PublicEnvironmentSummary>(
        ["environment", "get", environment.id],
        "get",
      );
      expectThat(ready.result.ready, "environment is not ready after reconnecting");
    },
  },
  {
    name: "exec",
    description: "Authoritative exit status, argv preservation, output windows and cancellation.",
    async run(context) {
      await configureConnection(context);
      const fixture = await addFixtureProject(context, "exec");
      const environment = await createEnvironment(context, fixture.projectId, "exec-env");
      await context.cli.ok(
        ["environment", "start", environment.id, "--wait", "ready", "--timeout", "5m"],
        "start",
      );
      const passthrough = await context.cli.run(
        [
          "--json",
          "environment",
          "exec",
          environment.id,
          "--wait",
          "--exit-code",
          "--",
          "sh",
          "-c",
          "printf '%s' \"$1\"; exit 5",
          "sh",
          "a b;$(x)",
        ],
        { stage: "exec exit code" },
      );
      expectThat(passthrough.code === 5, `exit-code passthrough returned ${passthrough.code}`);
      const operationId = receiptOf(passthrough).operationId;
      const out = await context.cli.ok<{ text: string }>(["run", "output", operationId], "output");
      expectThat(out.result.text === "a b;$(x)", "argv was not preserved");
      const sleeper = await context.cli.ok(
        ["environment", "exec", environment.id, "--", "sleep", "60"],
        "exec sleep",
      );
      const sleepOperation = sleeper.envelope.receipt!.operationId;
      await context.cli.ok(["run", "cancel", sleepOperation], "cancel");
      const cancelled = await context.cli.run(
        ["--json", "run", "wait", sleepOperation, "--timeout", "1m"],
        { stage: "cancelled", expectCode: 1 },
      );
      expectThat(
        cancelled.envelope &&
          !cancelled.envelope.ok &&
          cancelled.envelope.error.code === "run-cancelled",
        "cancellation not reported",
      );
      // Deleting the environment drains a still-running command first.
      const lingering = await context.cli.ok(
        ["environment", "exec", environment.id, "--", "sleep", "127"],
        "exec before delete",
      );
      const lingeringOperation = lingering.envelope.receipt!.operationId;
      await context.cli.ok(
        ["environment", "delete", environment.id, "--wait", "deleted", "--timeout", "3m"],
        "delete during exec",
      );
      const drained = receiptOf(
        await context.cli.run(["--json", "run", "get", lingeringOperation], {
          stage: "exec after delete",
          expectCode: 0,
        }),
      );
      expectThat(
        drained.state === "cancelled" || drained.state === "interrupted",
        `command outlived its environment (${drained.state})`,
      );
      if (context.environmentType === "local") {
        const survivors = spawnSync("pgrep", ["-f", "^sleep 127$"], { encoding: "utf8" });
        expectThat(survivors.status === 1, "the command's process survived deletion");
      }
    },
  },
  {
    name: "wrong-profile",
    description: "A missing explicit profile fails without falling back to the configured default.",
    async run(context) {
      await configureConnection(context);
      const result = await context.cli.run(
        ["--json", "--profile", "does-not-exist-here", "project", "list"],
        {
          stage: "missing profile",
          expectCode: 4,
        },
      );
      expectThat(
        result.envelope &&
          !result.envelope.ok &&
          result.envelope.error.code === "profile-unavailable",
        "wrong error for a missing profile",
      );
    },
  },
  {
    name: "live-session",
    description:
      "Opt-in, credentialed: one bounded turn per provider, checked by a file assertion and a follow-up.",
    live: true,
    async run(context) {
      expectThat(context.provider, "live-session needs --provider");
      await configureConnection(context);
      const fixture = await addFixtureProject(context, `live-${context.provider}`);
      // A restricted container admits only the default allowlist, which
      // reaches Anthropic's API but not OpenAI's or OpenCode's; the live
      // check is about the agent path, not the firewall policy.
      const environment = await createEnvironment(
        context,
        fixture.projectId,
        `live-${context.provider}`,
        context.environmentType === "container" && context.provider !== "claude"
          ? ["--network", "full"]
          : [],
      );
      await context.cli.ok(
        ["environment", "start", environment.id, "--wait", "ready", "--timeout", "5m"],
        "start",
      );
      const prompt = path.join(context.root, "live-prompt.txt");
      await writeFile(
        prompt,
        "Create a file named scenario-result.txt in the repository root containing exactly the text: orkestrator-ok\nDo not modify any other file. Reply with one short sentence when done.\n",
      );
      const model = process.env.ORKESTRATOR_SCENARIO_MODEL;
      // A fresh installation has no catalogue; refresh it explicitly so an
      // explicit model can be validated rather than guessed at.
      const options = await context.cli.ok<{
        agents: Array<{
          agent: string;
          catalogue: { state: string; models: Array<{ id: string }> };
        }>;
      }>(
        ["agent", "options", "--environment", environment.id, "--refresh"],
        "agent options --refresh",
        { timeoutMs: 5 * 60_000 },
      );
      if (model) {
        const catalogue = options.result.agents.find(
          (agent) => agent.agent === context.provider,
        )?.catalogue;
        expectThat(
          catalogue?.models.some((candidate) => candidate.id === model),
          `model ${model} is not in the refreshed ${context.provider} catalogue (${catalogue?.state})`,
        );
      }
      const started = await context.cli.run(
        [
          "--json",
          "session",
          "start",
          "--environment",
          environment.id,
          "--agent",
          context.provider,
          ...(model ? ["--model", model] : []),
          "--mode",
          "build",
          "--prompt-file",
          prompt,
          "--wait",
          "--timeout",
          "8m",
          "--request-id",
          "live-start",
        ],
        { stage: "session start --wait", timeoutMs: 9 * 60_000 },
      );
      const receipt = started.envelope?.receipt as PublicReceipt;
      expectThat(
        receipt?.state === "succeeded",
        `live run ended ${receipt?.state} (${started.envelope && !started.envelope.ok ? started.envelope.error.code : "ok"}): ${
          receipt?.error?.message ?? ""
        } ${receipt?.execution?.error ?? receipt?.execution?.reason ?? ""}`.trim(),
      );
      const cat = await context.cli.run(
        [
          "--json",
          "environment",
          "exec",
          environment.id,
          "--wait",
          "--",
          "cat",
          "scenario-result.txt",
        ],
        { stage: "verify file", expectCode: 0 },
      );
      const catOperation = receiptOf(cat).operationId;
      const content = await context.cli.ok<{ text: string }>(
        ["run", "output", catOperation],
        "read file",
      );
      expectThat(
        content.result.text.trim() === "orkestrator-ok",
        "the agent did not produce the expected file",
      );
      const sessionId = (started.envelope as { result: { sessionId: string } }).result.sessionId;
      const transcript = await context.cli.ok<{ messages: unknown[] }>(
        ["session", "transcript", sessionId, "--limit", "10"],
        "transcript",
      );
      expectThat(transcript.result.messages.length > 0, "transcript is empty");
      const followPrompt = path.join(context.root, "live-follow.txt");
      await writeFile(followPrompt, "Reply with the single word: done. Do not change any files.\n");
      const follow = await context.cli.run(
        [
          "--json",
          "session",
          "prompt",
          sessionId,
          "--prompt-file",
          followPrompt,
          "--wait",
          "--timeout",
          "5m",
          "--request-id",
          "live-follow",
        ],
        { stage: "follow-up --wait", timeoutMs: 6 * 60_000 },
      );
      expectThat(
        (follow.envelope?.receipt as PublicReceipt)?.state === "succeeded",
        "follow-up did not complete",
      );
    },
  },
];

export async function listFiles(directory: string): Promise<string[]> {
  return readdir(directory).catch(() => []);
}

export async function readText(file: string): Promise<string> {
  return readFile(file, "utf8");
}
