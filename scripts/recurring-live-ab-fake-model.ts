import {
  piCompletionChunk,
  piProviderConfig,
  profilePiAgentDirectory,
} from "./pi-fake-model-shared";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * A fake OpenAI-compatible model endpoint for the recurring-work soak
 * (`scripts/recurring-live-ab.ts --soak-sessions`), so real Pi sessions can run
 * turns on an isolated profile without a credential, a provider or a bill.
 *
 * Only the model is fake. The profile's own Pi bridge, Pi SDK sessions, JSONL
 * session files, backend projection and observation all run for real; Pi is
 * pointed at this endpoint by a `models.json` in the profile's isolated HOME
 * (`writeFakePiModels`), never the user's `~/.pi`.
 *
 * It listens on 127.0.0.1 on a port the kernel picks, answers every chat
 * completion with one short streamed reply, and keeps only counts: no prompt,
 * header or body is retained or logged.
 *
 * The busy phase (`recurring-live-ab-busy.ts`) scripts turns with markers the
 * driver writes into its own prompts. Only the marker's id (a driver-made
 * token) is read; the rest of the prompt is never kept:
 *
 * - `[hold:<id>]` parks the request, with nothing written, until
 *   {@link FakeModelServer.release} names the id (or the server stops), so a
 *   turn stays "the provider is working" for as long as the driver wants.
 * - `[tool:<id>]` answers with one `bash` tool call (`printf <id>`), unless a
 *   tool result already follows the prompt, in which case it replies as usual.
 *   Under an `ask` execution policy Pi parks that call as an approval.
 * - A request that offers one of the Multi Review result tools
 *   ({@link FAKE_WORKFLOW_RESULTS}) answers with one call to it: the
 *   `resultKey` named in the prompt and a fixed, finding-free result, then
 *   replies as usual once the tool result follows. The validation plan must
 *   name the workspace's HEAD, so for it the model first runs
 *   `git rev-parse HEAD` through `bash`, as an agent would, and submits the
 *   SHA that call returned. So a Multi Review whose every slot is Pi on this
 *   model prepares, validates, reviews and consolidates.
 */

export const FAKE_PI_PROVIDER = "soak-fake";
export const FAKE_PI_MODEL = "soak-1";
/** `provider/modelId`, as the CLI's `--model` takes a Pi model. */
export const FAKE_PI_MODEL_REF = `${FAKE_PI_PROVIDER}/${FAKE_PI_MODEL}`;
/** The text of every reply that is not a tool call. */
export const FAKE_REPLY = "Soak reply.";
const REPLY = FAKE_REPLY;
/** A request body larger than this is refused; Pi's soak prompts are tiny. */
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

export type FakeModelServer = {
  baseUrl: string;
  /** Requests answered, by route. */
  counts(): { completions: number; models: number; refused: number };
  /**
   * Multi Review result calls, by tool: submission identities and times, and when the
   * latest call's result came back to the model (`performance.now()`), which
   * is after the backend accepted or refused it.
   */
  workflow(): Record<
    string,
    { calls: number; resultsAt: number[]; submissions: Array<{ resultKey: string; at: number }> }
  >;
  /**
   * Requests whose latest prompt carried `[hold:<id>]` or `[tool:<id>]`, by id:
   * how many arrived and when the first and the latest did (`performance.now()`).
   */
  marker(id: string): MarkerRecord | null;
  /** Answers every parked request for `id`, and every later one at once. */
  release(id: string): void;
  stop(): Promise<void>;
};

export type MarkerRecord = {
  requests: number;
  /** Requests for this id that carried a tool result (the turn after a tool call). */
  toolResults: number;
  firstAt: number;
  lastAt: number;
};

/** The result key a workflow prompt names (`workflow-results.ts`). */
const RESULT_KEY = /resultKey "?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"?/;

