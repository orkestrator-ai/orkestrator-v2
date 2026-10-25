import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  artifactPartContent,
  type TranscriptArtifactRef,
} from "@orkestrator/protocol/transcript-artifacts";
import { invoke } from "@/lib/native/backend";
import { resetTranscriptArtifactCapabilities } from "@/hooks/useTranscriptArtifactCapabilities";
import { clearArtifactRequestCache } from "@/lib/chat/artifact-requests";
import type { NativeMessage as NativeMessageType } from "@/lib/chat/native-message-types";
import { mockWriteText } from "../../../../../../tests/mocks/clipboard";
import { NativeMessage } from "../NativeMessage";
import { getNativeMessageSearchText } from "../native-message-search";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;

const artifact: TranscriptArtifactRef = {
  schemaVersion: 1,
  artifactId: "art_abcdefgh1",
  revision: 1,
  publicationId: "pub_abcdefgh1",
  kind: "chart",
  title: "Outcomes",
  summary: "Synthetic chart of test outcomes",
  provenance: { backendId: "backend-1", origin: "agent" },
};

function messageWithArtifact(): NativeMessageType {
  return {
    id: "assistant-1",
    role: "assistant",
    content: "",
    createdAt: "2026-10-20T10:00:00.000Z",
    parts: [
      { type: "text", content: "Here is the chart." },
      {
        type: "artifact",
        content: artifactPartContent(artifact),
        artifact,
        publishedAt: "2026-10-20T10:00:00.000Z",
        conversationSequence: 1,
      },
    ],
  };
}

beforeEach(() => {
  resetTranscriptArtifactCapabilities();
  clearArtifactRequestCache();
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve(undefined));
  mockWriteText.mockReset();
  mockWriteText.mockImplementation(async () => {});
});

afterEach(cleanup);

describe("artifact parts in the transcript", () => {
  test("the native renderer dispatches an artifact part to its card", () => {
    const { container } = render(<NativeMessage message={messageWithArtifact()} />);
    expect(container.querySelector('[data-rich-block="artifact"]')).not.toBeNull();
    expect(screen.getByText("Outcomes")).toBeTruthy();
    expect(screen.getByText("Synthetic chart of test outcomes")).toBeTruthy();
  });

  test("Copy message includes the textual artifact summary, not icons or bodies", async () => {
    render(<NativeMessage message={messageWithArtifact()} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy text" }));
    await waitFor(() =>
      expect(mockWriteText).toHaveBeenCalledWith(
        `Here is the chart.\n\n${artifactPartContent(artifact)}`,
      ),
    );
  });

  test("find indexes exactly the artifact summary its card renders as a search root", () => {
    const message = messageWithArtifact();
    const { container } = render(<NativeMessage message={message} />);
    const artifactRoot = container.querySelector(
      '[data-rich-block="artifact"] [data-agent-chat-search-content]',
    );
    expect(artifactRoot?.textContent).toBe(artifact.summary);
    const indexed = getNativeMessageSearchText(message);
    expect(indexed.endsWith(`\n\n${artifact.summary}`)).toBe(true);
    // The title lives in toolbar chrome, which find never highlights.
    expect(indexed).not.toContain("[Artifact:");
  });
});
