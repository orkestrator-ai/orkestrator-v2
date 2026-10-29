/**
 * Transcript images keep the version their message first showed: inside a
 * message a local image is read through `transcript_media_pin` and that copy
 * is cached; outside one, a file is read again on every mount so it is never
 * shown stale. Images that may not match their message say so.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { TRANSCRIPT_MEDIA_PIN_COMMAND } from "@orkestrator/protocol/transcript-media-pins";
import { invoke } from "@/lib/native/backend";
import { clearImagePreviewCache, readImagePreviewCache } from "@/lib/chat/image-preview-cache";
import { mediaSnapshotNote } from "@/lib/chat/media-snapshot";
import { RichMessageContext, RichTranscriptScopeContext } from "@/lib/chat/rich-identity";
import { clearMediaResolverInflight } from "@/lib/chat/rich-markdown/media-resolver";
import { cachedToolDetails, ToolDetailLoaderContext } from "@/components/chat/NativeMessage.shared";
import { mediaCacheKey } from "@/lib/chat/rich-markdown/media-resolver";
import { FilePart } from "@/components/chat/NativeMessage.file-parts";
import { MarkdownImage } from "./MediaBlock";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const SHOT = "/worktrees/app/output/1-top.png";
const SCOPE = {
  backendId: "backend-1",
  environmentId: "env-1",
  logicalSessionKey: "tab-1",
  generation: "g1",
};
const MESSAGE_AT = "2026-10-29T10:00:00.000Z";

type ObserverGlobal = { IntersectionObserver?: unknown };
const realIntersectionObserver = (globalThis as ObserverGlobal).IntersectionObserver;

/** Distinct, valid PNG headers so each version decodes as an image. */
function png(width: number): string {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, 10);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function pinResponse(dataBase64: string, extra: Record<string, unknown> = {}) {
  return {
    status: "pinned",
    capturedAt: "2026-10-29T10:00:01.000Z",
    fileModifiedAt: "2026-10-29T09:59:00.000Z",
    sha256: "0".repeat(64),
    byteLength: dataBase64.length,
    dataBase64,
    ...extra,
  };
}

function calls(command: string): unknown[][] {
  return invokeMock.mock.calls.filter(([name]) => name === command);
}

function InMessage({ messageId = "m1", children }: { messageId?: string; children: ReactNode }) {
  return (
    <RichTranscriptScopeContext.Provider value={SCOPE}>
      <RichMessageContext.Provider value={{ messageId, role: "assistant", createdAt: MESSAGE_AT }}>
        {children}
      </RichMessageContext.Provider>
    </RichTranscriptScopeContext.Provider>
  );
}

function imageSource(): string | null {
  return document.querySelector("img")?.getAttribute("src") ?? null;
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
  delete (globalThis as ObserverGlobal).IntersectionObserver;
});

afterEach(() => {
  cleanup();
  clearImagePreviewCache();
  clearMediaResolverInflight();
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
  (globalThis as ObserverGlobal).IntersectionObserver = realIntersectionObserver;
});

