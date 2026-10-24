#!/usr/bin/env bun
/**
 * Reference attention relay for a realtime voice runtime.
 *
 * MCP tools cannot push, so a voice agent only hears about work when it
 * asks. This relay runs beside the voice runtime, outside the model: it polls
 * Control MCP's `attention.list` (through `run_action`) every few seconds with
 * a voice credential and emits each new item once, with a sentence the
 * runtime can inject into the conversation as context ("claude in auth-fix is
 * asking: Run rm -rf dist"). It never calls a mutation and never prints the
 * token.
 *
 *   ORKESTRATOR_MCP_TOKEN=<voice credential token> \
 *     bun packages/cli/examples/voice-attention-relay.ts \
 *     [--url http://127.0.0.1:34122/mcp] [--interval 3] [--webhook http://127.0.0.1:8787/inject]
 *
 * Without --webhook each item is one JSON line on stdout:
 *   {"type":"attention","say":"…","item":{…}}
 * With --webhook each line is POSTed there as JSON instead.
 *
 * The same feed is available without MCP as
 * `orkestrator attention --follow --jsonl`.
 */

import type {
  PublicAttentionItem,
  PublicAttentionPage,
} from "@orkestrator/protocol/public-api-resources";

export function attentionSentence(item: PublicAttentionItem): string {
  if (item.kind === "interaction") {
    return `${item.agent} in ${item.environmentName} is asking: ${item.title}`;
  }
  if (item.kind === "setup") {
    return `${item.environmentName} setup ${item.phase === "ready" ? "finished" : "failed"}`;
  }
  const outcome = item.state === "succeeded" ? "finished" : item.state;
  return `${item.action} ${outcome}${item.errorCode ? ` (${item.errorCode})` : ""}`;
}

export function attentionKey(item: PublicAttentionItem): string {
  if (item.kind === "interaction") return `interaction:${item.interactionId}:${item.revision}`;
  if (item.kind === "setup") return `setup:${item.environmentId}:${item.at}`;
  return `run:${item.operationId}:${item.state}`;
}

/** The attention page inside a `tools/call` response, plain JSON or one SSE event. */
export function attentionPageFromResponse(body: string, contentType: string | null) {
  const payload = contentType?.startsWith("text/event-stream")
    ? body
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length)
    : body;
  const parsed = JSON.parse(payload ?? "{}") as {
    result?: {
      structuredContent?: { ok?: boolean; result?: PublicAttentionPage; error?: { code: string } };
    };
    error?: { message?: string };
  };
  const envelope = parsed.result?.structuredContent;
  if (!envelope?.ok || !envelope.result) {
    throw new Error(
      envelope?.error?.code ?? parsed.error?.message ?? "attention.list returned no page",
    );
  }
  return envelope.result;
}

interface RelayOptions {
  url: string;
  token: string;
  intervalMs: number;
  webhook?: string;
  emit?: (record: Record<string, unknown>) => Promise<void> | void;
  /** Called after every poll (tests). */
  onPoll?: () => void;
  signal?: AbortSignal;
}

export async function runRelay(options: RelayOptions): Promise<void> {
  const seen = new Set<string>();
  let cursor: string | undefined;
  let delay = options.intervalMs;
  let pending: ReturnType<typeof attentionPageFromResponse> | undefined;
  const emit =
    options.emit ??
    (async (record: Record<string, unknown>) => {
      if (!options.webhook) {
        process.stdout.write(`${JSON.stringify(record)}\n`);
        return;
      }
      const response = await fetch(options.webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(record),
        signal: options.signal,
      });
      if (!response.ok) throw new Error(`Webhook refused delivery: HTTP ${response.status}`);
    });
  while (!options.signal?.aborted) {
    try {
      if (!pending) {
        const response = await fetch(options.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.token}`,
            Accept: "application/json, text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: crypto.randomUUID(),
            method: "tools/call",
            params: {
              name: "run_action",
              arguments: { action: "attention.list", input: cursor ? { cursor } : {} },
            },
          }),
          signal: options.signal,
        });
        if (response.status === 401)
          throw new Error("The credential was refused (revoked or rotated)");
        if (!response.ok) throw new Error(`attention.list: HTTP ${response.status}`);
        pending = attentionPageFromResponse(
          await response.text(),
          response.headers.get("content-type"),
        );
      }
      const page = pending;
      for (const item of page.items) {
        const key = attentionKey(item);
        if (seen.has(key)) continue;
        await emit({ type: "attention", say: attentionSentence(item), item });
        seen.add(key);
      }
      cursor = page.cursor;
      pending = undefined;
      if (seen.size > 10_000) seen.clear();
      delay = options.intervalMs;
      options.onPoll?.();
      if (page.more > 0) continue;
    } catch (error) {
      if (options.signal?.aborted) return;
      try {
        await emit({
          type: "relay-error",
          message: error instanceof Error ? error.message.slice(0, 200) : "poll failed",
        });
      } catch {
        // The notification sink may be the outage; diagnostics are best effort.
      }
      // Back off while the backend is away; never hammer it.
      delay = Math.min(delay * 2, 60_000);
    }
    if (options.signal?.aborted) return;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.main) {
  const token = process.env.ORKESTRATOR_MCP_TOKEN;
  if (!token) {
    process.stderr.write("Set ORKESTRATOR_MCP_TOKEN to a voice credential's token\n");
    process.exit(2);
  }
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  process.on("SIGTERM", () => controller.abort());
  await runRelay({
    url: argument("url") ?? "http://127.0.0.1:34122/mcp",
    token,
    intervalMs: Math.max(1, Number(argument("interval") ?? "3")) * 1_000,
    ...(argument("webhook") ? { webhook: argument("webhook") } : {}),
    signal: controller.signal,
  });
}
