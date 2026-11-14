import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PublicReceipt } from "@orkestrator/protocol/public-api";
import type { PublicTranscriptMessage } from "@orkestrator/protocol/public-api-resources";
import { defaultConfig } from "../../../apps/backend/src/core/storage-shared-config.js";
import { mergeOpenCodeFakeProvider } from "../../../e2e/agent-testing/opencode-fake-provider.js";
import { ScriptedModel } from "../../../scripts/opencode2-steer-probe.js";
import {
  addFixtureProject,
  createEnvironment,
  receiptOf,
  type ScenarioDefinition,
} from "./cases.js";
import {
  configureConnection,
  expectThat,
  type ScenarioContext,
  type ScenarioPaths,
} from "./harness.js";

/**
 * OpenCode steer through the public CLI on a scripted model (to-do 7905
 * task 4): no credentials, no remote model, nothing billed.
 *
 * The scenario backend gets the pinned OpenCode binaries (installed into its
 * own data directory) and a global OpenCode configuration whose only
 * provider is `ScriptedModel` on loopback (`scripts/opencode2-steer-probe.ts`),
 * admitted by Orkestrator's OpenCode provider allowlist. The model holds the
 * turn's first request open, so the steer always lands while the turn runs:
 *
 * - `session steer` on the running turn is accepted under its request key;
 * - the same command again under the same key replays the same operation and
 *   sends nothing more, and a different text under that key is a conflict;
 * - the turn ends on the steer's reply, and the model saw the steer once.
 *
 *   mise run test:cli:scenarios -- --scenario opencode-steer
 */

const FAKE = {
  provider: "ork-scripted",
  providerName: "Scenario scripted model",
  model: "scripted-1",
  modelName: "Scripted 1",
};
const PROMPT = "HOLD_FOR_STEER first turn";
const STEER = "STEER_FROM_CLI";

let model: ScriptedModel | undefined;
let release: (() => void) | undefined;

