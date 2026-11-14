import { REVIEW_QUALIFICATION_COMMIT } from "./container-fake-claude-install";
import { NO_CODE_MODE_STEP } from "./container-fake-codex-review-api";
import { expect, test, type TestInfo, type Page } from "./browser-test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import { DEFAULT_CODEX_MODEL_ID } from "@orkestrator/protocol/codex-model-catalog";
import { loadAppWithDevRetry } from "./dev-startup-retry";

/**
 * The Codex read-only container canary (to-do 7872, task 1): a
 * Multi Review with Codex reviewers, consolidation and preparation in a
 * container environment, on the image's real `codex` and a scripted fake
 * Responses API on the container's loopback. No login and no billed turn.
 *
 * In a container Codex's command sandbox cannot run (bubblewrap needs a user
 * namespace the container refuses), so each read-only turn runs
 * `danger-full-access` under `untrusted`: the bridge's exec-policy rules let
 * Codex run a fixed set of reading programs without asking, and the bridge
 * declines every approval the turn asks for. The fake
 * (`container-fake-codex-review-api.ts`) follows a reviewer's instructions:
 * it reads the package, runs `ls`, runs the package's `diffCommand` (which
 * the rules leave out, so it is declined), reads the sealed diff file
 * instead, tries a `touch` and an `apply_patch` (both declined) and submits
 * through the `orkestrator` MCP server. The case checks that the review
 * settles with every report, that each read-only step carries the
 * sandbox-off note in the snapshot and its inspector, that each turn's steps
 * ran or were declined as expected, and that nothing reached the checkout.
 * `bridges/codex-bridge/src/app-server/live-read-only-reviewer-turn.test.ts`
 * runs the same reviewer turn on the host against the pinned binary.
 *
 * Opt-in: `ORKESTRATOR_AGENT_TEST_DOCKER=1` and
 * `ORKESTRATOR_AGENT_TEST_FAKE_CODEX_REVIEW=1`, against a freshly started
 * profile: `--fixture --fixture-environments local,container
 * --no-agent-credentials --agent-platforms codex`. The container's Codex
 * reads the fake's `openai_base_url` and the fixture API key when its
 * app-server starts, so no Codex session may have run in `fixture-container`
 * before the case: run it alone, `mise run test:agent:docker --
 * container-multi-review-codex-read-only.spec.ts`, because other Docker
 * fixture specs start Codex there. Its containers must reach the profile's
 * agent tools server, where the reviewers submit: on a Linux host whose
 * firewall drops that traffic, run the profile on `mise run
 * docker:disposable -- start --host-loopback` (its `DOCKER_HOST` in this
 * process's environment as well), or use `--agent-tools-port` with a firewall rule
 * ([agent-testing.md](../../docs/development/agent-testing.md)).
 *
 * The fake's base URL goes into the container's own `~/.codex/config.toml`
 * and a made-up API key into its `~/.codex/auth.json`; both are restored
 * afterwards. Prompts, tool output and tokens never reach test output: the
 * fake logs step names and error flags.
 */

type Status = { status: string; browserUrl: string; testProject?: string };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Environment = { id: string; name: string; projectId: string; containerId?: string | null };

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const ENABLED =
  process.env.ORKESTRATOR_AGENT_TEST_DOCKER === "1" &&
  process.env.ORKESTRATOR_AGENT_TEST_FAKE_CODEX_REVIEW === "1";
const CONTAINER_NAME = "fixture-container";
const FAKE_PORT = 47_124;
const FAKE_SCRIPT = "/tmp/orkestrator-qa-fake-codex-review-api.ts";
const STEP_LOG = "/tmp/orkestrator-qa-codex-review-steps.jsonl";
const BACKUP_DIR = "/tmp/orkestrator-qa-codex-home-backup";
const SETTLED = new Set(["ready", "interactive", "completed", "failed", "cancelled"]);
/**
 * The fake scripts code mode's `exec` cells only, and Codex offers `exec` only
 * for a model its catalogue marks `code_mode_only`. Codex's own default is
 * one; `gpt-5.5`, which this spec used first, is not, so its preparation turn
 * answered "unsupported custom tool call: exec" (2026-11-14, to-do 7872).
 */
const MODEL = DEFAULT_CODEX_MODEL_ID;

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

/**
 * Starts the fake on the container's loopback and points the container's
 * Codex at it. The first backup survives an interrupted run; undo is
 * repeatable.
 */
