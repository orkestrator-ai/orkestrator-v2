import "./testing/unit-test-env.js";
import { describe, expect, test } from "bun:test";
import { isArtifactServerToolCall } from "./acp-artifact-permission.js";
import {
  configuredAcpMcpServers,
  mcpConnectionKey,
  parseAgentMcpConnection,
} from "./acp-context.js";

const options = [
  { optionId: "reject", name: "Reject", kind: "reject_once" },
  { optionId: "allow", name: "Allow", kind: "allow_once" },
];
const connection = {
  url: "http://127.0.0.1:4567/mcp",
  token: "attempt-capability",
  artifacts: { token: "oag1.turn-grant" },
};

describe("a workflow turn's artifact-only server", () => {
  test("is launched beside the attempt's server under the turn's own grant", () => {
    expect(parseAgentMcpConnection(connection)).toEqual(connection);
    expect(configuredAcpMcpServers(connection)).toEqual([
      {
        name: "orkestrator",
        type: "http",
        url: "http://127.0.0.1:4567/mcp",
        headers: [{ name: "Authorization", value: "Bearer attempt-capability" }],
      },
      {
        name: "orkestrator-artifacts",
        type: "http",
        url: "http://127.0.0.1:4567/artifact-mcp",
        headers: [{ name: "Authorization", value: "Bearer oag1.turn-grant" }],
      },
    ]);
    // A new turn's grant re-attaches the agent with it.
    expect(mcpConnectionKey(connection)).not.toBe(
      mcpConnectionKey({ ...connection, artifacts: { token: "oag1.next-grant" } }),
    );
    expect(
      configuredAcpMcpServers({ url: connection.url, token: "tab-token" }).map((s) => s.name),
    ).toEqual(["orkestrator"]);
  });

  test("its tools are identified by server, never by a bare name", () => {
    for (const toolCall of [
      {
        toolCallId: "1",
        _meta: { "x.ai/tool": { name: "orkestrator-artifacts__publish_artifact" } },
      },
      { toolCallId: "2", name: "mcp__orkestrator-artifacts__create_artifact" },
      {
        toolCallId: "3",
        _meta: { "x.ai/tool": { name: "preview_artifact", namespace: "orkestrator-artifacts" } },
      },
      {
        toolCallId: "4",
        _meta: { "x.ai/tool": { name: "use_tool" } },
        rawInput: { tool_name: "orkestrator-artifacts__publish_artifact", tool_input: "{}" },
      },
    ]) {
      expect(isArtifactServerToolCall({ toolCall, options }, connection)).toBe(true);
    }
    for (const toolCall of [
      { toolCallId: "5", name: "publish_artifact" },
      { toolCallId: "6", name: "mcp__other__publish_artifact" },
      { toolCallId: "7", name: "mcp__orkestrator-artifacts__submit_review_report" },
      { toolCallId: "8", kind: "execute", name: "mcp__orkestrator-artifacts__publish_artifact" },
    ]) {
      expect(isArtifactServerToolCall({ toolCall, options }, connection)).toBe(false);
    }
    // Only while the backend attached one for this turn.
    expect(
      isArtifactServerToolCall(
        {
          toolCall: { toolCallId: "9", name: "mcp__orkestrator-artifacts__publish_artifact" },
          options,
        },
        { url: connection.url, token: connection.token },
      ),
    ).toBe(false);
  });
});
