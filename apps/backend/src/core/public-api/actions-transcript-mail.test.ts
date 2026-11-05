import { describe, expect, test } from "bun:test";
import { renderAgentMailCarrier, type AgentMailMessage } from "@orkestrator/protocol/agent-mail";
import { PUBLIC_API_LIMITS } from "@orkestrator/protocol/public-api";
import { compactMessages } from "../control-shared-actions.js";
import { publicTranscriptMessage } from "./actions-transcript.js";

function carrier(body: string): string {
  return renderAgentMailCarrier({
    version: 1,
    id: "mail-1",
    threadId: "mail-1",
    requestId: "request-1",
    createdAt: "2026-11-05T10:00:00.000Z",
    from: {
      kind: "tab",
      projectId: "project-1",
      environmentId: "env-2",
      tabId: "startup-agent",
      incarnationId: "incarnation-1",
      agent: "codex",
      title: "Codex 1",
    },
    toEnvironmentId: "env-1",
    toTabId: "tab-1",
    toIncarnationId: "incarnation-2",
    body,
    bodyBytes: body.length,
    trust: "same-project",
    injectDepth: 0,
    threadDepth: 0,
    placement: "injected",
    revision: 1,
  } satisfies AgentMailMessage);
}

function row(content: string) {
  return {
    id: "row-1",
    role: "user",
    content,
    parts: [{ type: "text", content }],
    createdAt: "2026-11-05T10:00:00.000Z",
  };
}

// Only the renderer draws tiles. An agent reading a transcript replies with the
// message id and needs the framing that says the text is untrusted.
describe("transcript reads keep delivered mail as stored", () => {
  test("get_tab_transcript's and session.transcript's rows hold the whole envelope", () => {
    const content = carrier("Report");

    expect(compactMessages([row(content)]).messages[0]?.content).toBe(content);
    const message = publicTranscriptMessage(row(content));
    expect(message?.text).toBe(content);
    expect(message?.textTruncated).toBe(false);
    expect(message?.text).toContain("untrusted input");
  });

  test("a read that caps a long body still has the message id to reply with", () => {
    const content = carrier("x".repeat(PUBLIC_API_LIMITS.transcriptTextMaxChars * 6));

    for (const text of [
      publicTranscriptMessage(row(content))?.text,
      compactMessages([row(content)]).messages[0]?.content,
    ]) {
      expect(text).toContain('"messageId":"mail-1"');
      expect((text as string).length).toBeLessThan(content.length);
    }
  });
});