async function installFakeCodexReviewApi(containerId: string): Promise<() => void> {
  const asNode = (script: string, input?: string) =>
    docker(["exec", "-i", "--user", "node", containerId, "sh", "-c", script], input);
  let serverPid = "";
  const undo = () => {
    try {
      if (/^\d+$/.test(serverPid)) {
        spawnSync("docker", ["exec", "--user", "node", containerId, "kill", serverPid], {
          timeout: 15_000,
        });
      }
    } finally {
      // A file that was absent before the run is removed again.
      asNode(
        `set -e; c="$HOME/.codex"; b=${BACKUP_DIR}; if [ -d "$b" ]; then for f in config.toml auth.json; do if [ -f "$b/$f" ]; then cat "$b/$f" > "$c/$f"; elif [ -f "$b/$f.absent" ]; then rm -f "$c/$f"; fi; done; rm -rf "$b"; fi; rm -f ${FAKE_SCRIPT}`,
      );
    }
  };
  try {
    asNode(
      `cat > ${FAKE_SCRIPT}`,
      readFileSync(path.join(import.meta.dirname, "container-fake-codex-review-api.ts"), "utf8"),
    );
    // Recorded at spawn, so cleanup signals exactly this process.
    serverPid = asNode(
      `bun ${FAKE_SCRIPT} --port ${FAKE_PORT} --log ${STEP_LOG} >/dev/null 2>&1 & echo $!`,
    );
    asNode(
      `set -e; c="$HOME/.codex"; b=${BACKUP_DIR}; mkdir -p "$c"; if [ ! -d "$b" ]; then mkdir -p "$b"; for f in config.toml auth.json; do if [ -f "$c/$f" ]; then cp "$c/$f" "$b/$f"; else touch "$b/$f.absent"; fi; done; fi`,
    );
    // A top-level key, so it goes before any table the image or Codex added.
    asNode(
      `set -e; c="$HOME/.codex"; b=${BACKUP_DIR}; { printf 'openai_base_url = "http://127.0.0.1:${FAKE_PORT}/v1"\\n'; if [ -f "$b/config.toml" ]; then grep -v '^openai_base_url = ' "$b/config.toml" || true; fi; } > "$c/config.toml.qa"; cat "$c/config.toml.qa" > "$c/config.toml"; rm -f "$c/config.toml.qa"`,
    );
    // Never a real key: the only server it can reach is the loopback fake.
    asNode(
      `set -e; umask 077; printf '%s' '{"auth_mode":"apikey","OPENAI_API_KEY":"sk-orkestrator-qa-fixture"}' > "$HOME/.codex/auth.json"`,
    );
    await expect
      .poll(
        () =>
          spawnSync(
            "docker",
            [
              "exec",
              containerId,
              "curl",
              "-s",
              "-o",
              "/dev/null",
              `http://127.0.0.1:${FAKE_PORT}/`,
            ],
            { timeout: 5_000 },
          ).status,
        { timeout: 15_000 },
      )
      .toBe(0);
  } catch (error) {
    undo();
    throw error;
  }
  return undo;
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

test.skip(!ENABLED, "Docker fixture profile and the fake Codex review API opt-in required");

test("Docker fixture Multi Review with Codex read-only reviewers runs without Codex's sandbox", async ({
  page,
}, testInfo) => {
  test.setTimeout(15 * 60_000);
  const status = profileCommand<Status>("dev:status");
  expect(status.status).toBe("ready");
  await page.setViewportSize({ width: 1440, height: 900 });
  // The profile has no host Codex login by design: the fake answers instead.
  await page.addLocatorHandler(
    page.getByRole("button", { name: "Continue Without Codex", exact: true }),
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
  const undo = await installFakeCodexReviewApi(containerId);
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
    const reviewer = { agent: "codex", model: MODEL };
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

    expect(
      stepLog(containerId).filter((record) => record.step === NO_CODE_MODE_STEP),
      `a scripted turn offered no code-mode exec tool: ${MODEL} is not code_mode_only in this Codex's catalogue`,
    ).toEqual([]);
    expect(workflow.phase, workflow.error ?? "").toBe("ready");
    const offNote = /^Codex's command sandbox cannot run commands in this container: /;
    for (const entry of workflow.reviewers) {
      expect(entry.status, entry.error ?? "").toBe("completed");
      expect(entry.commandSandboxOff).toMatch(offNote);
    }
    expect(workflow.stepRuntimes?.consolidate?.commandSandboxOff).toMatch(offNote);

    // Every reviewer turn: the reads ran through the bridge's rules, Git's
    // diff, the write and the patch were declined, and the submission was
    // accepted. A reviewer read the sealed diff instead of the refused diff.
    const records = stepLog(containerId);
    const reviews = finishedTurns(records, "review-report");
    expect(reviews).toHaveLength(2);
    for (const turn of reviews) {
      expect(turn).toEqual({
        package: false,
        list: false,
        git: true,
        "diff-file": false,
        "write-probe": true,
        patch: true,
        submit: false,
      });
    }
    const consolidations = finishedTurns(records, "consolidated-review");
    expect(consolidations).toHaveLength(1);
    // Without a package its Git step is `git rev-parse HEAD`, which the rules allow.
    const consolidation = consolidations[0]!;
    expect(consolidation).toMatchObject({
      list: false,
      git: "package" in consolidation,
      "write-probe": true,
      patch: true,
      submit: false,
    });

    // Nothing the declined calls asked for reached the checkout, and the
    // bridge's rules are in the container's Codex home.
    const check = docker([
      "exec",
      "--user",
      "node",
      "-w",
      "/workspace",
      containerId,
      "sh",
      "-c",
      'test ! -e .orkestrator-qa-read-only-probe && test ! -e .orkestrator-qa-read-only-patch && echo no-probe; test -f "$HOME/.codex/rules/orkestrator-read-only.rules" && echo rules',
    ]);
    expect(check.split(/\s+/)).toEqual(["no-probe", "rules"]);

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
      ["reviewer", /^Reviewer 1 · codex,/],
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
