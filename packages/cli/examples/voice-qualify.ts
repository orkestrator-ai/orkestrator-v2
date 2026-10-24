#!/usr/bin/env bun
/**
 * Control MCP voice qualification harness.
 *
 * Runs the qualification script from docs/todo/mcp/0041-control-mcp-voice-surface.md
 * against a running Orkestrator with a voice credential, the way a voice
 * runtime would call it, and reports what can be measured without a person:
 *
 * 1. overview
 * 2. start work (a new session in --environment, with --agent and --prompt)
 * 3. answer an approval or question, if the agent asks one within
 *    --approval-wait: read it with `session.interactions`, choose the option a
 *    "yes" means, and for an approval confirm first (confirmation-required,
 *    then the confirmed call)
 * 4. stop the turn
 * 5. read the result
 *
 * It records per-tool latency (p50/p95 over --read-repeats calls for each
 * read tool, and every mutation once), the size of the voice `tools/list`
 * and of each result's text, with a rough token estimate (bytes / 4).
 * Misresolved targets and session-handle copy errors need a speaking model
 * and a person; this harness copies handles exactly, so it cannot measure
 * them and says so in its report.
 *
 *   ORKESTRATOR_MCP_TOKEN=<voice credential token> \
 *     bun packages/cli/examples/voice-qualify.ts \
 *     --environment <ready environment id> [--url http://127.0.0.1:34122/mcp] \
 *     [--agent claude] [--prompt "…"] [--read-repeats 20] [--approval-wait 60]
 *
 * The report is one JSON document on stdout. The prompt is spent on a real
 * provider; use a disposable environment of a test profile.
 */

interface ToolCall {
  tool: string;
  ms: number;
  textBytes: number;
  ok: boolean;
  code?: string;
}

export function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

export function summarize(calls: readonly ToolCall[]) {
  const byTool = new Map<string, ToolCall[]>();
  for (const call of calls) byTool.set(call.tool, [...(byTool.get(call.tool) ?? []), call]);
  return Object.fromEntries(
    [...byTool.entries()].map(([tool, entries]) => {
      const times = entries.map((entry) => entry.ms);
      return [
        tool,
        {
          calls: entries.length,
          p50Ms: percentile(times, 0.5),
          p95Ms: percentile(times, 0.95),
          maxTextBytes: Math.max(...entries.map((entry) => entry.textBytes)),
          failures: entries.filter((entry) => !entry.ok).map((entry) => entry.code ?? "error"),
        },
      ];
    }),
  );
}

function payloadOf(text: string, contentType: string | null): unknown {
  const payload = contentType?.startsWith("text/event-stream")
    ? text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length)
    : text;
  return JSON.parse(payload ?? "{}");
}

export function createClient(url: string, token: string) {
  const calls: ToolCall[] = [];
  async function rpc(method: string, params?: Record<string, unknown>) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method,
        ...(params ? { params } : {}),
      }),
    });
    const text = await response.text();
    if (response.status !== 200) throw new Error(`${method}: HTTP ${response.status}`);
    return {
      body: payloadOf(text, response.headers.get("content-type")),
      bytes: Buffer.byteLength(text),
    };
  }
  return {
    calls,
    async listTools() {
      const { body, bytes } = await rpc("tools/list");
      const tools = (body as { result?: { tools?: Array<{ name: string }> } }).result?.tools ?? [];
      return { names: tools.map((tool) => tool.name), bytes };
    },
    async call(tool: string, args: Record<string, unknown> = {}) {
      const started = performance.now();
      const { body } = await rpc("tools/call", { name: tool, arguments: args });
      const ms = performance.now() - started;
      const payload = body as { error?: { code?: number | string } };
      const result = (
        body as {
          result?: {
            isError?: boolean;
            content?: Array<{ text?: string }>;
            structuredContent?: Record<string, unknown> & {
              ok?: boolean;
              error?: { code?: string; details?: Record<string, unknown> };
            };
          };
        }
      ).result;
      const text = result?.content?.map((entry) => entry.text ?? "").join("\n") ?? "";
      const envelope = result?.structuredContent;
      const valid =
        !payload.error &&
        result?.isError !== true &&
        envelope?.ok === true &&
        envelope.schemaVersion === 1 &&
        typeof envelope.action === "string" &&
        "result" in envelope;
      const code = payload.error
        ? `json-rpc:${payload.error.code ?? "error"}`
        : result?.isError
          ? (envelope?.error?.code ?? "mcp-tool-error")
          : (envelope?.error?.code ?? "invalid-envelope");
      const structured = valid
        ? envelope!
        : {
            ok: false,
            error: { ...envelope?.error, code },
          };
      calls.push({
        tool,
        ms,
        textBytes: Buffer.byteLength(text),
        ok: valid,
        ...(structured.error?.code ? { code: structured.error.code } : {}),
      });
      return { text, structured };
    },
  };
}

interface InteractionDetail {
  id: string;
  kind: string;
  questions: Array<{
    id: string;
    required: boolean;
    allowFreeText: boolean;
    options: Array<{ id: string; label: string }>;
  }>;
}