async function until<T>(
  label: string,
  read: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 120_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    expectThat(Date.now() < deadline, `timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const turnCalls = (text: string) =>
  model?.calls.filter((call) => call.lastRole === "user" && call.userTexts.at(-1) === text)
    .length ?? 0;

async function steer(context: ScenarioContext, sessionId: string, text: string, stage: string) {
  return context.cli.run(
    ["--json", "session", "steer", sessionId, "--text", text, "--request-id", "opencode-steer-1"],
    { stage },
  );
}

/** The scenario backend's OpenCode configuration and Orkestrator settings. */
async function writeScenarioConfiguration(
  paths: Pick<ScenarioPaths, "xdgConfigHome" | "dataDir">,
  origin: string,
): Promise<void> {
  const configFile = path.join(paths.xdgConfigHome, "opencode", "opencode.json");
  await mkdir(path.dirname(configFile), { recursive: true, mode: 0o700 });
  await writeFile(
    configFile,
    mergeOpenCodeFakeProvider(undefined, { ...FAKE, baseUrl: `${origin}/v1` }),
    { mode: 0o600 },
  );
  // A connected provider outside Orkestrator's allowlist does not count as
  // signed in; a user with a custom provider adds it the same way.
  const config = defaultConfig();
  config.global.openCodeModelProviders = [
    ...(config.global.openCodeModelProviders ?? []),
    FAKE.provider,
  ];
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(paths.dataDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
}

export const OPENCODE_STEER_SCENARIO: ScenarioDefinition = {
  name: "opencode-steer",
  description:
    "Credential-free: steer a running OpenCode turn on a scripted model, retry its key, and see the turn end on the steer's reply once.",
  explicit: true,
  // The scripted model listens on the harness host's loopback, which a
  // container's own loopback cannot reach; a container run would need a
  // container-local model and its configuration.
  environmentTypes: ["local"],
  toolchainProvider: "opencode",
  async prepare(paths) {
    model = new ScriptedModel();
    let holding = true;
    model.hold = ({ texts, lastRole }) =>
      holding && lastRole === "user" && texts.at(-1) === PROMPT
        ? new Promise<void>((resolve) => {
            release = () => {
              holding = false;
              resolve();
            };
          })
        : undefined;
    const undo = async () => {
      release?.();
      model?.stop();
      model = undefined;
      release = undefined;
    };
    const origin = model.start();
    try {
      await writeScenarioConfiguration(paths, origin);
    } catch (error) {
      // The runner learns the undo only from a returned value, so a failed
      // write would otherwise leave the model listening for the whole run.
      await undo();
      throw error;
    }
    return undo;
  },
  async run(context) {
    await configureConnection(context);
    const fixture = await addFixtureProject(context, "opencode-steer");
    const environment = await createEnvironment(context, fixture.projectId, "opencode-steer");
    await context.cli.ok(
      ["environment", "start", environment.id, "--wait", "ready", "--timeout", "5m"],
      "start",
    );
    // A fresh installation has no catalogue; the scripted model must be in it.
    const options = await context.cli.ok<{
      agents: Array<{ agent: string; catalogue: { state: string; models: Array<{ id: string }> } }>;
    }>(
      ["agent", "options", "--environment", environment.id, "--refresh"],
      "agent options --refresh",
      { timeoutMs: 5 * 60_000 },
    );
    const catalogue = options.result.agents.find((agent) => agent.agent === "opencode")?.catalogue;
    expectThat(
      catalogue?.models.some((candidate) => candidate.id === `${FAKE.provider}/${FAKE.model}`),
      `the scripted model is not in the OpenCode catalogue (${catalogue?.state}: ${catalogue?.models
        .map((candidate) => candidate.id)
        .slice(0, 10)
        .join(", ")})`,
    );
    const promptFile = path.join(context.root, "opencode-steer-prompt.txt");
    await writeFile(promptFile, PROMPT);
    const started = await context.cli.ok<{ sessionId: string; runId: string }>(
      [
        "session",
        "start",
        "--environment",
        environment.id,
        "--agent",
        "opencode",
        "--model",
        `${FAKE.provider}/${FAKE.model}`,
        "--mode",
        "build",
        "--prompt-file",
        promptFile,
        "--request-id",
        "opencode-steer-start",
      ],
      "session start",
      { timeoutMs: 5 * 60_000 },
    );
    const { sessionId, runId } = started.result;
    expectThat(sessionId && runId, "session start named no session or run");
    // The turn is running: its first request is with the model, held open.
    await until("the turn to reach the model", () => (turnCalls(PROMPT) > 0 ? true : undefined));

    const first = await steer(context, sessionId, STEER, "session steer");
    expectThat(
      first.code === 0 && first.envelope?.ok,
      `session steer failed: ${first.envelope && !first.envelope.ok ? first.envelope.error.code : first.stderr.slice(-400)}`,
    );
    const steered = receiptOf(first);
    const deliveredAs = (first.envelope as { result?: { deliveredAs?: string } }).result
      ?.deliveredAs;
    expectThat(
      deliveredAs === undefined || deliveredAs === "steer",
      `the steer was delivered as ${deliveredAs}, not into the running turn`,
    );

    // An exact retry replays the same operation; another text under the key conflicts.
    const retry = await steer(context, sessionId, STEER, "session steer retry");
    expectThat(retry.code === 0 && retry.envelope?.ok, "the exact retry of the steer failed");
    expectThat(
      receiptOf(retry).operationId === steered.operationId,
      "the retry did not replay the steer's operation",
    );
    const conflict = await steer(context, sessionId, "A DIFFERENT TEXT", "session steer conflict");
    expectThat(
      conflict.envelope &&
        !conflict.envelope.ok &&
        conflict.envelope.error.code === "request-conflict",
      "a different text under the same request key was not refused as a conflict",
    );

    // A steer is a receipt, not a run (docs/architecture/public-cli.md): its
    // operation succeeds once the text is in, and the turn is followed
    // through the session.
    const steerRun = await context.cli.ok<unknown>(
      ["run", "get", steered.operationId],
      "steer run get",
    );
    const steerFinal = steerRun.envelope.receipt as PublicReceipt | undefined;
    expectThat(
      steerFinal?.state === "succeeded",
      `the steer's operation ended ${steerFinal?.state ?? "without a receipt"}`,
    );
    release?.();
    await until("the turn to answer the steer", async () => {
      const { result } = await context.cli.ok<{
        messages: PublicTranscriptMessage[];
      }>(["session", "transcript", sessionId, "--limit", "20"], "transcript poll");
      return result.messages.some(
        (row) => row.role === "assistant" && row.text.trim() === `ack:${STEER}`,
      )
        ? true
        : undefined;
    });
    // The start run's turn ended. Its outcome is recorded against the turn's
    // latest request, the steer, so the run itself ends `unknown` with that
    // reason, as for every provider; it must not read as running or failed.
    const waited = await context.cli.run(["--json", "run", "wait", runId, "--timeout", "3m"], {
      stage: "run wait",
      timeoutMs: 4 * 60_000,
    });
    const final = waited.envelope?.receipt as PublicReceipt | undefined;
    expectThat(
      final?.state === "succeeded" ||
        (final?.execution?.state === "unknown" &&
          final.execution.reason === "The turn ended but its outcome was not recorded"),
      `the steered run did not end: ${final?.state ?? "no receipt"} ${JSON.stringify(final?.execution ?? null)}`,
    );

    const transcript = await context.cli.ok<{
      messages: PublicTranscriptMessage[];
    }>(["session", "transcript", sessionId, "--limit", "20"], "transcript");
    const messages = transcript.result.messages;
    expectThat(
      messages.filter((row) => row.role === "user" && row.text.includes(STEER)).length === 1,
      "the transcript does not hold the steer exactly once",
    );
    const answers = messages.filter((row) => row.role === "assistant" && row.text.trim());
    expectThat(
      answers.at(-1)?.text.trim() === `ack:${STEER}`,
      "the turn did not end on the steer's reply",
    );
    expectThat(turnCalls(STEER) === 1, `the model saw the steer ${turnCalls(STEER)} times`);
  },
};
