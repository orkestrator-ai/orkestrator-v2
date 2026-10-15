// Synthetic SDK callbacks through the real Claude bridge routes and backend
// normalization. This process never launches Claude or reads provider secrets.
import { nextQueryCall } from "../../bridges/claude-bridge/src/services/session-manager-test-mocks";
import { setClaudeHomeForTesting } from "../../bridges/claude-bridge/src/services/claude-home";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
import { HttpBridgeInteractionAdapter } from "../../apps/backend/src/core/http-bridge-interactions";

installFatalRejectionGuard({ label: "[claude-interaction-browser-fixture]" });
const home = mkdtempSync(join(tmpdir(), "claude-interaction-browser-"));
setClaudeHomeForTesting(home);
for (const key of [
  "ORKESTRATOR_GITHUB_CREDENTIAL_FILE",
  "GITHUB_TOKEN",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
])
  delete process.env[key];
process.env.GH_TOKEN = "fixture-no-credential";
process.env.CLAUDE_BRIDGE_NO_SERVER = "1";
process.env.CLAUDE_BRIDGE_AUTH_DISABLED_FOR_TESTING = "1";
const { app } = await import("../../bridges/claude-bridge/src/index");
const manager = await import("../../bridges/claude-bridge/src/services/session-manager");
const adapter = new HttpBridgeInteractionAdapter(
  "claude",
  { agent: "claude", baseUrl: "http://fixture", authToken: "fixture" },
  ((input: string | URL | Request, init?: RequestInit) =>
    app.request(String(input), init)) as typeof fetch,
);
const turns = new Map<string, Awaited<ReturnType<typeof nextQueryCall>>>();
const results = new Map<string, unknown>();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/start") {
      const session = manager.createSession("Browser interaction fixture");
      session.executionPolicy = {
        id: "interactive-host",
        sandbox: "none",
        approvals: "ask",
        projectResources: true,
        networkAccess: "full",
      };
      void manager.sendPrompt(session.id, "fixture").catch(() => undefined);
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
      const { mode } = (await req.json()) as { mode: "form" | "url" | "unsupported" };
      const call = turns.get(sessionId)!;
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
      void Promise.resolve(result).then((value) => results.set(sessionId, value));
      return Response.json({ raised: true });
    }
    if (path === "/snapshot")
      return Response.json({
        snapshot: await adapter.listPendingInteractions(sessionId),
        activity: await manager.getSessionActivity(sessionId),
        status: manager.getSession(sessionId)?.status,
        stopped: turns.get(sessionId)?.options.abortController?.signal.aborted ?? false,
        result: results.get(sessionId),
        notices: manager
          .getSession(sessionId)
          ?.messages.flatMap((message) => message.parts.filter((part) => part.type === "status")),
      });
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