/** Answers a person saying "yes" would give: an affirmative option, else the first. */
export function affirmativeAnswers(detail: InteractionDetail) {
  return detail.questions
    .filter((question) => question.required || question.options.length > 0)
    .map((question) => {
      const option =
        question.options.find((candidate) =>
          /\b(yes|allow|approve|proceed|continue|ok)\b/i.test(candidate.label),
        ) ?? question.options[0];
      return option
        ? { questionId: question.id, optionIds: [option.id] }
        : { questionId: question.id, freeText: "yes" };
    });
}

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const token = process.env.ORKESTRATOR_MCP_TOKEN;
  const environmentId = argument("environment");
  if (!token || !environmentId) {
    process.stderr.write("Set ORKESTRATOR_MCP_TOKEN and pass --environment <id>\n");
    process.exit(2);
  }
  const client = createClient(argument("url", "http://127.0.0.1:34122/mcp")!, token);
  const repeats = Math.max(1, Number(argument("read-repeats", "20")));
  const approvalWaitMs = Math.max(0, Number(argument("approval-wait", "60"))) * 1_000;
  const steps: Array<{ step: string; outcome: string }> = [];
  const listed = await client.listTools();

  // 1. overview (and repeated reads for latency).
  for (let index = 0; index < repeats; index += 1) await client.call("overview");
  steps.push({
    step: "overview",
    outcome: client.calls.slice(-repeats).every((call) => call.ok) ? "read" : "failed",
  });

  // 2. start work.
  const runKey = `voice-qualify-${Date.now()}`;
  const started = await client.call("start_work", {
    environmentId,
    ...(argument("agent") ? { agent: argument("agent") } : {}),
    prompt:
      argument("prompt") ??
      "Run `ls` in the workspace root and tell me how many entries there are. Ask before running anything.",
    requestId: runKey,
  });
  const receipt = started.structured.receipt as
    | { operationId: string; resources: { sessionId?: string } }
    | undefined;
  const sessionId = receipt?.resources.sessionId;
  steps.push({
    step: "start_work",
    outcome: receipt ? "started" : String(started.structured.error?.code),
  });

  // 3. answer an approval if one appears.
  let answered = "nothing was asked";
  const deadline = Date.now() + approvalWaitMs;
  while (receipt && sessionId && Date.now() < deadline) {
    const status = await client.call("run_status", { operationId: receipt.operationId });
    const execution = status.structured.receipt as
      | {
          execution?: { state?: string; interactions?: Array<{ id: string; revision: number }> };
          state?: string;
        }
      | undefined;
    const pending =
      execution?.execution?.state === "waiting-for-input"
        ? execution.execution.interactions?.[0]
        : undefined;
    if (pending) {
      // Read it the way a voice agent would before answering, and pick the
      // option a person saying "yes" means.
      const listed = await client.call("run_action", {
        action: "session.interactions",
        input: { sessionId },
      });
      const detail = (
        (listed.structured.result as { items?: InteractionDetail[] } | undefined)?.items ?? []
      ).find((item) => item.id === pending.id);
      const answer = {
        sessionId,
        interactionId: pending.id,
        revision: pending.revision,
        action: "answer",
        ...(detail ? { answers: affirmativeAnswers(detail) } : {}),
        requestId: `${runKey}-approve`,
      };
      const first = await client.call("answer_question", answer);
      const confirmToken = first.structured.error?.details?.confirmToken;
      const confirmed = confirmToken
        ? await client.call("answer_question", { ...answer, confirmToken })
        : first;
      answered =
        confirmed.structured.ok === false
          ? `refused: ${confirmed.structured.error?.code}`
          : confirmToken
            ? `${detail?.kind ?? "interaction"} confirmed and answered`
            : `${detail?.kind ?? "interaction"} answered`;
      break;
    }
    if (execution?.state && !["admitted", "running"].includes(execution.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  steps.push({ step: "answer_question", outcome: answered });

  // 4. stop, 5. read the result.
  if (sessionId) {
    const stopped = await client.call("stop_session", { sessionId, requestId: `${runKey}-stop` });
    steps.push({
      step: "stop_session",
      outcome: stopped.structured.ok === false ? String(stopped.structured.error?.code) : "stopped",
    });
    for (let index = 0; index < repeats; index += 1)
      await client.call("read_session", { sessionId });
    steps.push({
      step: "read_session",
      outcome: client.calls.slice(-repeats).every((call) => call.ok) ? "read" : "failed",
    });
  }

  const summary = summarize(client.calls);
  const reads = client.calls.filter((call) =>
    ["overview", "read_session", "run_status"].includes(call.tool),
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        url: argument("url", "http://127.0.0.1:34122/mcp"),
        tools: {
          count: listed.names.length,
          bytes: listed.bytes,
          approxTokens: Math.ceil(listed.bytes / 4),
        },
        steps,
        latency: {
          readsP50Ms: percentile(
            reads.map((call) => call.ms),
            0.5,
          ),
          readsP95Ms: percentile(
            reads.map((call) => call.ms),
            0.95,
          ),
          readsP95UnderOneSecond:
            (percentile(
              reads.map((call) => call.ms),
              0.95,
            ) ?? Infinity) < 1_000,
          byTool: summary,
        },
        resultText: {
          maxBytes: Math.max(0, ...client.calls.map((call) => call.textBytes)),
          approxMaxTokens: Math.ceil(
            Math.max(0, ...client.calls.map((call) => call.textBytes)) / 4,
          ),
        },
        notMeasured: [
          "misresolved spoken targets (needs a speaking model and a person)",
          "session-handle copy errors (this harness copies handles exactly)",
        ],
      },
      null,
      2,
    )}\n`,
  );
}

if (import.meta.main) await main();
