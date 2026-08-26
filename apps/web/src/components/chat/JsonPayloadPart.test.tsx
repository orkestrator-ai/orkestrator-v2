import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  MULTI_REVIEW_REPORTS_DISPLAY_CONTRACT,
  STRUCTURED_REVIEW_FINDINGS_DISPLAY_CONTRACT,
  type ReviewEvidenceFrameDisplayContract,
} from "@orkestrator/protocol/review-evidence-frames";
import { TEST_STRUCTURED_REVIEW_REPORT } from "@/components/build-pipeline/structured-review-test-fixture";
import { jsonPayloadSearchText, parseJsonPayload } from "@/lib/chat/json-payload";
import type { JsonPayload } from "@/lib/chat/json-payload";
import { useMessagePartExpansionStore } from "@/stores/messagePartExpansionStore";
import { mockWriteText } from "../../../../../tests/mocks/clipboard";
import { TextPart } from "./NativeMessage.file-parts";
import { NativeMessage } from "./NativeMessage";
import { getNativeMessageSearchText } from "./native-message-search";
import { JsonPayloadPart } from "./JsonPayloadPart";

afterEach(cleanup);

// The store outlives a component by design, which is the whole point of it —
// so each test has to start from a known-empty set.
beforeEach(() => {
  useMessagePartExpansionStore.getState().reset();
});

function payloadOf(content: string): JsonPayload {
  const payload = parseJsonPayload(content);
  if (!payload) throw new Error("Expected the content to parse as a payload.");
  return payload;
}

function makeMessage(content: string, role: "user" | "assistant" = "assistant") {
  return {
    id: `${role}-1`,
    role,
    content: "",
    createdAt: "2026-07-30T10:00:00.000Z",
    parts: [{ type: "text" as const, content }],
  };
}

function evidencePrompt(
  contract: ReviewEvidenceFrameDisplayContract,
  evidence: string,
  continuationSuffix = "",
): string {
  return `${contract.promptPrefix} The evidence below is backend context.\n\n${contract.openMarker}\n${evidence}\n${contract.closeMarker}\n\n${contract.continuationPrefix}${continuationSuffix}`;
}

/** Everything find would walk for this message, in DOM order. */
function renderedSearchText(container: HTMLElement): string {
  return Array.from(container.querySelectorAll("[data-agent-chat-search-content]"))
    .map((root) => root.textContent ?? "")
    .join("\n\n");
}

