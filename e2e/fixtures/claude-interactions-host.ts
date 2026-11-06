// Synthetic SDK callbacks through the real Claude bridge routes and backend
// normalization. This process never launches Claude or reads provider secrets.
//
// `CLAUDE_FIXTURE_COORDINATOR=1` runs it as a coordinator bridge process: the
// launcher's process authority makes every session read-only, exactly as the
// backend starts a coordinator's bridge.
import {
  mockGetMcpServerNames,
  mockGetMcpServersForSdk,
  nextQueryCall,
} from "../../bridges/claude-bridge/src/services/session-manager-test-mocks";
import { setClaudeHomeForTesting } from "../../bridges/claude-bridge/src/services/claude-home";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
import { HttpBridgeInteractionAdapter } from "../../apps/backend/src/core/http-bridge-interactions";

installFatalRejectionGuard({ label: "[claude-interaction-browser-fixture]" });
const home = mkdtempSync(join(tmpdir(), "claude-interaction-browser-"));
setClaudeHomeForTesting(home);
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("ORKESTRATOR_AGENT_MCP_") ||
    key === "ORKESTRATOR_BRIDGE_EXECUTION_POLICY" ||
    ["ORKESTRATOR_GITHUB_CREDENTIAL_FILE", "GITHUB_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN"].includes(
      key,
    )
  )
    delete process.env[key];
}
const coordinator = process.env.CLAUDE_FIXTURE_COORDINATOR === "1";
// A coordinator delegates through Orkestrator's own MCP server, which the
// loader adds from the backend's connection. The fake SDK never connects to
// it, so the address only has to be well formed.
const agentMcp = { url: "http://127.0.0.1:9/mcp", token: "fixture-agent-mcp" };
if (coordinator) {
  process.env.ORKESTRATOR_BRIDGE_EXECUTION_POLICY = "coordinator-read-only";
  mockGetMcpServerNames.mockImplementation(async () => new Set(["orkestrator"]));
  mockGetMcpServersForSdk.mockImplementation(async () => ({
    orkestrator: { type: "http", url: agentMcp.url },
  }));
}
process.env.GH_TOKEN = "fixture-no-credential";
process.env.CLAUDE_BRIDGE_NO_SERVER = "1";
process.env.CLAUDE_BRIDGE_AUTH_DISABLED_FOR_TESTING = "1";
const { app } = await import("../../bridges/claude-bridge/src/index");
const manager = await import("../../bridges/claude-bridge/src/services/session-manager");
const { effectiveExecutionPolicy } =
  await import("../../bridges/claude-bridge/src/services/read-only-policy");
