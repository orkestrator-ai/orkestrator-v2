import {
  installFakeClaudeApiFixture,
  REVIEW_QUALIFICATION_COMMIT,
} from "./container-fake-claude-install";
import { expect, test, type TestInfo, type Page } from "./browser-test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import { loadAppWithDevRetry } from "./dev-startup-retry";

/**
 * A Multi Review with Claude read-only reviewers and a Claude consolidation in
 * a container environment, on the image's real `claude` CLI and a scripted
 * fake Messages API on the container's loopback: no login and no billed turn
 * (to-do 0190 task 3).
 *
 * The image ships neither bubblewrap nor socat, so every read-only turn runs
 * without the CLI's command sandbox, on the read-only command hook alone. The
 * fake (`container-fake-claude-review-api.ts`) follows a reviewer's
 * instructions: it reads the package, runs `ls`, runs the package's
 * `diffCommand` (which the hook must refuse: Git without the sandbox can run
 * repository helpers), reads the sealed diff file instead, tries a write
 * (refused) and submits. The case checks that the review settles with every
 * report, that the reviewers and consolidation carry the sandbox-off note in
 * the snapshot and in their inspectors, that the diff file holds what
 * `diffCommand` prints, and that no write reached the checkout.
 *
 * Opt-in: `ORKESTRATOR_AGENT_TEST_DOCKER=1` and
 * `ORKESTRATOR_AGENT_TEST_FAKE_CLAUDE_REVIEW=1`, against a profile started
 * with `--fixture --fixture-environments local,container
 * --no-agent-credentials --agent-platforms claude`. Its containers must reach
 * the profile's agent tools server, where the reviewers submit: on a Linux
 * host whose firewall drops that traffic, run the profile on
 * `mise run docker:disposable -- start --host-loopback` (its `DOCKER_HOST`
 * in this process's environment as well), or use `--agent-tools-port` with a
 * firewall rule ([agent-testing.md](../../docs/development/agent-testing.md)).
 *
 * The fake's base URL and token are staged as Claude managed settings
 * (`/etc/claude-code`) in the container, which every turn reads, and removed
 * afterwards. (Read-only turns take only the user settings' connection `env`
 * since to-do 7565, and the entrypoint rewrites that file at container start.) The case also commits one file to the
 * fixture branch so there is something to review. Prompts, tool output and
 * tokens never reach test output: the fake logs step names and error flags.
 */

type Status = { status: string; browserUrl: string; testProject?: string };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Environment = { id: string; name: string; projectId: string; containerId?: string | null };

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const ENABLED =
  process.env.ORKESTRATOR_AGENT_TEST_DOCKER === "1" &&
  process.env.ORKESTRATOR_AGENT_TEST_FAKE_CLAUDE_REVIEW === "1";
const CONTAINER_NAME = "fixture-container";
const STEP_LOG = "/tmp/orkestrator-qa-review-steps.jsonl";
const MANAGED_SETTINGS = "/etc/claude-code/managed-settings.json";
const FAKE_PORT = 47_123;
const SETTLED = new Set(["ready", "interactive", "completed", "failed", "cancelled"]);

type StepRecord = {
  kind: string;
  step: string;
  answered: Array<{ step: string | null; error: boolean }>;
};

function profileCommand<T>(command: string): T {
  const result = spawnSync("mise", ["run", command, "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed`);
  return JSON.parse(result.stdout) as T;
}

function docker(args: string[], input?: string): string {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 30_000, input });
  if (result.status !== 0) throw new Error(`docker ${args.slice(0, 2).join(" ")} failed`);
  return result.stdout.trim();
}

async function login(page: Page, testInfo: TestInfo, status: Status): Promise<Invoke> {
  // The one-shot login URL is parsed in memory and never copied into output.
  const { loginUrl } = profileCommand<{ loginUrl?: unknown }>("dev:login");
  if (typeof loginUrl !== "string") throw new Error("dev:login returned no login URL");
  await loadAppWithDevRetry(page, testInfo, () =>
    page.goto(loginUrl, { waitUntil: "domcontentloaded" }),
  );
  const request = page.context().request;
  return async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await request.post(new URL("/__orkestrator/invoke", status.browserUrl).href, {
      data: { command, args },
    });
    expect(response.ok(), `${command} failed`).toBe(true);
    return ((await response.json()) as { result: T }).result;
  };
}

