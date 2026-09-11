/**
 * The four transcript rows for things that happened *to* the conversation.
 *
 * Rendered from synthetic projections only: every assertion here is about
 * presentation, and none of these components may learn which provider produced
 * the part they are showing.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@/lib/native/backend";
import { CompactionPart, ImagePart, RetryPart, StatusPart } from "./NativeMessage.notice-parts";
import type { NativeMessagePart } from "@/lib/chat/native-message-types";

const invokeMock = invoke as ReturnType<typeof mock>;

afterEach(cleanup);
beforeEach(() => invokeMock.mockClear());

function part<T extends NativeMessagePart["type"]>(
  type: T,
  overrides: Record<string, unknown> = {},
): Extract<NativeMessagePart, { type: T }> {
  return { type, content: "", ...overrides } as Extract<NativeMessagePart, { type: T }>;
}

describe("CompactionPart", () => {
  test("shows the boundary even with no summary at all", () => {
    // The boundary itself is the information: the model no longer remembers
    // what is above it. Several providers report it without a summary.
    render(<CompactionPart part={part("compaction")} expansionKey="k1" />);

    expect(screen.getByText("Context compacted")).toBeTruthy();
    expect(screen.queryByText("Show summary") === null).toBe(true);
  });

  test("names the occupancy before the compaction", () => {
    render(
      <CompactionPart
        part={part("compaction", { compactedTokensBefore: 142_000 })}
        expansionKey="k2"
      />,
    );
    expect(screen.getByText("142k tokens before")).toBeTruthy();
  });

  test("prefers a provider-supplied count label over the derived one", () => {
    render(
      <CompactionPart
        part={part("compaction", { compactedTokensBefore: 142_000, tokenCountText: "auto" })}
        expansionKey="k3"
      />,
    );
    expect(screen.getByText("auto")).toBeTruthy();
    expect(screen.queryByText("142k tokens before") === null).toBe(true);
  });

  test("keeps a summary behind an expander rather than in the flow", () => {
    render(
      <CompactionPart
        part={part("compaction", { content: "Earlier work on the parser." })}
        expansionKey="k4"
      />,
    );

    expect(screen.queryByText("Earlier work on the parser.") === null).toBe(true);
    fireEvent.click(screen.getByText("Show summary"));
    expect(screen.getByText("Earlier work on the parser.")).toBeTruthy();
  });
});

describe("RetryPart", () => {
  test("reads as in flight while pending", () => {
    render(<RetryPart part={part("retry", { toolState: "pending", retryAttempt: 2 })} />);
    expect(screen.getByText("Retrying (attempt 2)")).toBeTruthy();
  });

  test("reads as settled once it succeeds", () => {
    render(<RetryPart part={part("retry", { toolState: "success" })} />);
    expect(screen.getByText("Retried")).toBeTruthy();
  });

  test("reads as a failure when it gave up", () => {
    render(<RetryPart part={part("retry", { toolState: "failure", content: "gave up" })} />);
    expect(screen.getByText("Retry failed")).toBeTruthy();
    expect(screen.getByText("gave up")).toBeTruthy();
  });

  test("drops the attempt number when the provider does not count them", () => {
    render(<RetryPart part={part("retry", { toolState: "pending" })} />);
    expect(screen.getByText("Retrying")).toBeTruthy();
  });
});

describe("StatusPart", () => {
  test("renders the line for each severity", () => {
    for (const severity of ["info", "warning", "error"] as const) {
      render(<StatusPart part={part("status", { content: `a ${severity} line`, severity })} />);
      expect(screen.getByText(`a ${severity} line`)).toBeTruthy();
      cleanup();
    }
  });

  test("an empty status is no row at all, not an empty one", () => {
    const { container } = render(<StatusPart part={part("status", { content: "   " })} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("ImagePart", () => {
  test("labels the provenance, because the three mean different things", () => {
    for (const [source, label] of [
      ["attachment", "Attached image"],
      ["generated", "Generated image"],
      ["viewed", "Image read"],
    ] as const) {
      render(<ImagePart part={part("image", { content: "a cat", imageSource: source })} />);
      expect(screen.getByText(label)).toBeTruthy();
      cleanup();
    }
  });

  test("defaults to an attachment when the provider does not say", () => {
    render(<ImagePart part={part("image", { content: "a cat" })} />);
    expect(screen.getByText("Attached image")).toBeTruthy();
  });

  test("a caption-only image is a quiet row, not a failing thumbnail", () => {
    // Codex reports an image with no path when the item carries no bytes.
    // Forcing the image treatment would eagerly read the caption as a path.
    render(
      <ImagePart
        part={part("image", { content: "a generated cat", imageSource: "generated" })}
        containerId="container-1"
      />,
    );

    expect(screen.getByText("a generated cat")).toBeTruthy();
    expect(screen.queryByText("preview unavailable") === null).toBe(true);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
