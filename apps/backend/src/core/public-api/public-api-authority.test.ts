import { afterEach, describe, expect, test } from "bun:test";
import {
  PUBLIC_ACTIONS,
  PUBLIC_API_SCHEMA_VERSION,
  type PublicActionName,
  type PublicActionResponse,
} from "@orkestrator/protocol/public-api";
import { withPublicAuthority } from "./dispatch.js";
import {
  controlMcpAuthority,
  isPublicAuthority,
  requestKey,
  type PublicAuthority,
} from "./operation-ledger.js";
import { cleanupSessionHarnesses, setup } from "./test-provider.js";
import type { PublicApiHarness } from "./test-support.js";

/**
 * Each Control MCP credential dispatches under its own authority. Authority
 * is part of every request key and scopes every receipt read; it is set
 * in-process only, never from request input.
 */

afterEach(cleanupSessionHarnesses);

function callAs<T = unknown>(
  harness: PublicApiHarness,
  authority: PublicAuthority,
  action: PublicActionName,
  input: Record<string, unknown>,
  requestId?: string,
): Promise<PublicActionResponse<T>> {
  return harness.commands.get("public_action")!(
    withPublicAuthority(
      {
        schemaVersion: PUBLIC_API_SCHEMA_VERSION,
        action,
        actionVersion: PUBLIC_ACTIONS[action].version,
        input,
        ...(requestId ? { request: { requestId } } : {}),
      },
      authority,
    ),
    harness.context,
  ) as Promise<PublicActionResponse<T>>;
}

describe("public action authority", () => {
  test("only operator and control-mcp:<id> authorities exist", () => {
    expect(isPublicAuthority("operator")).toBe(true);
    expect(isPublicAuthority("control-mcp:voice-1")).toBe(true);
    expect(isPublicAuthority("control-mcp:")).toBe(false);
    expect(isPublicAuthority("control-mcp:../x")).toBe(false);
    expect(isPublicAuthority("admin")).toBe(false);
    expect(() => controlMcpAuthority("Bad ID")).toThrow();
    expect(requestKey("operator", "ticket.create", "project:p", "k")).not.toBe(
      requestKey("control-mcp:a", "ticket.create", "project:p", "k"),
    );
  });

  test("an authority in request input is ignored; only the in-process key counts", async () => {
    const { harness, projectId } = await setup();
    const created = await harness.commands.get("public_action")!(
      {
        schemaVersion: PUBLIC_API_SCHEMA_VERSION,
        action: "ticket.create",
        actionVersion: 1,
        input: { projectId, title: "From JSON" },
        request: { requestId: "json-authority" },
        authority: "control-mcp:forged",
      },
      harness.context,
    );
    expect((created as PublicActionResponse).ok).toBe(true);
    const asForged = await callAs(harness, "control-mcp:forged", "run.get", {
      requestId: "json-authority",
    });
    expect(!asForged.ok && asForged.error.code).toBe("not-found");
    const asOperator = await harness.call("run.get", { requestId: "json-authority" });
    expect(asOperator.ok).toBe(true);
  });

  test("the same request ID under different authorities never conflicts or leaks", async () => {
    const { harness, projectId } = await setup();
    const operator = await harness.call<{ ticketId: string }>(
      "ticket.create",
      { projectId, title: "Operator ticket" },
      { requestId: "same-key" },
    );
    const voice = await callAs<{ ticketId: string }>(
      harness,
      "control-mcp:voice",
      "ticket.create",
      { projectId, title: "Voice ticket" },
      "same-key",
    );
    if (!operator.ok || !voice.ok) throw new Error("ticket creation failed");
    expect(voice.result.ticketId).not.toBe(operator.result.ticketId);
    expect(voice.receipt?.replayed).toBe(false);

    // Replays stay within their own authority.
    const voiceReplay = await callAs<{ ticketId: string }>(
      harness,
      "control-mcp:voice",
      "ticket.create",
      { projectId, title: "Voice ticket" },
      "same-key",
    );
    expect(voiceReplay.ok && voiceReplay.result.ticketId).toBe(voice.result.ticketId);

    // Reads by operation ID and by request key are scoped both ways.
    const other = "control-mcp:other" as const;
    for (const [authority, operationId] of [
      [other, voice.receipt!.operationId],
      [other, operator.receipt!.operationId],
      ["control-mcp:voice", operator.receipt!.operationId],
    ] as const) {
      const read = await callAs(harness, authority, "run.get", { operationId });
      expect(!read.ok && read.error.code).toBe("not-found");
    }
    const operatorReadsVoice = await harness.call("run.get", {
      operationId: voice.receipt!.operationId,
    });
    expect(!operatorReadsVoice.ok && operatorReadsVoice.error.code).toBe("not-found");
    const byKey = await callAs(harness, "control-mcp:voice", "run.get", { requestId: "same-key" });
    expect(byKey.receipt?.operationId).toBe(voice.receipt!.operationId);
    const otherByKey = await callAs(harness, other, "run.get", { requestId: "same-key" });
    expect(!otherByKey.ok && otherByKey.error.code).toBe("not-found");
  });

  test("operation-scoped mutations refuse another authority's operation", async () => {
    const { harness } = await setup();
    const started = await harness.call<{ sessionId: string; runId: string }>(
      "session.start",
      { environmentId: "env-1", agent: "claude", prompt: "work" },
      { requestId: "cli-run" },
    );
    if (!started.ok) throw new Error(started.error.message);
    for (const action of ["run.retry", "run.discard", "run.cancel"] as const) {
      const refused = await callAs(
        harness,
        "control-mcp:voice",
        action,
        { operationId: started.result.runId },
        `${action}-1`,
      );
      expect({ action, code: !refused.ok && refused.error.code }).toEqual({
        action,
        code: "not-found",
      });
    }
    const stop = await callAs(
      harness,
      "control-mcp:voice",
      "session.stop",
      { sessionId: started.result.sessionId, expectedOperationId: started.result.runId },
      "stop-1",
    );
    expect(!stop.ok && stop.error.code).toBe("not-found");
  });
});
