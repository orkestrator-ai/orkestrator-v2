import { describe, expect, test } from "bun:test";
import { formatIpcError } from "@orkestrator/protocol/contract/ipc-error";
import { GatewayHttpError } from "@/lib/native/gateway-http-error";
import { isProviderSessionMissingError } from "./useNativeAgentSession";

const MESSAGE = "Native agent provider session was not found";

describe("whether a failed adoption may replace the session", () => {
  test("is decided by the code over every transport", () => {
    // The gateway: `GatewayHttpError` keeps the body's `code`.
    expect(
      isProviderSessionMissingError(
        new GatewayHttpError(500, MESSAGE, {
          error: MESSAGE,
          code: "native-agent-provider-session-missing",
        }),
      ),
    ).toBe(true);
    // Electron IPC: only the message crosses, led by the code.
    expect(
      isProviderSessionMissingError(
        new Error(formatIpcError("native-agent-provider-session-missing", {}, MESSAGE)),
      ),
    ).toBe(true);
    // The code alone decides, whatever the words say.
    expect(
      isProviderSessionMissingError(
        new Error(formatIpcError("native-agent-provider-session-missing", {}, "reworded")),
      ),
    ).toBe(true);
  });

  test("another code never replaces a session, even with the same words", () => {
    expect(
      isProviderSessionMissingError(
        new GatewayHttpError(500, MESSAGE, { error: MESSAGE, code: "node-unavailable" }),
      ),
    ).toBe(false);
  });

  test("falls back to the words from an older backend that sends no code", () => {
    expect(isProviderSessionMissingError(new Error(MESSAGE))).toBe(true);
    expect(
      isProviderSessionMissingError(new GatewayHttpError(500, MESSAGE, { error: MESSAGE })),
    ).toBe(true);
    expect(isProviderSessionMissingError(new Error("Bridge unavailable"))).toBe(false);
    expect(isProviderSessionMissingError(new GatewayHttpError(503, "busy"))).toBe(false);
  });
});
