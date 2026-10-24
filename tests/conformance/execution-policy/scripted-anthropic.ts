/**
 * A local Anthropic Messages endpoint that plays a fixed script, for offline
 * qualification of the pinned Claude CLI.
 *
 * Each model call returns the next scripted turn; a call past the script fails,
 * so a CLI that retries or loops shows up as an error rather than a hang.
 * `/unlisted` is a fixture URL a command can try to reach, counted in
 * `networkHits`.
 */
export type ScriptedBlock =
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "text"; text: string };

export interface ScriptedAnthropicEndpoint {
  url: URL;
  modelCalls(): number;
  networkHits(): number;
  stop(): void;
}

export function scriptedAnthropicEndpoint(
  script: (origin: string) => ScriptedBlock[][],
): ScriptedAnthropicEndpoint {
  let modelCalls = 0;
  let networkHits = 0;
  let turns: ScriptedBlock[][] | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/unlisted") {
        networkHits += 1;
        return new Response("fixture");
      }
      const body = (await request.json()) as { stream?: boolean };
      if (!new URL(request.url).pathname.endsWith("/messages"))
        return Response.json({ input_tokens: 1 });
      turns ??= script(server.url.origin);
      modelCalls += 1;
      const content = turns[modelCalls - 1];
      if (!content) return new Response("Unexpected model retry", { status: 400 });
      const toolTurn = content.some((block) => block.type === "tool_use");
      const message = {
        id: `msg_${modelCalls}`,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content,
        stop_reason: toolTurn ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      if (!body.stream) return Response.json(message);
      const events: unknown[] = [
        { type: "message_start", message: { ...message, content: [], stop_reason: null } },
      ];
      for (const [index, block] of content.entries()) {
        events.push({
          type: "content_block_start",
          index,
          content_block:
            block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" },
        });
        events.push({
          type: "content_block_delta",
          index,
          delta:
            block.type === "tool_use"
              ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
              : { type: "text_delta", text: block.text },
        });
        events.push({ type: "content_block_stop", index });
      }
      events.push(
        {
          type: "message_delta",
          delta: { stop_reason: message.stop_reason, stop_sequence: null },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      );
      return new Response(
        events
          .map((event) => {
            const frame = event as { type: string };
            return `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`;
          })
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return {
    url: server.url,
    modelCalls: () => modelCalls,
    networkHits: () => networkHits,
    stop: () => server.stop(true),
  };
}

/** The CLI environment for a fixture: no ambient credentials, this endpoint as the API. */
export function scriptedClaudeEnv(
  fixture: { root: string; env: Record<string, string> },
  endpoint: ScriptedAnthropicEndpoint,
  configDir: string,
): Record<string, string | undefined> {
  return {
    // The SDK merges env with its parent; explicitly remove ambient credentials.
    ...Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined])),
    ...fixture.env,
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_API_KEY: "fixture-key",
    ANTHROPIC_BASE_URL: endpoint.url.origin,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
  };
}