const CLEAN_REPORT = {
  reviewScope: {
    targetBranch: "main",
    baseRef: "origin/main...HEAD",
    commit: null,
    filesReviewed: [],
    filesSkipped: [],
    filesLeftUncommitted: [],
    commandsRun: [],
    commandsNotRun: [],
    limitations: ["A scripted fake model wrote this report; it read no code."],
    outcome: "reviewed",
    blockedReason: null,
  },
  whatChanged: {
    overview: "A fixture change made by the busy-profile driver.",
    before: "The fixture as committed.",
    after: "The fixture with the driver's change.",
    keyCodeChanges: [],
    userImpact: "None; this is a qualification fixture.",
  },
  riskProfile: {
    changeTypes: ["feature"],
    riskAreas: [],
    overallRisk: "low",
    reasoning: "A scripted qualification review.",
  },
  testResults: { total: 0, passed: 0, failed: 0, notRun: 0, failures: [] },
  strengths: [],
  issues: [],
  testCoverageGaps: [],
  verdict: { ready: "yes", reasoning: "A scripted review with no findings." },
  summaryOfChange: "A fixture change made by the busy-profile driver.",
  reviewSummary: "No findings; a scripted fake model reviewed nothing.",
};

/** The result each Multi Review tool submits: valid, and with no findings. */
export const FAKE_WORKFLOW_RESULTS: Readonly<Record<string, unknown>> = {
  submit_validation_plan: {
    headRef: "",
    commands: [
      {
        id: "head",
        command: "git rev-parse HEAD",
        cwd: ".",
        dependsOn: [],
        resources: [],
        weight: 1,
        timeoutMs: 60_000,
      },
    ],
    limitations: ["A scripted fake model planned one read-only command."],
  },
  submit_review_preparation: {
    validation: [],
    uncommittedFiles: [],
    limitations: ["A scripted fake model ran no validation."],
  },
  submit_review_report: CLEAN_REPORT,
  submit_consolidated_review: CLEAN_REPORT,
};

/** Marker ids are driver tokens: short, and never prompt text. */
const MARKER = /\[(hold|tool):([a-z0-9-]{1,48})\]/g;
const MAX_MARKERS = 4_096;
export const FAKE_TOOL_NAME = "bash";

type ChatMessage = { role?: unknown; content?: unknown };

function messageText(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("\n");
}

/**
 * The markers of the latest user prompt, and whether a tool result follows
 * it. Exported for tests.
 */
export function scriptOf(
  messages: unknown,
  tools?: unknown,
): {
  hold: string | null;
  tool: string | null;
  afterToolResult: boolean;
  /** A Multi Review result tool this request offers, with the prompt's result key. */
  workflow: { tool: string; resultKey: string } | null;
  /** Tool results after the prompt. */
  toolResults: number;
  /** The first full commit SHA in a tool result after the prompt. */
  sha: string | null;
} {
  const list = Array.isArray(messages) ? (messages as ChatMessage[]) : [];
  let lastUser = -1;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.role === "user") {
      lastUser = index;
      break;
    }
  }
  const script = {
    hold: null as string | null,
    tool: null as string | null,
    afterToolResult: false,
    workflow: null as { tool: string; resultKey: string } | null,
    toolResults: 0,
    sha: null as string | null,
  };
  if (lastUser < 0) return script;
  const prompt = messageText(list[lastUser]!);
  for (const match of prompt.matchAll(MARKER)) {
    if (match[1] === "hold") script.hold ??= match[2]!;
    else script.tool ??= match[2]!;
  }
  for (const message of list.slice(lastUser + 1)) {
    if (message?.role !== "tool") continue;
    script.toolResults += 1;
    script.sha ??= /\b[0-9a-f]{40}\b/.exec(messageText(message))?.[0] ?? null;
  }
  script.afterToolResult = script.toolResults > 0;
  const offered = (Array.isArray(tools) ? tools : [])
    .map((tool) => (tool as { function?: { name?: unknown } } | null)?.function?.name)
    .find((name): name is string => typeof name === "string" && name in FAKE_WORKFLOW_RESULTS);
  const resultKey = RESULT_KEY.exec(prompt)?.[1];
  if (offered && resultKey) script.workflow = { tool: offered, resultKey };
  return script;
}