/** The fake on the container's loopback, for the CLI's settings-reading and read-only turns alike. */
async function installFakeReviewApi(containerId: string): Promise<() => void> {
  const asNode = (script: string, input?: string) =>
    docker(["exec", "-i", "--user", "node", containerId, "sh", "-c", script], input);
  const managed = JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${FAKE_PORT}`,
      ANTHROPIC_AUTH_TOKEN: "orkestrator-qa-fixture",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
  });
  let serverPid = "";
  return installFakeClaudeApiFixture({
    installAdditional: () => {
      docker(
        [
          "exec",
          "-i",
          "--user",
          "root",
          containerId,
          "sh",
          "-c",
          `mkdir -p ${path.posix.dirname(MANAGED_SETTINGS)} && cat > ${MANAGED_SETTINGS} && chmod 644 ${MANAGED_SETTINGS}`,
        ],
        managed,
      );
    },
    undoAdditional: () => {
      spawnSync("docker", ["exec", "--user", "root", containerId, "rm", "-f", MANAGED_SETTINGS], {
        timeout: 15_000,
      });
    },
    asNode,
    startServer: (args) => {
      // Recorded at spawn, so cleanup signals exactly this process.
      serverPid = asNode(`${args.map((arg) => `'${arg}'`).join(" ")} >/dev/null 2>&1 & echo $!`);
    },
    stopServer: () => {
      if (/^\d+$/.test(serverPid)) {
        spawnSync("docker", ["exec", "--user", "node", containerId, "kill", serverPid], {
          timeout: 15_000,
        });
      }
    },
    source: readFileSync(
      path.join(import.meta.dirname, "container-fake-claude-review-api.ts"),
      "utf8",
    ),
    serverArgs: ["--log", STEP_LOG],
    waitUntilReady: async () => {
      await expect
        .poll(
          () =>
            spawnSync(
              "docker",
              [
                "exec",
                containerId,
                "curl",
                "-fsS",
                "-o",
                "/dev/null",
                "-X",
                "POST",
                "-d",
                "{}",
                `http://127.0.0.1:${FAKE_PORT}/v1/messages/count_tokens`,
              ],
              { timeout: 5_000 },
            ).status,
          { timeout: 15_000 },
        )
        .toBe(0);
    },
  });
}

function stepLog(containerId: string): StepRecord[] {
  const text = spawnSync("docker", ["exec", containerId, "cat", STEP_LOG], {
    encoding: "utf8",
    timeout: 15_000,
  }).stdout;
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StepRecord);
}

/** The last request of each scripted turn of `kind`: its answered steps, in order. */
function finishedTurns(records: StepRecord[], kind: string) {
  return records
    .filter((record) => record.kind === kind && record.step === "text")
    .map((record) => Object.fromEntries(record.answered.map((entry) => [entry.step, entry.error])));
}

test.skip(!ENABLED, "Docker fixture profile and the fake Claude review API opt-in required");

