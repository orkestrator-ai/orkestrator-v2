/**
 * `/subork` end to end on every provider, as a caller and as a target (to-do
 * 4340 task 1, `docs/architecture/suborks.md`). Opt-in: skipped unless
 * `ORKESTRATOR_AGENT_TEST_SUBORKS=1`.
 *
 * For each platform in `ORKESTRATOR_AGENT_TEST_SUBORK_PLATFORMS` that the
 * profile enables, in order, one native tab of a fresh fixture environment
 * types `/subork ask <targets> …`. The next platform in the list is always a
 * target, so every platform is asked once and asks once. The case checks
 * the durable truth a reload reads:
 *
 * - the caller reached `ask_agents` and the call's row holds one subork per
 *   target, on the agent named, each `finished` with the read-only tier the
 *   enforcement matrix gives it (and the guard below `enforced`);
 * - the delivery is `sent`, and the caller was woken by it into a new turn
 *   that settles idle.
 *
 * Two modes:
 *
 * - **Scripted (default for `mise run test:agent:suborks`,
 *   `ORKESTRATOR_AGENT_TEST_SUBORKS_FAKE=1`).** Pi and OpenCode run on the
 *   profile's real bridge and server against `suborks-fake-model.ts`, which
 *   the spec points the profile's own Pi and OpenCode settings at. Each
 *   caller asks itself and the other, so a call has two targets on two
 *   providers. The fake also reports that each target submitted through
 *   `submit_subork_answer` and that the caller was woken exactly once, with
 *   both answers. Nothing logs in and nothing is billed. Claude, Codex,
 *   Cursor and Grok have no scripted model that reaches a profile's own
 *   bridge, so the scripted run covers Pi and OpenCode only.
 * - **Live (`ORKESTRATOR_AGENT_TEST_SUBORKS_FAKE` unset).** Real models on
 *   the host's credentials, all six platforms by default, one target per
 *   call. Real turns cost tokens; this mode is on the manual-test checklist
 *   (7568, 4340 task 1). `ORKESTRATOR_AGENT_TEST_SUBORK_ENVIRONMENT=container`
 *   runs it in a container environment instead of a local one.
 *
 * Live, against a profile started by hand:
 *
 *   mise run dev:test --profile qa-suborks --fixture --headless
 *   ORKESTRATOR_AGENT_TEST_PROFILE=qa-suborks ORKESTRATOR_AGENT_TEST_SUBORKS=1 \
 *     bunx playwright test --config e2e/agent-testing/playwright.suborks.config.ts \
 *     suborks-live.spec.ts
 *
 * Writes a content-free summary to
 * `output/agent-testing/<run>/suborks/summary.json`: agents, statuses, tiers,
 * delivery states, counts and timings, never a prompt or an answer.
 */
import { expect, test } from "./browser-test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  authenticatedInvoke,
  profileStatus,
  repositoryRoot,
  type Environment,
  type Project,
} from "./slash-command-live-support";
import { suborkRequest } from "./suborks-fake-model-script";
import {
  ALL_PLATFORMS,
  FAKE_MODEL_REF,
  describeProjection,
  keepProfileLogs,
  newTag,
  openTabs,
  rowText,
  sendSubork,
  startScriptedModel,
  until,
  type Platform,
  type Projection,
  type ScriptedModel,
} from "./suborks-live-support";

// Backend calls carry the disposable profile's token; keep it out of artifacts.
test.use({ trace: "off", screenshot: "off", video: "off" });