describe("JsonPayloadPart", () => {
  test("summarizes a structured review report without expanding it", () => {
    render(
      <JsonPayloadPart
        payload={payloadOf(JSON.stringify(TEST_STRUCTURED_REVIEW_REPORT))}
        expansionKey="report"
      />,
    );

    expect(screen.getByText("Structured review report")).toBeTruthy();
    expect(screen.getByText(/Ready: with-fixes/)).toBeTruthy();
    // The report's own sections stay unmounted until the fold-out is opened.
    expect(screen.queryByText("Review Scope") === null).toBe(true);
  });

  test("opens the report's sections on demand", () => {
    render(
      <JsonPayloadPart
        payload={payloadOf(JSON.stringify(TEST_STRUCTURED_REVIEW_REPORT))}
        expansionKey="report"
      />,
    );

    fireEvent.click(screen.getByText("Structured review report"));

    expect(screen.getByText("Review Scope")).toBeTruthy();
    expect(screen.getByText("Verdict")).toBeTruthy();
    // The trigger already names the report; the card must not repeat it.
    expect(screen.queryByRole("heading", { name: "Structured review report" }) === null).toBe(true);
  });

  test("states the verification outcome without being opened", () => {
    render(
      <JsonPayloadPart
        payload={payloadOf(
          '{"complete":true,"rationale":"Working tree is clean.\\nThe UI suite passed."}',
        )}
        expansionKey="verdict"
      />,
    );

    expect(screen.getByText("Verification passed")).toBeTruthy();
    // The rationale is flattened onto the collapsed row and shown in full below.
    expect(screen.getByText("Working tree is clean. The UI suite passed.")).toBeTruthy();

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
        payload={payloadOf('{"complete":false,"rationale":"A criterion is unmet."}')}
        expansionKey="verdict"
      />,
    );

    expect(screen.getByText("Verification failed")).toBeTruthy();
    expect(screen.queryByText("JSON payload") === null).toBe(true);
  });

  test("renders an unrecognized payload as labelled fields", () => {
    render(
      <JsonPayloadPart
        payload={payloadOf('{"stageName":"verify","attempts":2,"logs":[]}')}
        expansionKey="payload"
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
        expansionKey="payload"
      />,
    );

    fireEvent.click(screen.getByText("JSON payload"));

    expect(screen.getByText("Verdict")).toBeTruthy();
    expect(screen.getByText("2 fields")).toBeTruthy();
    expect(screen.queryByText("Pending.") === null).toBe(true);

    fireEvent.click(screen.getByText("Verdict"));

    expect(screen.getByText("Pending.")).toBeTruthy();
  });

  test("names each record in a list of records", () => {
    render(
      <JsonPayloadPart
        payload={payloadOf('{"commandsRun":[{"command":"bun test","result":"passed"}]}')}
        expansionKey="payload"
      />,
    );

    fireEvent.click(screen.getByText("JSON payload"));
    expect(screen.getByText("Commands run")).toBeTruthy();

    fireEvent.click(screen.getByText("Commands run"));
    expect(screen.getByText("1. bun test")).toBeTruthy();
  });

  test("keeps the exact document reachable behind a raw disclosure", () => {
    // The tree humanizes keys, so it cannot show what the agent actually
    // wrote. Nothing may be unreachable without leaving the transcript.
    const source = '{"stageName":"verify","duplicate":1,"duplicate":2,"exponent":1e3}';
    render(<JsonPayloadPart payload={payloadOf(source)} expansionKey="payload" />);

    fireEvent.click(screen.getByText("JSON payload"));
    expect(document.body.textContent).not.toContain('"stageName"');

    fireEvent.click(screen.getByText("Raw JSON"));
    expect(
      screen.getByText(
        (_, element) => element?.tagName === "PRE" && element.textContent === source,
      ),
    ).toBeTruthy();
  });

  test("opens a deeply nested bounded payload without pretty-print amplification", () => {
    const source = `${"[".repeat(5_000)}0${"]".repeat(5_000)}`;
    const payload = payloadOf(source);
    const view = render(<JsonPayloadPart payload={payload} expansionKey="deep-payload" />);

    fireEvent.click(screen.getByText("JSON list"));
    expect(screen.getByText("Raw JSON")).toBeTruthy();
    expect(view.container.querySelector("pre") === null).toBe(true);

    fireEvent.click(screen.getByText("Raw JSON"));
    expect(view.container.querySelector("pre")?.textContent).toBe(source);
  });
});