describe("pinned transcript images", () => {
  test("a Markdown image in a message is read through its pin and cached by it", async () => {
    let onDisk = png(100);
    invokeMock.mockImplementation((command: string) =>
      command === TRANSCRIPT_MEDIA_PIN_COMMAND
        ? Promise.resolve(pinResponse(onDisk))
        : Promise.resolve(),
    );
    const first = render(
      <InMessage>
        <MarkdownImage src={SHOT} alt="First load" />
      </InMessage>,
    );
    await waitFor(() => expect(imageSource()).toBe(`data:image/png;base64,${png(100)}`));
    expect(calls(TRANSCRIPT_MEDIA_PIN_COMMAND)).toEqual([
      [
        TRANSCRIPT_MEDIA_PIN_COMMAND,
        { environmentId: "env-1", logicalSessionKey: "tab-1", messageId: "m1", path: SHOT },
      ],
    ]);
    expect(calls("read_file_base64")).toEqual([]);
    first.unmount();

    // The agent retakes the screenshot. Scrolling back to the first message
    // shows its saved copy without asking again.
    onDisk = png(200);
    render(
      <InMessage>
        <MarkdownImage src={SHOT} alt="First load" />
      </InMessage>,
    );
    await waitFor(() => expect(imageSource()).toBe(`data:image/png;base64,${png(100)}`));
    expect(calls(TRANSCRIPT_MEDIA_PIN_COMMAND)).toHaveLength(1);
  });

  test("two messages naming the same file each ask for their own pin", async () => {
    invokeMock.mockImplementation((command: string, args: { messageId?: string }) =>
      command === TRANSCRIPT_MEDIA_PIN_COMMAND
        ? Promise.resolve(pinResponse(args.messageId === "m1" ? png(100) : png(200)))
        : Promise.resolve(),
    );
    render(
      <>
        <InMessage messageId="m1">
          <MarkdownImage src={SHOT} alt="Round one" />
        </InMessage>
        <InMessage messageId="m2">
          <MarkdownImage src={SHOT} alt="Round two" />
        </InMessage>
      </>,
    );
    await waitFor(() => expect(document.querySelectorAll("img")).toHaveLength(2));
    const sources = [...document.querySelectorAll("img")].map((image) => image.getAttribute("src"));
    expect(sources).toEqual([
      `data:image/png;base64,${png(100)}`,
      `data:image/png;base64,${png(200)}`,
    ]);
  });

  test("outside a message a file is read again on every mount", async () => {
    let onDisk = png(100);
    invokeMock.mockImplementation((command: string) =>
      command === "read_file_base64" ? Promise.resolve(onDisk) : Promise.resolve(),
    );
    const first = render(<MarkdownImage src={SHOT} alt="Detached" />);
    await waitFor(() => expect(imageSource()).toBe(`data:image/png;base64,${png(100)}`));
    first.unmount();

    onDisk = png(200);
    render(<MarkdownImage src={SHOT} alt="Detached" />);
    await waitFor(() => expect(imageSource()).toBe(`data:image/png;base64,${png(200)}`));
    expect(calls(TRANSCRIPT_MEDIA_PIN_COMMAND)).toEqual([]);
    expect(calls("read_file_base64")).toHaveLength(2);
  });

  test("a failed pin falls back to a direct read and is not cached", async () => {
    invokeMock.mockImplementation((command: string) =>
      command === TRANSCRIPT_MEDIA_PIN_COMMAND
        ? Promise.reject(new Error(`Unknown command: ${TRANSCRIPT_MEDIA_PIN_COMMAND}`))
        : command === "read_file_base64"
          ? Promise.resolve(png(100))
          : Promise.resolve(),
    );
    const first = render(
      <InMessage>
        <MarkdownImage src={SHOT} alt="Older backend" />
      </InMessage>,
    );
    await waitFor(() => expect(imageSource()).toBe(`data:image/png;base64,${png(100)}`));
    first.unmount();
    render(
      <InMessage>
        <MarkdownImage src={SHOT} alt="Older backend" />
      </InMessage>,
    );
    await waitFor(() => expect(imageSource()).not.toBeNull());
    expect(calls("read_file_base64")).toHaveLength(2);
  });

  for (const kind of ["Markdown", "attachment"] as const) {
    test.each(["quota", "missing"] as const)(
      `${kind} live pins reread changed bytes after remount (%s)`,
      async (reason) => {
        let onDisk = png(100);
        invokeMock.mockImplementation((command: string) =>
          command === TRANSCRIPT_MEDIA_PIN_COMMAND
            ? Promise.resolve(pinResponse(onDisk, { status: "live", reason }))
            : Promise.resolve(),
        );
        const view = () => (
          <InMessage>
            {kind === "Markdown" ? (
              <MarkdownImage src={SHOT} alt="Live" />
            ) : (
              <FilePart path={SHOT} eagerPreview />
            )}
          </InMessage>
        );
        const first = render(view());
        await waitFor(() => expect(imageSource()).toBe(`data:image/png;base64,${png(100)}`));
        expect(screen.getByText("Current file")).toBeTruthy();
        expect(
          readImagePreviewCache(mediaCacheKey({ path: SHOT }, { ...SCOPE, messageId: "m1" })),
        ).toBeNull();
        first.unmount();
        onDisk = png(200);
        render(view());
        await waitFor(() => expect(imageSource()).toBe(`data:image/png;base64,${png(200)}`));
        expect(screen.getByText("Current file")).toBeTruthy();
        expect(calls(TRANSCRIPT_MEDIA_PIN_COMMAND)).toHaveLength(2);
      },
    );
  }

  test.each(["quota", "missing"] as const)(
    "live deferred details bypass both browser caches (%s)",
    async (reason) => {
      const detailRef = `live-detail-${reason}`;
      let onDisk = png(100);
      const load = mock(async () => ({
        detailRef,
        fileDataUrl: `data:image/png;base64,${onDisk}`,
        fileSnapshot: { status: "live" as const, reason, capturedAt: MESSAGE_AT },
      }));
      const view = () => (
        <InMessage>
          <ToolDetailLoaderContext.Provider value={load}>
            <FilePart path="shot.png" detailRef={detailRef} eagerPreview />
          </ToolDetailLoaderContext.Provider>
        </InMessage>
      );
      const first = render(view());
      await waitFor(() => expect(imageSource()).toBe(`data:image/png;base64,${png(100)}`));
      expect(cachedToolDetails(detailRef)).toBeUndefined();
      expect(
        readImagePreviewCache(
          mediaCacheKey({ path: "shot.png", detailRef }, { ...SCOPE, messageId: "m1" }),
        ),
      ).toBeNull();
      first.unmount();
      onDisk = png(200);
      render(view());
      await waitFor(() => expect(imageSource()).toBe(`data:image/png;base64,${png(200)}`));
      expect(screen.getByText("Current file")).toBeTruthy();
      expect(load).toHaveBeenCalledTimes(2);
    },
  );

  test("labels a copy saved after the file changed", async () => {
    invokeMock.mockImplementation((command: string) =>
      command === TRANSCRIPT_MEDIA_PIN_COMMAND
        ? Promise.resolve(pinResponse(png(100), { fileModifiedAt: "2026-10-29T10:05:00.000Z" }))
        : Promise.resolve(),
    );
    const view = () => (
      <InMessage>
        <MarkdownImage src={SHOT} alt="Late" />
      </InMessage>
    );
    const first = render(view());
    await waitFor(() => expect(screen.getByText("Changed since")).toBeTruthy());
    expect(
      screen.getByRole("button", { name: /^Open image: Late\. The file changed after/ }),
    ).toBeTruthy();
    const explanation = screen.getByText("Changed since").getAttribute("title");
    expect(explanation).toContain("The file changed after this message");
    first.unmount();
    render(view());
    await waitFor(() =>
      expect(screen.getByText("Changed since").getAttribute("title")).toBe(explanation),
    );
    expect(calls(TRANSCRIPT_MEDIA_PIN_COMMAND)).toHaveLength(1);
  });

  test("an attachment thumbnail is pinned to its message and labels a live copy", async () => {
    invokeMock.mockImplementation((command: string) =>
      command === TRANSCRIPT_MEDIA_PIN_COMMAND
        ? Promise.resolve(pinResponse(png(100), { status: "live", reason: "quota" }))
        : Promise.resolve(),
    );
    render(
      <InMessage messageId="user-1">
        <FilePart path={SHOT} eagerPreview />
      </InMessage>,
    );
    await waitFor(() => expect(screen.getByText("Current file")).toBeTruthy());
    expect(calls(TRANSCRIPT_MEDIA_PIN_COMMAND)[0]?.[1]).toMatchObject({
      messageId: "user-1",
      path: SHOT,
    });
  });
});

