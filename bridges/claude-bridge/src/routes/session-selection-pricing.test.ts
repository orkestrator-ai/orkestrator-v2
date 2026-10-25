// Exercise the real query configuration and HTTP publication; only the SDK
// process boundary is simulated by the shared harness.
import {
  createSession,
  nextQueryCall,
  sendPrompt,
  track,
} from "../services/session-manager-test-harness.js";
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
const { default: routes } = await import("./session.js");
const app = new Hono().route("/session", routes);

describe("Claude selection pricing", () => {
  test.each([
    { fastMode: false, context1m: false },
    { fastMode: true, context1m: false },
    { fastMode: false, context1m: true },
    { fastMode: true, context1m: true },
  ])("withholds unverified pricing for %j", async ({ fastMode, context1m }) => {
    const session = createSession("selection pricing");
    track(session.id);
    const pending = sendPrompt(session.id, "Use the selected settings", {
      model: "claude-sonnet-test",
      fastMode,
      parameterValues: { context1m },
    });
    const call = await nextQueryCall();
    try {
      expect(call.options.settings?.fastMode).toBe(fastMode ? true : undefined);
      expect(call.options.betas).toEqual(context1m ? ["context-1m-2025-08-07"] : undefined);
      // Neither the toggle nor a context beta proves the current selection
      // bills above standard. Claude supplies no verified pricing rule here.
      for (const phase of ["running", "settled"]) {
        if (phase === "settled") {
          call.push({ type: "result", subtype: "success" });
          call.finish();
          await pending;
        }
        const response = await app.request(`/session/${session.id}`);
        expect(response.status).toBe(200);
        const snapshot = await response.json();
        expect(snapshot.status).toBe(phase === "running" ? "running" : "idle");
        expect(snapshot).not.toHaveProperty("selectionPricing");
        expect(snapshot.composer?.selectionPricing).toBeUndefined();
      }
    } finally {
      call.finish();
      await pending;
    }
  });
});
