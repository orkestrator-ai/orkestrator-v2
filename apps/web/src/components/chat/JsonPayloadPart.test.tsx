import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TEST_STRUCTURED_REVIEW_REPORT } from "@/components/build-pipeline/structured-review-test-fixture";
import { parseJsonPayload } from "@/lib/chat/json-payload";
import type { JsonPayload } from "@/lib/chat/json-payload";
import { NativeMessage } from "./NativeMessage";
import { JsonPayloadPart } from "./JsonPayloadPart";

afterEach(cleanup);

function payloadOf(content: string): JsonPayload {
  const payload = parseJsonPayload(content);
  if (!payload) throw new Error("Expected the content to parse as a payload.");
  return payload;
}

function makeMessage(
  content: string,
  role: "user" | "assistant" = "assistant",
) {
  return {
    id: `${role}-1`,
    role,
    content: "",
    createdAt: "2026-07-30T10:00:00.000Z",
    parts: [{ type: "text" as const, content }],
  };
}

describe("JsonPayloadPart", () => {
  test("summarizes a structured review report without expanding it", () => {
    render(
      <JsonPayloadPart
        payload={payloadOf(JSON.stringify(TEST_STRUCTURED_REVIEW_REPORT))}
      />,
    );

    expect(screen.getByText("Structured review report")).toBeTruthy();
    expect(screen.getByText(/Ready: with-fixes/)).toBeTruthy();
    // The report's own sections stay unmounted until the fold-out is opened.
    expect(screen.queryByText("Review Scope")).toBeNull();
  });

  test("opens the report's sections on demand", () => {
    render(
      <JsonPayloadPart
        payload={payloadOf(JSON.stringify(TEST_STRUCTURED_REVIEW_REPORT))}
      />,
    );

    fireEvent.click(screen.getByText("Structured review report"));

    expect(screen.getByText("Review Scope")).toBeTruthy();
    expect(screen.getByText("Verdict")).toBeTruthy();
    // The trigger already names the report; the card must not repeat it.
    expect(screen.queryByRole("heading", { name: "Structured review report" }))
      .toBeNull();
  });

  test("states the verification outcome without being opened", () => {
    render(
      <JsonPayloadPart
        payload={payloadOf(
          '{"complete":true,"rationale":"Working tree is clean.\\nThe UI suite passed."}',
        )}
      />,
    );

    expect(screen.getByText("Verification passed")).toBeTruthy();
    // The rationale is flattened onto the collapsed row and shown in full below.
    expect(screen.getByText("Working tree is clean. The UI suite passed."))
      .toBeTruthy();

    fireEvent.click(screen.getByText("Verification passed"));

    // Expanded, the rationale keeps the line breaks the summary flattened.
    const rendered = screen
      .getAllByText("Working tree is clean. The UI suite passed.")
      .map((element) => element.textContent);
    expect(rendered).toContain("Working tree is clean.\nThe UI suite passed.");
  });

  test("names a failed verification as failed", () => {
    render(
      <JsonPayloadPart
        payload={payloadOf(
          '{"complete":false,"rationale":"A criterion is unmet."}',
        )}
      />,
    );

    expect(screen.getByText("Verification failed")).toBeTruthy();
    expect(screen.queryByText("JSON payload")).toBeNull();
  });

  test("renders an unrecognized payload as labelled fields", () => {
    render(
      <JsonPayloadPart
        payload={payloadOf('{"stageName":"verify","attempts":2,"logs":[]}')}
      />,
    );

    expect(screen.getByText("JSON payload")).toBeTruthy();
    expect(screen.getByText("3 fields")).toBeTruthy();

    fireEvent.click(screen.getByText("JSON payload"));

    expect(screen.getByText("Stage name")).toBeTruthy();
    expect(screen.getByText("verify")).toBeTruthy();
    expect(screen.getByText("Attempts")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    // An empty list has nothing to fold out, so it says so in place.
    expect(screen.getByText("None")).toBeTruthy();
  });

  test("folds a nested container behind its own disclosure", () => {
    render(
      <JsonPayloadPart
        payload={payloadOf('{"verdict":{"ready":"no","reasoning":"Pending."}}')}
      />,
    );

    fireEvent.click(screen.getByText("JSON payload"));

    expect(screen.getByText("Verdict")).toBeTruthy();
    expect(screen.getByText("2 fields")).toBeTruthy();
    expect(screen.queryByText("Pending.")).toBeNull();

    fireEvent.click(screen.getByText("Verdict"));

    expect(screen.getByText("Pending.")).toBeTruthy();
  });

  test("names each record in a list of records", () => {
    render(
      <JsonPayloadPart
        payload={payloadOf(
          '{"commandsRun":[{"command":"bun test","result":"passed"}]}',
        )}
      />,
    );

    fireEvent.click(screen.getByText("JSON payload"));

    expect(screen.getByText("Commands run")).toBeTruthy();

    fireEvent.click(screen.getByText("Commands run"));

    expect(screen.getByText("1. bun test")).toBeTruthy();
  });
});

describe("NativeMessage JSON payload handling", () => {
  test("folds an assistant message that is nothing but a report", () => {
    render(
      <NativeMessage
        message={makeMessage(JSON.stringify(TEST_STRUCTURED_REVIEW_REPORT))}
      />,
    );

    expect(screen.getByText("Structured review report")).toBeTruthy();
    expect(document.body.textContent).not.toContain('"reviewScope"');
  });

  test("leaves prose around a JSON snippet to the markdown renderer", () => {
    render(
      <NativeMessage
        message={makeMessage('Here is the payload:\n\n```json\n{"a":1}\n```')}
      />,
    );

    expect(screen.queryByText("JSON payload")).toBeNull();
    expect(screen.getByText("Here is the payload:")).toBeTruthy();
  });

  test("shows the user their own message as written", () => {
    render(
      <NativeMessage message={makeMessage('{"a":1}', "user")} />,
    );

    expect(screen.queryByText("JSON payload")).toBeNull();
    expect(document.body.textContent).toContain('{"a":1}');
  });
});
