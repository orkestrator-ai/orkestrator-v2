import { describe, expect, test } from "bun:test";
import { renderAgentMailCarrier, type AgentMailMessage } from "@orkestrator/protocol/agent-mail";
import { buildPromptWithTranscriptAnnotations } from "@orkestrator/protocol/transcript-annotations";
import { titleFromTranscriptHead } from "./tmux-hooks.js";

function userLine(content: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content } });
}

function mailCarrier(overrides: Partial<AgentMailMessage> = {}): string {
  return renderAgentMailCarrier({
    version: 1,
    id: "mail-1",
    threadId: "mail-1",
    requestId: "request-1",
    createdAt: "2026-11-05T10:00:00.000Z",
    from: {
      kind: "tab",
      projectId: "project-1",
      environmentId: "env-sender",
      tabId: "tab-sender",
      incarnationId: "incarnation-1",
      agent: "codex",
      title: "Codex 1",
    },
    toEnvironmentId: "env-1",
    toTabId: "tab-1",
    toIncarnationId: "incarnation-2",
    subject: "Sender's chosen subject",
    body: "Report",
    bodyBytes: 6,
    trust: "same-project",
    injectDepth: 0,
    threadDepth: 0,
    placement: "injected",
    revision: 1,
    ...overrides,
  });
}

describe("titleFromTranscriptHead", () => {
  test("titles a tmux session from the request, not the annotation block after it", () => {
    const request = "Explain why the reconnect banner flickers after a resume in the web app";
    const prompt = buildPromptWithTranscriptAnnotations(request, [
      { id: "excerpt-1", text: "The banner re-renders on every poll", comment: "this part" },
    ]);
    const head = `${JSON.stringify({ type: "summary" })}\n${userLine(prompt)}\n`;

    expect(titleFromTranscriptHead(head, false)).toBe(request);
  });

  test("skips a first message that is only an annotation block", () => {
    const annotationsOnly = buildPromptWithTranscriptAnnotations("", [
      { id: "excerpt-1", text: "Quoted output", comment: "" },
    ]);
    const head = `${userLine(annotationsOnly)}\n${userLine("Follow-up request")}\n`;

    expect(titleFromTranscriptHead(head, false)).toBe("Follow-up request");
  });

  test("keeps a malformed block visible, as the transcript does", () => {
    const text =
      "<orkestrator_transcript_annotations>not json</orkestrator_transcript_annotations>";

    expect(titleFromTranscriptHead(`${userLine(text)}\n`, false)).toBe(text.slice(0, 80) + "...");
  });

  test("titles a session from the next real prompt when mail arrived first", () => {
    const head = `${userLine(mailCarrier())}\n${userLine("Fix the reconnect banner")}\n`;

    expect(titleFromTranscriptHead(head, false)).toBe("Fix the reconnect banner");
  });

  test("leaves a session holding only mail untitled, never its markup or subject", () => {
    const batch = `${mailCarrier({ id: "mail-a" })}\n\n${mailCarrier({ id: "mail-b" })}`;

    expect(titleFromTranscriptHead(`${userLine(mailCarrier())}\n`, false)).toBeNull();
    expect(titleFromTranscriptHead(`${userLine(batch)}\n`, false)).toBeNull();
  });

  test("skips mail in the forms a transcript stores it", () => {
    const carrier = mailCarrier();
    const blocks = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: carrier }] },
    });
    // A tmux paste can store carriage returns where the carrier has line feeds.
    const pasted = carrier.replaceAll("\n", "\r");

    expect(titleFromTranscriptHead(`${blocks}\n`, false)).toBeNull();
    expect(titleFromTranscriptHead(`${userLine(pasted)}\n`, false)).toBeNull();
  });

  test("strips system instructions before classifying mail", () => {
    const frame = (text: string) =>
      `<orkestrator-system-instructions>${text}</orkestrator-system-instructions>`;
    expect(
      titleFromTranscriptHead(
        `${userLine(frame("Instructions") + mailCarrier())}\n${userLine("Request")}`,
        false,
      ),
    ).toBe("Request");
    expect(titleFromTranscriptHead(userLine(frame(mailCarrier()) + "Request"), false)).toBe(
      "Request",
    );
  });

  test("still titles a session from a prompt that only looks like mail", () => {
    for (const prompt of [
      "What is <orkestrator-peer-message>?",
      "<orkestrator-peer-message>foo</orkestrator-peer-message> why?",
      '<orkestrator-peer-message version="1"> is what I see',
      '<orkestrator-peer-message version="1"><orkestrator-peer-payload-json> is this?',
    ]) {
      expect(titleFromTranscriptHead(`${userLine(prompt)}\n`, false)).toBe(prompt);
    }
  });
});