type Script = ReturnType<typeof scriptOf>;

/**
 * Where a workflow turn stands: a validation plan first reads HEAD, then
 * submits; every other result submits at once; after the submission's own
 * result the model replies and the turn ends.
 */
function workflowStage(script: Script): "read-head" | "submit" | "reply" {
  const reads = script.workflow?.tool === "submit_validation_plan" ? 1 : 0;
  if (script.toolResults < reads) return "read-head";
  return script.toolResults === reads ? "submit" : "reply";
}

/** The tool call a scripted request answers with, or null for a text reply. */
export function callFor(script: Script, id: string) {
  const call = (name: string, input: unknown) => ({
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(input) },
  });
  if (script.workflow) {
    const stage = workflowStage(script);
    if (stage === "read-head") return call(FAKE_TOOL_NAME, { command: "git rev-parse HEAD" });
    if (stage === "reply") return null;
    const base = FAKE_WORKFLOW_RESULTS[script.workflow.tool];
    const result =
      script.workflow.tool === "submit_validation_plan"
        ? { ...(base as object), headRef: script.sha ?? "" }
        : base;
    return call(script.workflow.tool, { resultKey: script.workflow.resultKey, result });
  }
  if (script.tool && !script.afterToolResult)
    return call(FAKE_TOOL_NAME, { command: `printf ${script.tool}` });
  return null;
}

/**
 * `platform.Response` is the class handlers answer with: a test under a DOM
 * preload passes Bun's native one, which `Bun.serve` requires.
 */