test("Docker fixture Multi Review with Claude read-only reviewers runs without the command sandbox", async ({
  page,
}, testInfo) => {
  test.setTimeout(15 * 60_000);
  const status = profileCommand<Status>("dev:status");
  expect(status.status).toBe("ready");
  await page.setViewportSize({ width: 1440, height: 900 });
  // The profile has no host Claude login by design: the fake answers instead.
  await page.addLocatorHandler(
    page.getByRole("button", { name: "Continue Without Claude", exact: true }),
    (button) => button.click(),
  );
  const invoke = await login(page, testInfo, status);

  let container: Environment | undefined;
  for (const project of await invoke<Array<{ id: string }>>("get_projects")) {
    const environments = await invoke<Environment[]>("get_environments", {
      projectId: project.id,
    });
    container ??= environments.find((entry) => entry.name === CONTAINER_NAME);
  }
  expect(container?.containerId, `${CONTAINER_NAME} has no container`).toBeTruthy();
  const containerId = container!.containerId!;
  // An earlier run's log would be counted as this run's turns.
  docker(["exec", "--user", "node", containerId, "rm", "-f", STEP_LOG]);
  const undo = await installFakeReviewApi(containerId);
  try {
    docker([
      "exec",
      "--user",
      "node",
      "-w",
      "/workspace",
      containerId,
      "sh",
      "-c",
      REVIEW_QUALIFICATION_COMMIT,
    ]);
    const reviewer = { agent: "claude", model: "haiku" };
    const started = await invoke<MultiReviewWorkflow>("start_multi_review", {
      environmentId: container!.id,
      projectId: container!.projectId,
      targetBranch: "main",
      reviewers: [reviewer, reviewer],
      reviewModel: reviewer,
      fixModel: reviewer,
    });
    let workflow = started;
    await expect
      .poll(
        async () => {
          workflow = (
            await invoke<{ snapshot: MultiReviewWorkflow }>("get_multi_review_workflow", {
              workflowId: started.id,
            })
          ).snapshot;
          return SETTLED.has(workflow.phase);
        },
        { timeout: 10 * 60_000, intervals: [2_000] },
      )
      .toBe(true);

    expect(workflow.phase, workflow.error ?? "").toBe("ready");
    const offNote = /^Claude's command sandbox cannot run commands in this container: /;
    for (const entry of workflow.reviewers) {
      expect(entry.status, entry.error ?? "").toBe("completed");
      expect(entry.commandSandboxOff).toMatch(offNote);
      expect(entry.commandSandboxOff).not.toContain("Install the");
    }
    expect(workflow.stepRuntimes?.consolidate?.commandSandboxOff).toMatch(offNote);

    // Every read-only turn: a plain command ran, Git and the write were
    // refused by the hook, and the submission was accepted. A reviewer read
    // the sealed diff instead of the refused diffCommand.
    const records = stepLog(containerId);
    const reviews = finishedTurns(records, "review-report");
    expect(reviews).toHaveLength(2);
    for (const turn of reviews) {
      expect(turn).toMatchObject({
        package: false,
        list: false,
        git: true,
        "diff-file": false,
        "write-probe": true,
        submit: false,
      });
    }
    const consolidations = finishedTurns(records, "consolidated-review");
    expect(consolidations).toHaveLength(1);
    expect(consolidations[0]).toMatchObject({
      list: false,
      git: true,
      "write-probe": true,
      submit: false,
    });

    // The sealed diff holds exactly what the package's diffCommand prints.
    const check = docker([
      "exec",
      "--user",
      "node",
      "-w",
      "/workspace",
      containerId,
      "sh",
      "-c",
      'p=$(ls -t .orkestrator/review-artifacts/*/review-package-*.json | head -1); d=$(jq -r .diffArtifact.path "$p"); printf "%s %s %s\\n" "$(jq -r .diffArtifact.sha256 "$p")" "$(sha256sum < "$d" | cut -c1-64)" "$(sh -c "$(jq -r .diffCommand "$p")" | sha256sum | cut -c1-64)"; test ! -e .orkestrator-qa-read-only-probe && echo no-probe',
    ]);
    const [recorded, onDisk, reproduced, probe] = check.split(/\s+/);
    expect(onDisk).toBe(recorded);
    expect(reproduced).toBe(recorded);
    expect(probe).toBe("no-probe");

    // What the user sees: the note on the reviewer's and the consolidation's inspector.
    await page.goto(status.browserUrl);
    const expand = page.getByRole("button", { name: /^Expand project / }).first();
    const collapse = page.getByRole("button", { name: /^Collapse project / }).first();
    await expect(expand.or(collapse)).toBeVisible({ timeout: 30_000 });
    if (await expand.isVisible()) await expand.click();
    await page.mouse.move(1100, 20);
    await page.getByText(CONTAINER_NAME, { exact: true }).first().click();
    await page.getByRole("button", { name: "Multi Review", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Multi Review", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    const pipeline = page.getByRole("tablist", { name: "Multi Review pipeline" }).first();
    const inspector = page.getByTestId("multi-review-inspector");
    for (const [name, node] of [
      ["reviewer", /^Reviewer 1 · claude,/],
      ["consolidation", /^Consolidation,/],
    ] as const) {
      await pipeline.getByRole("tab", { name: node }).click();
      await expect(inspector).toContainText("Commands run without the command sandbox");
      await expect(inspector).toContainText("in this container");
      await testInfo.attach(`${name}-inspector`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    }
  } finally {
    undo();
  }
});