const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "qa-suborks";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;
const ENABLED = process.env.ORKESTRATOR_AGENT_TEST_SUBORKS === "1";
const SCRIPTED = process.env.ORKESTRATOR_AGENT_TEST_SUBORKS_FAKE === "1";
const IN_CONTAINER = process.env.ORKESTRATOR_AGENT_TEST_SUBORK_ENVIRONMENT === "container";
const SCRIPTED_DEFAULT: readonly Platform[] = ["pi", "opencode"];
const requested = (process.env.ORKESTRATOR_AGENT_TEST_SUBORK_PLATFORMS ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const PLATFORMS: Platform[] = (
  requested.length > 0 ? requested : SCRIPTED ? SCRIPTED_DEFAULT : ALL_PLATFORMS
).filter((name): name is Platform => (ALL_PLATFORMS as readonly string[]).includes(name));
const CALL_TIMEOUT_MS = SCRIPTED ? 240_000 : 900_000;

const outputDirectory = path.join(repositoryRoot, "output", "agent-testing", runId, "suborks");

function writeSummary(summary: Record<string, unknown>): void {
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(
    path.join(outputDirectory, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
}

/**
 * The read-only tiers `docs/architecture/suborks.md` gives a subork on the host.
 * Claude is `enforced` only where its sandbox can run commands.
 */
const HOST_TIERS: Record<Platform, readonly string[]> = {
  claude: ["enforced", "provider-configured"],
  codex: ["enforced"],
  pi: ["enforced"],
  cursor: ["provider-configured"],
  opencode: ["provider-configured"],
  grok: ["advisory"],
};

test.describe("/subork on every provider", () => {
  test.skip(!ENABLED, "opt-in: ORKESTRATOR_AGENT_TEST_SUBORKS=1");
  test.skip(SCRIPTED && IN_CONTAINER, "the scripted model listens on the host's loopback only");
  test.setTimeout(SCRIPTED ? 1_200_000 : 7_200_000);

  test("each provider asks the next, and the answers wake it", async ({ page }) => {
    page.setDefaultTimeout(15_000);
    const status = profileStatus(profile);
    expect(status.status, `profile "${profile}" is not running`).toBe("ready");
    const invoke = await authenticatedInvoke(page, status, profile);
    const config = await invoke<{ global?: { enabledAgentPlatforms?: string[] } }>("get_config");
    const enabled = config?.global?.enabledAgentPlatforms;
    const platforms = PLATFORMS.filter((name) => !Array.isArray(enabled) || enabled.includes(name));
    const skipped = PLATFORMS.filter((name) => !platforms.includes(name));
    expect(
      platforms.length,
      `none of ${PLATFORMS.join(", ")} is enabled in "${profile}"`,
    ).toBeGreaterThan(0);
    const fixture = (await invoke<Project[]>("get_projects")).find(
      (project) => project.localPath === status.testProject,
    );
    expect(fixture, `the ${profile} fixture project is missing`).toBeTruthy();

    const summary: Record<string, unknown> = {
      mode: SCRIPTED ? "scripted" : "live",
      environment: IN_CONTAINER ? "container" : "local",
      platforms,
      notEnabled: skipped,
      cases: [] as unknown[],
    };
    let model: ScriptedModel | undefined;
    let environmentId: string | undefined;
    try {
      if (SCRIPTED) model = await startScriptedModel(status, invoke);
      const environment = await invoke<Environment>("create_environment", {
        projectId: fixture!.id,
        name: `suborks-${Date.now()}`,
        networkAccessMode: "restricted",
        environmentType: IN_CONTAINER ? "containerized" : "local",
      });
      environmentId = environment.id;
      await invoke("start_environment", { environmentId });
      const started = await invoke<Environment>("get_environment", { environmentId });
      const container = IN_CONTAINER ? (started.containerId ?? null) : null;
      if (IN_CONTAINER)
        expect(container, "the container environment has no container").toBeTruthy();
      const tabs = await openTabs(invoke, environmentId, platforms, container);

      for (const [index, caller] of platforms.entries()) {
        const next = platforms[(index + 1) % platforms.length]!;
        // Scripted calls ask two providers at once; live calls one, to keep the bill small.
        const targets = SCRIPTED ? [...new Set([caller, next])] : [next];
        const tag = newTag();
        const identity = tabs.get(caller)!;
        const projection = () =>
          invoke<Projection>("get_native_agent_projection", { ...identity, messageLimit: 200 });
        const startedAt = Date.now();
        await test.step(`${caller} asks ${targets.join(" and ")}`, async () => {
          await sendSubork(
            invoke,
            identity,
            suborkRequest(targets, tag),
            SCRIPTED ? FAKE_MODEL_REF : undefined,
          );
          const settled = await until(
            `${caller}'s subork call to settle`,
            projection,
            (view) => view?.suborks?.some((batch) => batch.status !== "running") ?? false,
            CALL_TIMEOUT_MS,
            describeProjection,
          );
          const batch = settled!.suborks!.find((candidate) => candidate.status !== "running")!;
          const settledAt = Date.now();
          const rowsAtSettle = settled?.messages?.length ?? 0;
          expect(batch.status, "the call was stopped").toBe("settled");
          expect(batch.suborks.map((subork) => subork.agent).sort()).toEqual([...targets].sort());
          for (const subork of batch.suborks) {
            expect(subork.status, `${subork.agent} did not finish: ${subork.line ?? ""}`).toBe(
              "finished",
            );
            if (container === null) {
              expect(HOST_TIERS[subork.agent as Platform]).toContain(subork.readOnly);
            }
            // The workspace guard covers every tier below `enforced`.
            expect(Boolean(subork.guarded), `${subork.agent}'s guard`).toBe(
              subork.readOnly !== "enforced",
            );
          }
          expect(batch.delivery, batch.deliveryDetail ?? "").toBe("sent");

          // The mail wakes the caller into a new turn that settles.
          const woken = await until(
            `${caller} to be woken by the answers`,
            projection,
            (view) => {
              if (view?.turn.phase !== "idle") return false;
              const rows = view.messages ?? [];
              if (SCRIPTED) {
                return rows.some(
                  (row) =>
                    row.role === "assistant" &&
                    rowText(row).includes(`ANSWERS-RECEIVED ${tag} ${targets.length}`),
                );
              }
              return rows.length > rowsAtSettle && rows.at(-1)?.role === "assistant";
            },
            CALL_TIMEOUT_MS,
            describeProjection,
          );
          const record: Record<string, unknown> = {
            caller,
            targets,
            suborks: batch.suborks.map((subork) => ({
              agent: subork.agent,
              status: subork.status,
              readOnly: subork.readOnly,
              guarded: Boolean(subork.guarded),
              tokens: subork.tokens,
              transcriptStored: subork.transcriptRevision !== undefined,
            })),
            delivery: batch.delivery,
            settleMs: settledAt - startedAt,
            wakeMs: Date.now() - startedAt,
            rowsAfterWake: woken?.messages?.length,
          };
          if (model) {
            const calls = await model.calls();
            const turns = calls.turns.filter((turn) => turn.tag === tag);
            const callerStarts = turns.filter((turn) => turn.role === "caller" && turn.turnStart);
            const wakes = turns.filter((turn) => turn.role === "wake" && turn.turnStart);
            const targetStarts = turns.filter((turn) => turn.role === "target" && turn.turnStart);
            expect(callerStarts, "the /subork turn started once").toHaveLength(1);
            expect(callerStarts[0]?.platform).toBe(caller);
            expect(
              callerStarts[0]?.offersAskAgents,
              "ask_agents was not offered to the caller",
            ).toBe(true);
            expect(new Set(targetStarts.map((turn) => turn.platform))).toEqual(new Set(targets));
            expect(wakes, "the caller was woken more or less than once").toHaveLength(1);
            expect(wakes[0]?.answers?.sort()).toEqual([...targets].sort());
            record.fake = {
              targetTurnStarts: targetStarts.length,
              suborksOfferedAskAgents: targetStarts
                .filter((turn) => turn.offersAskAgents)
                .map((turn) => turn.platform),
              wakeTurns: wakes.length,
              refused: calls.refused,
            };
          }
          (summary.cases as unknown[]).push(record);
        });
      }
      summary.result = "passed";
    } catch (error) {
      summary.result = "failed";
      keepProfileLogs(profile, test.info().outputPath("profile-logs"));
      throw error;
    } finally {
      writeSummary(summary);
      if (environmentId) {
        await invoke("stop_environment", { environmentId }).catch(() => undefined);
        await invoke("delete_environment", { environmentId }).catch(() => undefined);
      }
      await model?.stop();
    }
  });
});