describe("JsonPayloadPart expansion persistence", () => {
  test("an opened payload survives the list unmounting its row", () => {
    const payload = payloadOf('{"stageName":"verify"}');
    const view = render(<JsonPayloadPart payload={payload} expansionKey="msg-1/part-0/json" />);

    fireEvent.click(screen.getByText("JSON payload"));
    expect(screen.getByText("Stage name")).toBeTruthy();

    // Virtuoso unmounts a row as soon as it leaves the viewport window.
    view.unmount();
    render(<JsonPayloadPart payload={payload} expansionKey="msg-1/part-0/json" />);

    expect(screen.getByText("Stage name")).toBeTruthy();
  });

  test("an opened nested branch survives the same unmount", () => {
    const payload = payloadOf('{"verdict":{"ready":"no","reasoning":"Pending."}}');
    const view = render(<JsonPayloadPart payload={payload} expansionKey="msg-1/part-0/json" />);

    fireEvent.click(screen.getByText("JSON payload"));
    fireEvent.click(screen.getByText("Verdict"));
    expect(screen.getByText("Pending.")).toBeTruthy();

    view.unmount();
    render(<JsonPayloadPart payload={payload} expansionKey="msg-1/part-0/json" />);

    expect(screen.getByText("Pending.")).toBeTruthy();
  });

  test("an opened raw disclosure survives the same unmount", () => {
    const source = '{"stageName":"verify"}';
    const payload = payloadOf(source);
    const view = render(<JsonPayloadPart payload={payload} expansionKey="msg-1/part-0/json" />);

    fireEvent.click(screen.getByText("JSON payload"));
    fireEvent.click(screen.getByText("Raw JSON"));
    expect(view.container.querySelector("pre")?.textContent).toBe(source);

    view.unmount();
    const remounted = render(
      <JsonPayloadPart payload={payload} expansionKey="msg-1/part-0/json" />,
    );
    expect(remounted.container.querySelector("pre")?.textContent).toBe(source);
  });

  test("an opened structured-review section survives the same unmount", () => {
    const payload = payloadOf(JSON.stringify(TEST_STRUCTURED_REVIEW_REPORT));
    const view = render(<JsonPayloadPart payload={payload} expansionKey="msg-1/part-0/json" />);

    fireEvent.click(screen.getByText("Structured review report"));
    fireEvent.click(screen.getByRole("button", { name: /What Changed/ }));
    expect(screen.getByText(TEST_STRUCTURED_REVIEW_REPORT.whatChanged.overview)).toBeTruthy();

    view.unmount();
    render(<JsonPayloadPart payload={payload} expansionKey="msg-1/part-0/json" />);
    expect(screen.getByText(TEST_STRUCTURED_REVIEW_REPORT.whatChanged.overview)).toBeTruthy();
  });

  test("two payloads with different keys expand independently", () => {
    const payload = payloadOf('{"stageName":"verify"}');
    render(
      <>
        <JsonPayloadPart payload={payload} expansionKey="msg-1/part-0/json" />
        <JsonPayloadPart payload={payload} expansionKey="msg-1/part-1/json" />
      </>,
    );

    fireEvent.click(screen.getAllByText("JSON payload")[0]!);

    expect(screen.getAllByText("Stage name")).toHaveLength(1);
  });
});

describe("NativeMessage JSON payload handling", () => {
  test("folds an assistant message that is nothing but a report", () => {
    render(<NativeMessage message={makeMessage(JSON.stringify(TEST_STRUCTURED_REVIEW_REPORT))} />);

    expect(screen.getByText("Structured review report")).toBeTruthy();
    expect(document.body.textContent).not.toContain('"reviewScope"');
  });

  test("folds a JSON-only message that arrived without text parts", () => {
    // The legacy shape: content on the message, no parts array entries.
    render(
      <NativeMessage
        message={{
          id: "assistant-legacy",
          role: "assistant",
          content: '{"complete":true,"rationale":"Clean."}',
          createdAt: "2026-07-30T10:00:00.000Z",
          parts: [],
        }}
      />,
    );

    expect(screen.getByText("Verification passed")).toBeTruthy();
    expect(document.body.textContent).not.toContain('"rationale"');
  });

  test("leaves prose around a JSON snippet to the markdown renderer", () => {
    render(
      <NativeMessage message={makeMessage('Here is the payload:\n\n```json\n{"a":1}\n```')} />,
    );

    expect(screen.queryByText("JSON payload") === null).toBe(true);
    expect(screen.getByText("Here is the payload:")).toBeTruthy();
  });

  test("leaves a fenced block of unrecognized JSON as readable source", () => {
    render(
      <NativeMessage message={makeMessage('```json\n{"compilerOptions":{"strict":true}}\n```')} />,
    );

    expect(screen.queryByText("JSON payload") === null).toBe(true);
    expect(document.body.textContent).toContain('"compilerOptions"');
  });

  test("still folds a fenced verification verdict", () => {
    render(
      <NativeMessage
        message={makeMessage('```json\n{"complete":false,"rationale":"Unmet."}\n```')}
      />,
    );

    expect(screen.getByText("Verification failed")).toBeTruthy();
  });

  test("shows the user their own message as written", () => {
    render(<NativeMessage message={makeMessage('{"a":1}', "user")} />);

    expect(screen.queryByText("JSON payload") === null).toBe(true);
    expect(document.body.textContent).toContain('{"a":1}');
  });

  test("shows legacy user JSON from message.content as written", () => {
    render(
      <NativeMessage
        message={{
          id: "user-legacy",
          role: "user",
          content: '{"complete":true,"rationale":"Keep raw."}',
          createdAt: "2026-07-30T10:00:00.000Z",
          parts: [],
        }}
      />,
    );

    expect(screen.queryByText("Verification passed") === null).toBe(true);
    expect(document.body.textContent).toContain('"rationale"');
  });
});