describe("mediaSnapshotNote", () => {
  const pinned = { status: "pinned" as const, capturedAt: "2026-10-29T10:10:00.000Z" };

  test("says nothing for bytes that match their message", () => {
    expect(mediaSnapshotNote(undefined, MESSAGE_AT)).toBeNull();
    expect(mediaSnapshotNote(pinned, MESSAGE_AT)).toBeNull();
    expect(
      mediaSnapshotNote({ ...pinned, fileModifiedAt: "2026-10-29T09:00:00.000Z" }, MESSAGE_AT),
    ).toBeNull();
    // Within the clock slack.
    expect(
      mediaSnapshotNote({ ...pinned, fileModifiedAt: "2026-10-29T10:00:01.000Z" }, MESSAGE_AT),
    ).toBeNull();
    // No message clock: nothing to compare against.
    expect(
      mediaSnapshotNote({ ...pinned, fileModifiedAt: "2026-10-29T11:00:00.000Z" }, undefined),
    ).toBeNull();
  });

  test("flags a file changed after the message, and live bytes", () => {
    expect(
      mediaSnapshotNote({ ...pinned, fileModifiedAt: "2026-10-29T10:00:03.000Z" }, MESSAGE_AT)
        ?.kind,
    ).toBe("late");
    expect(mediaSnapshotNote({ ...pinned, status: "live", reason: "quota" }, MESSAGE_AT)).toEqual(
      expect.objectContaining({ kind: "live", text: "Current file" }),
    );
    expect(
      mediaSnapshotNote({ ...pinned, status: "live", reason: "missing" }, MESSAGE_AT)?.description,
    ).toContain("missing");
  });
});
