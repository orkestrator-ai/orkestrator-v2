import { spawnSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PublicReceipt } from "@orkestrator/protocol/public-api";
import type {
  PublicChangesView,
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

/**
 * `changes view` reads the backend's own change projection. In a local
 * worktree a new file must show up in it with the backend's line count; a
 * container environment only proves the read answers its own resource.
 */
async function expectChangesView(
  context: ScenarioContext,
  environmentId: string,
  workspacePath: string | null,
): Promise<void> {
  if (context.environmentType !== "local" || !workspacePath) {
    const { result } = await context.cli.ok<PublicChangesView>(
      ["changes", "view", environmentId],
      "changes view",
    );
    expectThat(
      result.projection.resourceKey.startsWith("environment-net/"),
      "changes view answered another resource",
    );
    return;
  }
  await writeFile(path.join(workspacePath, "changes-probe.txt"), "one\ntwo\n");
  const deadline = Date.now() + 60_000;
  for (;;) {
    const { result } = await context.cli.ok<PublicChangesView>(
      ["changes", "view", environmentId],
      "changes view",
    );
    const probe = result.files.rows.find((row) => row.newPathDisplay === "changes-probe.txt");
    if (probe) {
      expectThat(
        probe.status === "added" && probe.additions.value === 2,
        "changes view reported the new file with the wrong status or count",
      );
      expectThat(
        result.projection.counters.changedFiles !== null &&
          result.projection.counters.changedFiles >= 1,
        "changes view counted no changed files",
      );
      return;
    }
    expectThat(Date.now() < deadline, "changes view never reported the new file");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
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
      await expectChangesView(context, environment.id, ready.workspacePath);
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
      // Exec has its own ORKESTRATOR_* filter. This checks that filter; the
      // backend startup regression is covered by inherited-agent-connection.test.ts.
      const inherited = await context.cli.run(
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
          'test -z "${ORKESTRATOR_AGENT_MCP_URL+x}${ORKESTRATOR_AGENT_MCP_TOKEN+x}"',
        ],
        { stage: "exec inherited agent connection" },
      );
      expectThat(inherited.code === 0, "a command inherited the parent agent tool connection");
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
    name: "project-cascade",
    description:
      "Cascade removal: a project with a started and a stopped environment is refused without --cascade, then removed with it; checkout and origin survive.",
    async run(context) {
      await configureConnection(context);
      const fixture = await addFixtureProject(context, "cascade");
      const started = await createEnvironment(context, fixture.projectId, "cascade-a");
      const stopped = await createEnvironment(context, fixture.projectId, "cascade-b");
      const ready = await context.cli.ok<{ environment: PublicEnvironmentSummary }>(
        ["environment", "start", started.id, "--wait", "ready", "--timeout", "3m"],
        "start one environment",
      );
      const refused = await context.cli.run(["--json", "project", "remove", fixture.projectId], {
        stage: "remove without cascade",
        expectCode: 8,
      });
      expectThat(
        refused.envelope && !refused.envelope.ok && refused.envelope.error.code === "not-empty",
        "a project with environments was not refused",
      );
      const removed = await context.cli.run(
        [
          "--json",
          "project",
          "remove",
          fixture.projectId,
          "--cascade",
          "--wait",
          "--timeout",
          "5m",
          "--request-id",
          "cascade-remove",
        ],
        { stage: "remove --cascade --wait", expectCode: 0, timeoutMs: 6 * 60_000 },
      );
      expectThat(receiptOf(removed).state === "succeeded", "cascade removal did not succeed");
      for (const environment of [started, stopped]) {
        await context.cli.run(["--json", "environment", "get", environment.id], {
          stage: "environment deleted by cascade",
          expectCode: 3,
        });
      }
      await context.cli.run(["--json", "project", "get", fixture.projectId], {
        stage: "project removed",
        expectCode: 3,
      });
      if (context.environmentType === "local" && ready.result.environment.workspacePath) {
        expectThat(
          !(await exists(ready.result.environment.workspacePath)),
          "the cascade left a worktree behind",
        );
      }
      expectThat(await exists(fixture.projectPath), "the cascade deleted the checkout");
      expectThat(
        git(fixture.projectPath, ["remote", "get-url", "origin"]) === fixture.originPath,
        "the cascade changed the checkout's origin",
      );
      const replay = await context.cli.run(
        [
          "--json",
          "project",
          "remove",
          fixture.projectId,
          "--cascade",
          "--request-id",
          "cascade-remove",
        ],
        { stage: "replay cascade key", expectCode: 0 },
      );
      expectThat(receiptOf(replay).replayed, "replaying the cascade key ran it again");
    },
  },
  {
    name: "project-init",
    description:
      "Local-only init: git init with one commit and no remote, registered; a local environment starts from its own branch.",
    environmentTypes: ["local"],
    async run(context) {
      await configureConnection(context);
      const target = path.join(context.root, "fixtures", "init-scratch");
      const { result } = await context.cli.ok<{ project: PublicProjectSummary }>(
        ["project", "init", "--path", target, "--request-id", "init-scratch"],
        "project init",
      );
      const projectId = result.project.id;
      context.cleanup.push({
        label: `remove project ${projectId}`,
        run: async () => {
          await context.cli.run(
            ["--json", "project", "remove", projectId, "--cascade", "--wait", "--timeout", "3m"],
            { stage: "cleanup init project" },
          );
        },
      });
      expectThat(git(target, ["rev-list", "--count", "HEAD"]) === "1", "init made no commit");
      expectThat(git(target, ["remote"]) === "", "init configured a remote");
      const environment = await createEnvironment(context, projectId, "init-env");
      const started = await context.cli.ok<{ environment: PublicEnvironmentSummary }>(
        ["environment", "start", environment.id, "--wait", "ready", "--timeout", "3m"],
        "start an environment of the local-only project",
      );
      const workspace = started.result.environment.workspacePath;
      expectThat(workspace && (await exists(workspace)), "no worktree was created");
      expectThat(
        git(workspace!, ["rev-parse", "HEAD"]) === git(target, ["rev-parse", "HEAD"]),
        "the worktree did not start from the repository's own main",
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
      await liveCommandSurface(context, sessionId);
    },
  },
];

/**
 * The live half of the post-release command surface: the session's command
 * catalogue, refusals that never send text, a selected project command
 * (Claude), --literal, --attach and --enqueue behind a running turn.
 */
async function liveCommandSurface(context: ScenarioContext, sessionId: string): Promise<void> {
  const listed = await context.cli.ok<{
    catalogue: { status: string };
    commands: Array<{ id: string; name: string; bindingRevision: string | null }>;
  }>(["session", "commands", sessionId, "--refresh"], "session commands --refresh", {
    timeoutMs: 3 * 60_000,
  });
  const unknown = await context.cli.run(
    ["--json", "session", "command", sessionId, "--command", "/ork-no-such-command"],
    { stage: "unknown command refused", expectCode: 3 },
  );
  expectThat(!maybeReceipt(unknown), "an unknown command was admitted");
  const listedCommand = listed.result.commands.find(
    (entry) => entry.bindingRevision && !entry.id.startsWith("orkestrator:"),
  );
  if (listedCommand) {
    await context.cli.run(
      [
        "--json",
        "session",
        "command",
        sessionId,
        "--command",
        listedCommand.id,
        "--expected-binding-revision",
        "stale-revision",
      ],
      { stage: "changed command refused", expectCode: 8 },
    );
  }
  if (context.provider === "claude") {
    // A built-in Claude Code command answered without a model turn.
    const selected = listed.result.commands.find((entry) => entry.name === "/context");
    expectThat(
      selected,
      `Claude's /context is not listed (${listed.result.catalogue.status}): ${listed.result.commands
        .map((entry) => entry.name)
        .join(" ")
        .slice(0, 1500)}`,
    );
    const ran = await context.cli.run(
      [
        "--json",
        "session",
        "command",
        sessionId,
        "--command",
        selected!.id,
        "--expected-binding-revision",
        selected!.bindingRevision ?? "",
        "--wait",
        "--timeout",
        "3m",
        "--request-id",
        "live-command",
      ],
      { stage: "session command --wait", timeoutMs: 4 * 60_000 },
    );
    const receipt = receiptOf(ran);
    expectThat(
      receipt.state === "succeeded",
      `the selected command ended ${receipt.state}: ${receipt.error?.message ?? ""} ${receipt.execution?.reason ?? ""}`.trim(),
    );
  }
  const literal = await context.cli.run(
    [
      "--json",
      "session",
      "prompt",
      sessionId,
      "--literal",
      "--prompt",
      "/srv is just a directory name here. Reply with the single word: literal-ok",
      "--wait",
      "--timeout",
      "5m",
      "--request-id",
      "live-literal",
    ],
    { stage: "prompt --literal --wait", timeoutMs: 6 * 60_000 },
  );
  expectThat(receiptOf(literal).state === "succeeded", "the literal prompt did not complete");
  const note = path.join(context.root, "attached-note.txt");
  await writeFile(note, "The secret word is: marigold\n");
  const attached = await context.cli.run(
    [
      "--json",
      "session",
      "prompt",
      sessionId,
      "--attach",
      note,
      "--prompt",
      "Reply with only the secret word from the attached file. Do not change any files.",
      "--wait",
      "--timeout",
      "5m",
      "--request-id",
      "live-attach",
    ],
    { stage: "prompt --attach --wait", timeoutMs: 6 * 60_000 },
  );
  const refusedFile =
    attached.code === 8 &&
    attached.envelope &&
    !attached.envelope.ok &&
    attached.envelope.error.code === "capability-unavailable";
  // Codex, Cursor and Grok take image attachments only: a text file is
  // refused before admission, which is the behaviour to check there.
  if (!refusedFile) {
    expectThat(
      receiptOf(attached).state === "succeeded",
      "the prompt with an attachment did not complete",
    );
    const transcript = await context.cli.ok<{ messages: Array<{ role: string; text: string }> }>(
      ["session", "transcript", sessionId, "--limit", "4"],
      "transcript after attachment",
    );
    expectThat(
      transcript.result.messages.some((message) => /marigold/i.test(message.text)),
      "the agent did not read the attached file",
    );
  } else {
    expectThat(!maybeReceipt(attached), "a refused attachment was admitted");
  }
  // A running turn, then a prompt queued behind it.
  const busy = await context.cli.run(
    [
      "--json",
      "session",
      "prompt",
      sessionId,
      "--prompt",
      "Run the shell command `sleep 20`, then reply with the single word: slept. Do not change any files.",
      "--request-id",
      "live-busy",
    ],
    { stage: "start a slow turn", expectCode: 0 },
  );
  const refused = await context.cli.run(
    ["--json", "session", "prompt", sessionId, "--prompt", "too early"],
    { stage: "busy prompt refused", expectCode: 8 },
  );
  expectThat(
    refused.envelope && !refused.envelope.ok && refused.envelope.error.code === "busy",
    "a busy session accepted an ordinary prompt",
  );
  const queued = await context.cli.run(
    [
      "--json",
      "session",
      "prompt",
      sessionId,
      "--enqueue",
      "--prompt",
      "Reply with the single word: queued-ok. Do not change any files.",
      "--wait",
      "--timeout",
      "8m",
      "--request-id",
      "live-enqueue",
    ],
    { stage: "prompt --enqueue --wait", timeoutMs: 9 * 60_000 },
  );
  expectThat(receiptOf(queued).state === "succeeded", "the queued prompt did not complete");
  const first = await context.cli.ok<unknown>(
    ["run", "get", receiptOf(busy).operationId],
    "the slow turn settled first",
  );
  expectThat(
    (first.envelope.receipt as PublicReceipt | undefined)?.state === "succeeded",
    "the queued prompt overtook the running turn",
  );
}

function maybeReceipt(result: CliResult): PublicReceipt | undefined {
  return result.envelope?.receipt;
}

export async function listFiles(directory: string): Promise<string[]> {
  return readdir(directory).catch(() => []);
}

export async function readText(file: string): Promise<string> {
  return readFile(file, "utf8");
}