describe("NativeMessage find-index alignment", () => {
  // Find derives its match list from the message model but draws highlights
  // from mounted DOM text, assigning them by occurrence ordinal within the
  // row. If the two disagree, a match is either unhighlightable or lands on
  // the wrong text. These assert they agree exactly.
  test("a folded report indexes exactly what the collapsed row renders", () => {
    const message = makeMessage(JSON.stringify(TEST_STRUCTURED_REVIEW_REPORT));
    const view = render(<NativeMessage message={message} />);

    expect(getNativeMessageSearchText(message)).toBe(renderedSearchText(view.container));
  });

  test("a folded verdict indexes exactly what the collapsed row renders", () => {
    const message = makeMessage('{"complete":true,"rationale":"Tree clean.\\nSuite passed."}');
    const view = render(<NativeMessage message={message} />);

    const searchText = getNativeMessageSearchText(message);
    expect(searchText).toBe(renderedSearchText(view.container));
    // The rationale is still findable — it is on the collapsed row.
    expect(searchText).toContain("Tree clean. Suite passed.");
    // The raw document is not, because none of it is in the DOM to highlight.
    expect(searchText).not.toContain('"rationale"');
  });

  test("a generic payload indexes its title and count, not its keys", () => {
    const message = makeMessage('{"stageName":"verify","attempts":2}');
    const view = render(<NativeMessage message={message} />);

    expect(getNativeMessageSearchText(message)).toBe(renderedSearchText(view.container));
    expect(getNativeMessageSearchText(message)).not.toContain("stageName");
  });

  test("a folded part does not shift a sibling part's occurrence numbering", () => {
    // The failure this guards: the model counts matches inside the unmounted
    // payload, so every later occurrence in the row is numbered past the
    // ranges the DOM can actually produce, and the highlight lands wrong.
    const message = {
      id: "assistant-2",
      role: "assistant" as const,
      content: "",
      createdAt: "2026-07-30T10:00:00.000Z",
      parts: [
        { type: "text" as const, content: '{"verify":"verify","v":"verify"}' },
        { type: "text" as const, content: "Then verify the branch." },
      ],
    };
    const view = render(<NativeMessage message={message} />);

    const searchText = getNativeMessageSearchText(message);
    expect(searchText).toBe(renderedSearchText(view.container));
    // The three "verify" occurrences inside the folded document are not
    // counted, so the prose match keeps the ordinal the DOM will produce.
    expect(searchText.match(/verify/g) ?? []).toHaveLength(1);
  });

  test("an expanded payload still exposes only its trigger to find", () => {
    const message = {
      id: "assistant-expanded",
      role: "assistant" as const,
      content: "",
      createdAt: "2026-07-30T10:00:00.000Z",
      parts: [
        { type: "text" as const, content: '{"verify":"verify"}' },
        { type: "text" as const, content: "Then verify the branch." },
      ],
    };
    const view = render(<NativeMessage message={message} />);

    fireEvent.click(screen.getByText("JSON payload"));

    const searchText = getNativeMessageSearchText(message);
    expect(searchText).toBe(renderedSearchText(view.container));
    expect(searchText.match(/verify/g) ?? []).toHaveLength(1);
    expect(document.body.textContent).toContain("verify");
  });

  test("a user's own JSON message is still indexed as written", () => {
    const message = makeMessage('{"complete":true,"rationale":"Clean."}', "user");

    // Not folded for a user, so the index must not fold it either.
    expect(getNativeMessageSearchText(message)).toContain("rationale");
  });

  test("a Multi Review consolidation prompt omits its structured evidence from display and find", () => {
    const contract = MULTI_REVIEW_REPORTS_DISPLAY_CONTRACT;
    const message = makeMessage(
      evidencePrompt(
        contract,
        '[{"reviewerId":"reviewer-1","report":{"summary":"Duplicated evidence"}}]',
        '"main".',
      ),
      "user",
    );
    const view = render(<NativeMessage message={message} />);
    const searchText = getNativeMessageSearchText(message);

    expect(view.container.textContent).toContain(contract.omissionText);
    expect(view.container.textContent).toContain("Produce one complete structured review report");
    expect(view.container.textContent).not.toContain("Duplicated evidence");
    expect(view.container.textContent).not.toContain("multi-review-reports-json");
    expect(searchText).toContain("Produce one complete structured review report");
    expect(searchText).not.toContain("Duplicated evidence");
    expect(searchText).not.toContain("multi-review-reports-json");
  });

  test("a fix-phase prompt omits its structured findings from display and find", () => {
    const contract = STRUCTURED_REVIEW_FINDINGS_DISPLAY_CONTRACT;
    const message = makeMessage(
      evidencePrompt(contract, '{"issues":[{"title":"Duplicated finding"}]}'),
      "user",
    );
    const view = render(<NativeMessage message={message} />);
    const searchText = getNativeMessageSearchText(message);

    expect(view.container.textContent).toContain(contract.omissionText);
    expect(view.container.textContent).toContain(contract.continuationPrefix);
    expect(view.container.textContent).not.toContain("Duplicated finding");
    expect(searchText).toContain(contract.omissionText);
    expect(searchText).not.toContain("Duplicated finding");
  });

  test("filters a legacy user message without text parts in display and find", () => {
    const contract = MULTI_REVIEW_REPORTS_DISPLAY_CONTRACT;
    const source = evidencePrompt(contract, '[{"summary":"Legacy evidence"}]', '"main".');
    const message = {
      id: "user-legacy-evidence",
      role: "user" as const,
      content: source,
      createdAt: "2026-07-30T10:00:00.000Z",
      parts: [],
    };
    const view = render(<NativeMessage message={message} />);
    const searchText = getNativeMessageSearchText(message);

    expect(view.container.textContent).toContain(contract.omissionText);
    expect(view.container.textContent).not.toContain("Legacy evidence");
    expect(searchText).toContain(contract.omissionText);
    expect(searchText).not.toContain("Legacy evidence");
  });

  test("TextPart copies the complete source while displaying an omission", async () => {
    mockWriteText.mockClear();
    mockWriteText.mockImplementation(async () => {});
    const contract = MULTI_REVIEW_REPORTS_DISPLAY_CONTRACT;
    const source = evidencePrompt(contract, '[{"summary":"Copy-only evidence"}]', '"main".');

    const view = render(
      <TextPart content={source} truncateUserPrompt expansionKey="copy-source/json" />,
    );
    expect(view.container.textContent).toContain(contract.omissionText);
    expect(view.container.textContent).not.toContain("Copy-only evidence");

    fireEvent.click(screen.getByRole("button", { name: "Copy text" }));
    await waitFor(() => expect(mockWriteText).toHaveBeenCalledWith(source));
  });

  test("the payload search text is the trigger's own text", () => {
    const payload = payloadOf('{"stageName":"verify","attempts":2}');
    const view = render(<JsonPayloadPart payload={payload} expansionKey="payload" />);

    // Locks the concatenation in `jsonPayloadSearchText` to the JSX above it:
    // adding whitespace between the title and summary spans breaks this.
    expect(view.container.textContent).toBe(jsonPayloadSearchText(payload));
  });
});