const adapter = new HttpBridgeInteractionAdapter(
  "claude",
  { agent: "claude", baseUrl: "http://fixture", authToken: "fixture" },
  ((input: string | URL | Request, init?: RequestInit) =>
    app.request(String(input), init)) as typeof fetch,
);
type QueryCall = Awaited<ReturnType<typeof nextQueryCall>>;
type PreToolUseHook = (
  input: unknown,
  toolUseId: string | undefined,
  options: { signal: AbortSignal },
) => Promise<{ hookSpecificOutput?: { permissionDecision?: string } } | undefined>;
const turns = new Map<string, QueryCall>();
const results = new Map<string, unknown>();
/** Every answer the SDK callbacks returned, oldest first. */
const history = new Map<string, unknown[]>();
const settle = (sessionId: string, value: unknown) => {
  results.set(sessionId, value);
  history.set(sessionId, [...(history.get(sessionId) ?? []), value]);
};
/** The bridge's PreToolUse decision for a call, as the CLI would ask for it. */
async function preToolUse(call: QueryCall, tool: string, input: unknown) {
  const matchers =
    (call.options.hooks as { PreToolUse?: Array<{ hooks: PreToolUseHook[] }> } | undefined)
      ?.PreToolUse ?? [];
  for (const matcher of matchers) {
    for (const hook of matcher.hooks) {
      const output = await hook(
        {
          hook_event_name: "PreToolUse",
          tool_name: tool,
          tool_input: input,
          tool_use_id: `fixture-${tool}`,
        },
        `fixture-${tool}`,
        { signal: new AbortController().signal },
      );
      if (output?.hookSpecificOutput?.permissionDecision === "deny") return output;
    }
  }
  return {};
}
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/start") {
      const { approvals = "ask" } = (await req.json().catch(() => ({}))) as {
        approvals?: "ask" | "deny";
      };
      const session = manager.createSession("Browser interaction fixture");
      session.executionPolicy = {
        id: "interactive-host",
        sandbox: "none",
        approvals,
        projectResources: true,
        networkAccess: "full",
      };
      const options = coordinator ? { agentMcp } : undefined;
      void manager.sendPrompt(session.id, "fixture", options).catch(() => undefined);
      const call = await nextQueryCall();
      turns.set(session.id, call);
      call.push({
        type: "system",
        subtype: "task_started",
        task_id: "bg",
        description: "Fixture task",
        is_backgrounded: true,
      });
      call.push({ type: "result", subtype: "success" });
      return Response.json({ sessionId: session.id });
    }
    const sessionId = new URL(req.url).searchParams.get("session")!;
    if (path === "/raise") {
      const { mode, tool, input } = (await req.json()) as {
        mode: "form" | "url" | "unsupported" | "question" | "tool";
        tool?: string;
        input?: Record<string, unknown>;
      };
      const call = turns.get(sessionId)!;
      if (mode === "tool") {
        const decision = call.options.canUseTool!(tool!, input ?? {}, {
          signal: new AbortController().signal,
          requestId: `request-${tool}-${(history.get(sessionId) ?? []).length}`,
          toolUseID: `tool-use-${tool}-${(history.get(sessionId) ?? []).length}`,
        } as never);
        void Promise.resolve(decision).then((value) => settle(sessionId, value));
        return Response.json({ raised: true });
      }
      if (mode === "question") {
        const decision = call.options.canUseTool!(
          "AskUserQuestion",
          {
            questions: [
              {
                question: "Which fixture team?",
                header: "Team",
                options: [{ label: "Core" }, { label: "Docs" }],
              },
            ],
          },
          { signal: new AbortController().signal, requestId: "request-question" } as never,
        );
        void Promise.resolve(decision).then((value) => settle(sessionId, value));
        return Response.json({ raised: true });
      }
      const result = call.options.onElicitation!(
        {
          serverName: "fixture-server",
          message: "Fixture input",
          mode: mode === "url" ? "url" : "form",
          ...(mode === "url"
            ? { url: "https://example.com/auth" }
            : {
                requestedSchema: {
                  type: "object",
                  properties: {
                    team:
                      mode === "unsupported"
                        ? { type: "array", items: { type: "string" } }
                        : { type: "string", title: "Team" },
                  },
                  required: ["team"],
                },
              }),
        } as never,
        { signal: new AbortController().signal, requestId: `request-${mode}` },
      );
      void Promise.resolve(result).then((value) => settle(sessionId, value));
      return Response.json({ raised: true });
    }
    if (path === "/snapshot")
      return Response.json({
        snapshot: await adapter.listPendingInteractions(sessionId),
        activity: await manager.getSessionActivity(sessionId),
        status: manager.getSession(sessionId)?.status,
        stopped: turns.get(sessionId)?.options.abortController?.signal.aborted ?? false,
        result: results.get(sessionId),
        history: history.get(sessionId) ?? [],
        policy: effectiveExecutionPolicy(manager.getSession(sessionId)?.executionPolicy)?.id,
        allowedTools: turns.get(sessionId)?.options.allowedTools,
        permissionMode: turns.get(sessionId)?.options.permissionMode,
        notices: manager
          .getSession(sessionId)
          ?.messages.flatMap((message) => message.parts.filter((part) => part.type === "status")),
      });
    if (path === "/pre-tool-use") {
      const { tool, input } = (await req.json()) as { tool: string; input?: unknown };
      return Response.json(await preToolUse(turns.get(sessionId)!, tool, input ?? {}));
    }
    if (path === "/hold") {
      const { interactionId, held } = (await req.json()) as {
        interactionId: string;
        held: boolean;
      };
      return Response.json(await adapter.holdInteraction(sessionId, interactionId, held));
    }
    if (path === "/resolve") {
      const resolution = await req.json();
      return Response.json(
        await adapter.resolveInteraction(sessionId, resolution.interactionId, resolution),
      );
    }
    return new Response("Unknown fixture route", { status: 404 });
  },
});
console.log(`INTERACTION_FIXTURE_READY:${server.port}`);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    for (const sessionId of turns.keys()) manager.deleteSession(sessionId);
    server.stop(true);
    rmSync(home, { recursive: true, force: true });
    process.exit(0);
  });
