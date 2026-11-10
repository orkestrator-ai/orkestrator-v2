import { describe, expect, test } from "bun:test";
import { ipcErrorMessage } from "@orkestrator/protocol/contract/ipc-error";
import { DESIGN_CONFLICT } from "@orkestrator/protocol/design-canvas";
import { failureOf } from "./design-client";

const conflictText = `${DESIGN_CONFLICT} expected 1, current 2. Fetch the latest snapshot before editing.`;

/** A backend design conflict as the gateway client rebuilds it: HTTP 500 with the registered code. */
function gatewayConflict(): Error {
  return Object.assign(new Error(conflictText), {
    status: 500,
    code: "design-revision-conflict",
  });
}

describe("failureOf for a thrown design revision conflict", () => {
  test("reads the registered code over the gateway despite its 500 status", () => {
    expect(failureOf(gatewayConflict())).toEqual({
      code: "conflict",
      message: conflictText,
      retry: "after-refresh",
    });
  });

  test("reads the IPC message form and shows the text without its prefix", () => {
    const overIpc = new Error(ipcErrorMessage(gatewayConflict()) ?? "");
    expect(overIpc.message).toStartWith("[design-revision-conflict] ");
    expect(failureOf(overIpc)).toMatchObject({ code: "conflict", message: conflictText });
  });

  test("falls back to the marker from an older backend, whose code was unregistered", () => {
    const legacy = Object.assign(new Error(conflictText), { status: 500, code: "conflict" });
    expect(failureOf(legacy).code).toBe("conflict");
    expect(failureOf(new Error(conflictText)).code).toBe("conflict");
  });

  test("leaves other failures to the transport classification", () => {
    expect(failureOf(Object.assign(new Error("boom"), { status: 500 })).code).toBe("disconnected");
    expect(failureOf(new Error("Design operation failed")).code).toBe("storage");
  });
});
