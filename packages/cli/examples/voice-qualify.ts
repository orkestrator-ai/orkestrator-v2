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
 * and a person. This harness copies handles exactly, so its own score is a
 * self-check that must come out zero; a real voice runtime is scored from a
 * recording made by `voice-mcp-relay.ts`.
 *
 *   ORKESTRATOR_MCP_TOKEN=<voice credential token> \
 *     bun packages/cli/examples/voice-qualify.ts \
 *     --environment <ready environment id> [--url http://127.0.0.1:34122/mcp] \
 *     [--agent claude] [--prompt "…"] [--read-repeats 20] [--approval-wait 60] \
 *     [--expect-approval] [--record run.jsonl]
 *
 * --expect-approval exits 1 unless a command or file approval was raised,
 * confirmed and answered; the environment must ask for approvals (its
 * Settings → Execution policy → Approvals: Ask), and the default prompt then
 * writes a canary file, since read-only commands are not asked about.
 * --record writes this run's recording.
 *
 *   bun packages/cli/examples/voice-qualify.ts --score <recording.jsonl> \
 *     --environment <id> [--project <id>]
 *
 * scores a recording instead of running the script.
 *
 * The report is one JSON document on stdout. The prompt is spent on a real
 * provider; use a disposable environment of a test profile.
 */

import { appendFile } from "node:fs/promises";
import {
  parseRecording,
  payloadOf,
  percentile,
  recordCall,
  recordingReport,
  scoreRecording,
  summarize,
  type RecordingEntry,
  type ToolCall,
} from "./voice-recording.js";

export { percentile, summarize };

export function createClient(url: string, token: string) {
  const calls: ToolCall[] = [];
  const recording: RecordingEntry[] = [];
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
    recording,
    async listTools() {
      const { body, bytes } = await rpc("tools/list");
      const tools = (body as { result?: { tools?: Array<{ name: string }> } }).result?.tools ?? [];
      recording.push({
        type: "tools/list",
        at: new Date().toISOString(),
        tools: tools.length,
        bytes,
      });
      return { names: tools.map((tool) => tool.name), bytes };
    },
    async call(tool: string, args: Record<string, unknown> = {}) {
      const started = performance.now();
      const { body } = await rpc("tools/call", { name: tool, arguments: args });
      const { entry, text, structured } = recordCall(tool, args, body, performance.now() - started);
      recording.push(entry);
      calls.push({
        tool,
        ms: entry.ms,
        textBytes: entry.textBytes,
        ok: entry.ok,
        ...(entry.code ? { code: entry.code } : {}),
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
  const scorePath = argument("score");
  if (scorePath && environmentId) {
    const entries = parseRecording(await Bun.file(scorePath).text());
    const projectId = argument("project");
    const report = recordingReport(entries, { environmentId, ...(projectId ? { projectId } : {}) });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (!token || !environmentId) {
    process.stderr.write("Set ORKESTRATOR_MCP_TOKEN and pass --environment <id>\n");
    process.exit(2);
  }
  const client = createClient(argument("url", "http://127.0.0.1:34122/mcp")!, token);
  const repeats = Math.max(1, Number(argument("read-repeats", "20")));
  const approvalWaitMs = Math.max(0, Number(argument("approval-wait", "60"))) * 1_000;
  const expectApproval = process.argv.includes("--expect-approval");
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
    // Read-only commands such as `ls` run without an approval even when the
    // environment asks, so the approval script writes a file.
    prompt:
      argument("prompt") ??
      (expectApproval
        ? "Run the Bash command `printf voice > voice-qualify-canary.txt` exactly once, then reply DONE. Do not use other tools or ask me any questions."
        : "Run `ls` in the workspace root and tell me how many entries there are. Ask before running anything."),
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
  let approvalConfirmed = false;
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
      approvalConfirmed =
        Boolean(confirmToken) && confirmed.structured.ok !== false && detail?.kind !== "question";
      answered =
        confirmed.structured.ok === false
          ? `refused: ${confirmed.structured.error?.code}`
          : confirmToken
            ? `${detail?.kind ?? "interaction"} confirmed and answered`
            : `${detail?.kind ?? "interaction"} answered`;
      if (confirmed.structured.ok !== false) {
        // Let the agent act on the answer before step 4 stops it, so the run
        // shows the answer took effect: wait until the run finishes or asks
        // something else.
        const resumeDeadline = Date.now() + 30_000;
        let after: string | undefined;
        while (Date.now() < resumeDeadline) {
          const next = (await client.call("run_status", { operationId: receipt.operationId }))
            .structured.receipt as
            | {
                state?: string;
                execution?: { state?: string; interactions?: Array<{ id: string }> };
              }
            | undefined;
          after = next?.execution?.state ?? next?.state;
          const askedAgain =
            after === "waiting-for-input" &&
            !next?.execution?.interactions?.some((item) => item.id === pending.id);
          if (askedAgain || !["pending", "running", "waiting-for-input"].includes(after ?? ""))
            break;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        answered += after ? `; run then ${after}` : "";
      }
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
      // An answered run may already have finished; stopping an idle session
      // is refused as session-idle, which is the expected outcome then.
      outcome:
        stopped.structured.ok !== false
          ? "stopped"
          : stopped.structured.error?.code === "session-idle"
            ? "already finished (session-idle)"
            : String(stopped.structured.error?.code),
    });
    for (let index = 0; index < repeats; index += 1)
      await client.call("read_session", { sessionId });
    steps.push({
      step: "read_session",
      outcome: client.calls.slice(-repeats).every((call) => call.ok) ? "read" : "failed",
    });
  }

  const recordPath = argument("record");
  if (recordPath) {
    const lines = client.recording.map((entry) => `${JSON.stringify(entry)}\n`).join("");
    await appendFile(recordPath, lines, { mode: 0o600 });
  }
  if (expectApproval && !approvalConfirmed) process.exitCode = 1;
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
        ...(expectApproval
          ? { approval: approvalConfirmed ? "confirmed and answered" : "not raised or refused" }
          : {}),
        selfCheck: scoreRecording(client.recording, { environmentId }),
        notMeasured: [
          "misresolved spoken targets (needs a speaking model and a person; score a relay recording)",
          "session-handle copy errors (this harness copies handles exactly; selfCheck must be zero)",
        ],
      },
      null,
      2,
    )}\n`,
  );
}

if (import.meta.main) await main();
