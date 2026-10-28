import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { harness } from "./app-server-runtime-test-harness.js";

process.env.CODEX_BRIDGE_NO_ENGINE = "1";
process.env.CODEX_BRIDGE_NO_SERVER = "1";
process.env.CODEX_BRIDGE_AUTH_DISABLED_FOR_TESTING = "1";
const { app, __testing } = await import("./index.js");
const routeRuntime = __testing.runtimeForTesting();
const originalPrompt = routeRuntime.prompt;
afterAll(() => {
  routeRuntime.prompt = originalPrompt;
});

const TOOL = "submit_consolidated_review";

describe("workflow result HTTP admission during MCP startup", () => {
  test.each(["connected", "failed", "starting"])(
    "waits with default wiring until %s settles or the 20-second window expires",
    async (status) => {
      let clock = Date.now();
      const started = clock;
      let listings = 0;
      const h = await harness({
        "mcpServerStatus/list": () => {
          listings += 1;
          // Advance only the wall clock used by the real admission helper.
          // Keep real RPC and polling timers so all route/runtime wiring runs.
          clock += 1_000;
          expect(h.child().requests.some((r) => r.method === "turn/start")).toBe(false);
          expect(h.runtime.getJournal().get("startup-result")).toBeUndefined();
          const runtimeStatus = clock - started < 15_000 ? "starting" : status;
          return {
            data: [
              {
                name: "orkestrator",
                runtimeStatus,
                toolsError: null,
                tools: runtimeStatus === "connected" ? { [TOOL]: { name: TOOL } } : {},
              },
            ],
          };
        },
      });
      const { sessionId } = h.runtime.createSession({ mode: "build" });
      routeRuntime.prompt = h.runtime.prompt.bind(h.runtime);
      const now = spyOn(Date, "now").mockImplementation(() => clock);
      try {
        const response = await app.request(`/session/${sessionId}/prompt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: "Submit the report",
            requestId: "startup-result",
            readOnly: true,
            agentMcp: { url: "http://127.0.0.1:4567/mcp", token: "attempt-secret" },
            workflowResultTool: TOOL,
          }),
        });
        expect(response.status).toBe(status === "failed" ? 424 : 202);
        expect(clock - started).toBe(status === "starting" ? 20_000 : 15_000);
        expect(listings).toBe(status === "starting" ? 20 : 15);
        const turns = h.child().requests.filter((r) => r.method === "turn/start");
        expect(turns).toHaveLength(status === "failed" ? 0 : 1);
        if (status === "failed") {
          expect(await response.json()).toEqual({
            error: expect.stringContaining(TOOL),
          });
          expect(h.runtime.getJournal().get("startup-result")).toBeUndefined();
        } else {
          expect(h.runtime.getJournal().classify("startup-result").action).toBe("attach");
        }
      } finally {
        now.mockRestore();
        routeRuntime.prompt = originalPrompt;
      }
    },
    10_000,
  );
});
