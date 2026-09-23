import { describe, expect, test } from "bun:test";

import {
  MCP_MANAGEMENT_LIMITS,
  aggregateApplyState,
  isEnvReference,
  isProtectedMcpServerName,
  isSensitiveArg,
  isSensitiveUrl,
  isUnknownMcpManagementCommandError,
  mcpFailure,
  mcpManagementErrorFromUnknown,
  parseMcpMutation,
  redactUrlForDisplay,
  validateMcpDefinitionInput,
  validateMcpDefinitionPatch,
  visibleArgs,
  visibleUrl,
} from "./mcp-management";

const base = { requestId: "r1", targetId: "mcp1~claude~backend", applyIntent: "save" as const };

describe("mcp-management protocol", () => {
  test("round-trips an error code through string-only transports", () => {
    const flattened = new Error(mcpFailure("revision-conflict").message);
    expect(mcpManagementErrorFromUnknown(flattened)).toMatchObject({
      code: "revision-conflict",
      reload: true,
    });
    expect(mcpManagementErrorFromUnknown(new Error("boom"))).toBeNull();
  });

  test("recognises an older backend by its unknown-command error only", () => {
    expect(
      isUnknownMcpManagementCommandError(
        new Error("Unknown backend command: get_mcp_management_snapshot"),
      ),
    ).toBe(true);
    expect(isUnknownMcpManagementCommandError(new Error("Unauthorized"))).toBe(false);
  });

  test("protects Orkestrator's injected server names in every spelling", () => {
    for (const name of [
      "orkestrator",
      "Orkestrator",
      "orkestrator-design",
      "orkestrator_design",
      "orkestrator_workflow_result",
    ]) {
      expect(isProtectedMcpServerName(name)).toBe(true);
    }
    expect(isProtectedMcpServerName("orkestrator-extras")).toBe(false);
  });

  test("validates a complete stdio definition and rejects shell-shaped mistakes", () => {
    expect(
      validateMcpDefinitionInput({
        name: "docs",
        transport: "stdio",
        command: "npx",
        args: ["-y", "a b; rm"],
      }),
    ).toEqual([]);
    const errors = validateMcpDefinitionInput({
      name: " docs",
      transport: "stdio",
      command: "a\nb",
      url: "https://x",
    });
    expect(errors.map((error) => error.field).sort()).toEqual(["command", "name", "url"]);
  });

  test("rejects URLs with embedded credentials or unsupported schemes", () => {
    expect(
      validateMcpDefinitionInput({
        name: "a",
        transport: "http",
        url: "https://user:pw@example.com/mcp",
      })[0]?.field,
    ).toBe("url");
    expect(
      validateMcpDefinitionInput({ name: "a", transport: "http", url: "file:///etc/passwd" })[0]
        ?.field,
    ).toBe("url");
    expect(
      validateMcpDefinitionInput({ name: "a", transport: "http", url: "https://example.com/mcp" }),
    ).toEqual([]);
  });

  test("rejects prototype keys, duplicate headers and internal credential references", () => {
    const errors = validateMcpDefinitionInput({
      name: "a",
      transport: "http",
      url: "https://example.com",
      headers: [
        { key: "Authorization", value: "x" },
        { key: "authorization", value: "y" },
      ],
      env: [
        { key: "__proto__", value: "x" },
        { key: "TOKEN", value: "${ORKESTRATOR_AGENT_MCP_TOKEN}" },
      ],
    });
    const messages = errors.map((error) => `${error.field}:${error.message}`).join("\n");
    expect(messages).toContain("Duplicate key authorization");
    expect(messages).toContain("env.0.key:This key is reserved.");
    expect(messages).toContain("Orkestrator's own credentials");
  });

  test("enforces byte limits rather than character counts", () => {
    const name = "é".repeat(MCP_MANAGEMENT_LIMITS.nameMaxBytes / 2 + 1);
    expect(validateMcpDefinitionInput({ name, transport: "stdio", command: "x" })[0]?.field).toBe(
      "name",
    );
    const args = Array.from({ length: MCP_MANAGEMENT_LIMITS.argsMax + 1 }, () => "a");
    expect(
      validateMcpDefinitionInput({ name: "a", transport: "stdio", command: "x", args })[0]?.field,
    ).toBe("args");
  });

  test("keep, set and clear stay distinct from an empty string or a mask", () => {
    expect(validateMcpDefinitionPatch({ env: [{ key: "A", edit: { kind: "keep" } }] })).toEqual([]);
    expect(
      validateMcpDefinitionPatch({ env: [{ key: "A", edit: { kind: "set", value: "" } }] }),
    ).toEqual([]);
    expect(validateMcpDefinitionPatch({ env: [{ key: "A", edit: { kind: "clear" } }] })).toEqual(
      [],
    );
    expect(validateMcpDefinitionPatch({ env: [{ key: "A", edit: "••••" }] })[0]?.field).toBe(
      "env.0.edit",
    );
    expect(
      validateMcpDefinitionPatch({ env: [{ key: "A", edit: { kind: "masked" } }] })[0]?.field,
    ).toBe("env.0.edit");
  });

  test("a transport switch must name what it discards", () => {
    expect(validateMcpDefinitionPatch({ transport: { to: "http" } })[0]?.field).toBe("transport");
    expect(validateMcpDefinitionPatch({ transport: { to: "http", discard: ["command"] } })).toEqual(
      [],
    );
  });

  test("parses mutation envelopes and rejects oversized bodies", () => {
    const { mutation, fieldErrors } = parseMcpMutation({
      ...base,
      operation: { kind: "remove", entryId: "claude:user/ZA", expectedRevision: "r1.x" },
    });
    expect(mutation.operation.kind).toBe("remove");
    expect(fieldErrors).toEqual([]);
    expect(() => parseMcpMutation({ ...base, operation: { kind: "nope" } })).toThrow(
      "invalid-request",
    );
    const huge = "x".repeat(MCP_MANAGEMENT_LIMITS.mutationBodyMaxBytes);
    expect(() =>
      parseMcpMutation({
        ...base,
        operation: { kind: "rename", entryId: "a", expectedRevision: "b", newName: huge },
      }),
    ).toThrow("too large");
  });

  test("returns definition field errors for the form instead of throwing", () => {
    const { fieldErrors } = parseMcpMutation({
      ...base,
      operation: {
        kind: "add",
        sourceId: "claude:user",
        expectedRevision: null,
        definition: { name: "orkestrator", transport: "stdio", command: "x" },
      },
    });
    expect(fieldErrors[0]?.field).toBe("name");
  });

  test("redacts credential-looking arguments and URLs", () => {
    expect(isSensitiveArg("--api-key=abc")).toBe(true);
    expect(isSensitiveArg("abc", "--token")).toBe(true);
    expect(isSensitiveArg("Authorization: Bearer x", "-H")).toBe(true);
    expect(isSensitiveArg("ghp_0123456789abcdefghij")).toBe(true);
    expect(isSensitiveArg("-y")).toBe(false);
    expect(isSensitiveArg("@modelcontextprotocol/server-filesystem")).toBe(false);
    expect(visibleArgs(["--token", "SENTINEL-SECRET"])[1]?.value).toEqual({
      kind: "redacted",
      display: "(retained value)",
    });

    expect(isSensitiveUrl("https://example.com/mcp?api_key=SENTINEL")).toBe(true);
    expect(isSensitiveUrl("https://example.com/mcp?format=json")).toBe(false);
    expect(redactUrlForDisplay("https://example.com/mcp?api_key=SENTINEL&x=1")).not.toContain(
      "SENTINEL",
    );
    expect(visibleUrl("https://example.com/mcp")).toEqual({
      kind: "visible",
      value: "https://example.com/mcp",
    });
  });

  test("recognises provider variable references", () => {
    for (const value of [
      "${API_KEY}",
      "$API_KEY",
      "{env:API_KEY}",
      "Bearer ${TOKEN}",
      "Bearer {env:TOKEN}",
    ]) {
      expect(isEnvReference(value)).toBe(true);
    }
    expect(isEnvReference("Bearer abc")).toBe(false);
  });

  test("aggregates per-runtime states with in-progress work first", () => {
    expect(aggregateApplyState([])).toBe("not-requested");
    expect(aggregateApplyState(["applied", "queued"])).toBe("queued");
    expect(aggregateApplyState(["applied", "failed"])).toBe("failed");
    expect(aggregateApplyState(["applied", "pending-next-turn"])).toBe("pending-next-turn");
  });
});