export function startFakeModelServer(
  platform: { Response: typeof Response } = { Response: globalThis.Response },
): FakeModelServer {
  const Reply = platform.Response;
  const counts = { completions: 0, models: 0, refused: 0 };
  const markers = new Map<string, MarkerRecord>();
  const workflow: Record<
    string,
    { calls: number; resultsAt: number[]; submissions: Array<{ resultKey: string; at: number }> }
  > = {};
  const released = new Set<string>();
  const parked = new Map<string, Set<() => void>>();
  let stopped = false;
  let sequence = 0;
  const note = (id: string, toolResult: boolean) => {
    const at = performance.now();
    const record = markers.get(id);
    if (record) {
      record.requests += 1;
      record.lastAt = at;
      if (toolResult) record.toolResults += 1;
    } else if (markers.size < MAX_MARKERS) {
      markers.set(id, { requests: 1, toolResults: toolResult ? 1 : 0, firstAt: at, lastAt: at });
    }
  };
  const waitFor = (id: string, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (stopped || released.has(id)) return resolve();
      const waiters = parked.get(id) ?? new Set<() => void>();
      parked.set(id, waiters);
      const done = () => {
        waiters.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      waiters.add(done);
      signal.addEventListener("abort", done, { once: true });
    });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // A held request writes nothing until it is released.
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname.endsWith("/models")) {
        counts.models += 1;
        return Reply.json({ object: "list", data: [{ id: FAKE_PI_MODEL, object: "model" }] });
      }
      if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
        counts.refused += 1;
        return new Reply("not found", { status: 404 });
      }
      const declared = Number(request.headers.get("content-length") ?? 0);
      if (declared > MAX_REQUEST_BYTES) {
        counts.refused += 1;
        return new Reply("too large", { status: 413 });
      }
      let stream = false;
      let script: ReturnType<typeof scriptOf>;
      try {
        const text = await request.text();
        if (text.length > MAX_REQUEST_BYTES) throw new Error("too large");
        const body = JSON.parse(text) as { stream?: unknown; messages?: unknown };
        stream = body.stream === true;
        script = scriptOf(body.messages, (body as { tools?: unknown }).tools);
      } catch {
        counts.refused += 1;
        return new Reply("bad request", { status: 400 });
      }
      counts.completions += 1;
      const marker = script.hold ?? script.tool;
      if (marker) note(marker, script.afterToolResult);
      if (script.hold) await waitFor(script.hold, request.signal);
      if (script.workflow) {
        const entry = (workflow[script.workflow.tool] ??= {
          calls: 0,
          resultsAt: [],
          submissions: [],
        });
        const stage = workflowStage(script);
        if (stage === "submit") {
          entry.calls += 1;
          if (entry.submissions.length < MAX_MARKERS)
            entry.submissions.push({ resultKey: script.workflow.resultKey, at: performance.now() });
        } else if (stage === "reply" && entry.resultsAt.length < MAX_MARKERS)
          entry.resultsAt.push(performance.now());
      }
      const id = `soak-${++sequence}`;
      const usage = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 };
      const toolCall = callFor(script, `call-${sequence}`);
      if (!stream) {
        return Reply.json({
          id,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: FAKE_PI_MODEL,
          choices: [
            {
              index: 0,
              message: toolCall
                ? { role: "assistant", content: null, tool_calls: [toolCall] }
                : { role: "assistant", content: REPLY },
              finish_reason: toolCall ? "tool_calls" : "stop",
            },
          ],
          usage,
        });
      }
      const body = toolCall
        ? piCompletionChunk(
            FAKE_PI_MODEL,
            id,
            { role: "assistant", tool_calls: [{ index: 0, ...toolCall }] },
            null,
          ) +
          piCompletionChunk(FAKE_PI_MODEL, id, {}, "tool_calls", usage) +
          "data: [DONE]\n\n"
        : piCompletionChunk(FAKE_PI_MODEL, id, { role: "assistant", content: REPLY }, null) +
          piCompletionChunk(FAKE_PI_MODEL, id, {}, "stop", usage) +
          "data: [DONE]\n\n";
      return new Reply(body, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    },
  });
  const release = (id: string) => {
    released.add(id);
    for (const resolve of Array.from(parked.get(id) ?? [])) resolve();
    parked.delete(id);
  };
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    counts: () => ({ ...counts }),
    workflow: () =>
      Object.fromEntries(
        Object.entries(workflow).map(([tool, entry]) => [
          tool,
          {
            calls: entry.calls,
            resultsAt: [...entry.resultsAt],
            submissions: entry.submissions.map((item) => ({ ...item })),
          },
        ]),
      ),
    marker: (id) => {
      const record = markers.get(id);
      return record ? { ...record } : null;
    },
    release,
    stop: async () => {
      stopped = true;
      for (const id of Array.from(parked.keys())) release(id);
      await server.stop(true);
    },
  };
}

/** The `models.json` that adds the fake provider; its key is a literal placeholder. */
export function fakePiModelsConfig(baseUrl: string) {
  return piProviderConfig({
    provider: FAKE_PI_PROVIDER,
    providerName: "Soak fake",
    baseUrl,
    apiKey: "soak-fake-no-provider",
    model: FAKE_PI_MODEL,
    modelName: "Soak 1",
  });
}

export { profilePiAgentDirectory } from "./pi-fake-model-shared";

/**
 * Writes the fake provider into the profile's own Pi `models.json`. Refuses
 * when that file already exists with other content: it belongs to the profile,
 * and the soak only ever writes a profile it just created.
 */
export function writeFakePiModels(dataDir: string, baseUrl: string): string {
  const resolvedData = path.resolve(dataDir);
  const directory = profilePiAgentDirectory(resolvedData);
  if (!directory.startsWith(`${resolvedData}${path.sep}`)) {
    throw new Error("Pi agent directory escapes the profile data directory");
  }
  const file = path.join(directory, "models.json");
  if (existsSync(file)) {
    const existing = JSON.parse(readFileSync(file, "utf8")) as { providers?: object };
    const providers = Object.keys(existing.providers ?? {});
    if (providers.some((provider) => provider !== FAKE_PI_PROVIDER)) {
      throw new Error("The profile's Pi models.json already names other providers");
    }
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(fakePiModelsConfig(baseUrl), null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
  return file;
}
