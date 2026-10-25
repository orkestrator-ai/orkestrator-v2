import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RichMessageContext } from "@/lib/chat/rich-identity";
import { clearImagePreviewCache } from "@/lib/chat/image-preview-cache";
import { FilePart } from "../NativeMessage.file-parts";
import { FilePreview, parseDelimitedRows } from "./FilePreview";
import { MarkdownImage } from "./MediaBlock";
import { MediaGalleryDialog } from "./MediaGallery";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function dataUrl(mime: string, text: string): string {
  return `data:${mime};base64,${btoa(text)}`;
}

beforeAll(() => {
  if (typeof URL.createObjectURL !== "function") {
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:test";
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
  }
});

afterEach(() => {
  cleanup();
  clearImagePreviewCache();
});

describe("shared image gallery", () => {
  test("steps through every image of a message with the keyboard and closes with Escape", async () => {
    render(
      <RichMessageContext value={{ messageId: "m1", role: "assistant" }}>
        <FilePart path="a.png" fileUrl={PNG} filename="a.png" eagerPreview />
        <FilePart path="b.png" fileUrl={PNG} filename="b.png" eagerPreview />
      </RichMessageContext>,
    );
    await screen.findByAltText("Thumbnail: a.png");
    const opener = screen.getByRole("button", { name: "Open full image: a.png" });
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Image preview: a.png" });
    expect(screen.getByText(/1 of 2/)).toBeTruthy();
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(await screen.findByRole("dialog", { name: "Image preview: b.png" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download original" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Original size" })).toBeTruthy();
    // Controls are buttons of the toolbar, not nested inside the image surface.
    for (const button of screen.getAllByRole("button")) {
      expect(button.parentElement?.closest("button") === null).toBe(true);
    }
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
  });

  test("a Markdown image with an unsafe or unresolvable source keeps its alt text", () => {
    render(
      <>
        <MarkdownImage src="" alt="Blocked diagram" />
        <MarkdownImage src="relative/shot.png" alt="Relative shot" />
      </>,
    );
    expect(screen.getByRole("img", { name: "Blocked diagram (image blocked)" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Relative shot (image unavailable)" })).toBeTruthy();
  });

  test("the viewer tells an unavailable image from one that failed to decode", async () => {
    const element = () => null;
    render(
      <MediaGalleryDialog
        open
        items={[{ title: "gone.png", element, load: async () => null }]}
        initialIndex={0}
        onOpenChange={() => {}}
      />,
    );
    expect(await screen.findByText(/gone\.png: the image is unavailable/)).toBeTruthy();
    cleanup();
    render(
      <MediaGalleryDialog
        open
        items={[{ title: "broken.png", element, load: async () => PNG }]}
        initialIndex={0}
        initialSource={PNG}
        onOpenChange={() => {}}
      />,
    );
    fireEvent.error(screen.getByRole("img", { name: "broken.png" }));
    expect(await screen.findByText("broken.png: the image could not be decoded.")).toBeTruthy();
    // The original stays downloadable after a decode failure.
    expect(screen.getByRole("button", { name: "Download original" })).toBeTruthy();
  });

  test("a remote Markdown image loads without a referrer", () => {
    const { container } = render(<MarkdownImage src="https://example.com/a.png" alt="Remote" />);
    const image = container.querySelector("img")!;
    expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(image.getAttribute("loading")).toBe("lazy");
  });
});

describe("MIME-aware file preview", () => {
  test("video uses native controls, metadata-only preload and never autoplays", async () => {
    render(
      <FilePreview
        reference={{
          path: "clip.mp4",
          fileUrl: dataUrl("video/mp4", "\u0000\u0000\u0000\u0018ftypmp42"),
        }}
        name="clip.mp4"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview file: clip.mp4 (Video)" }));
    // Nothing is decoded for playback until the user asks for it.
    expect(document.querySelector("video") === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Load video" }));
    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
    const video = document.querySelector("video")!;
    expect(video.getAttribute("preload")).toBe("metadata");
    expect(video.hasAttribute("controls")).toBe(true);
    expect(video.hasAttribute("autoplay")).toBe(false);
  });

  test("HTML attachments are source only and never executed", async () => {
    const html = "<script>window.__ran = true</script><h1>Hi</h1>";
    render(
      <FilePreview
        reference={{ path: "page.html", fileUrl: dataUrl("text/html", html) }}
        name="page.html"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview file: page.html (HTML source)" }));
    expect(await screen.findByText(/shown as source only/)).toBeTruthy();
    expect(screen.getByLabelText("page.html contents").textContent).toBe(html);
    expect(document.querySelector("iframe") === null).toBe(true);
    expect((window as unknown as { __ran?: boolean }).__ran).toBeUndefined();
  });

  test("PDF gets a download fallback and a type mismatch is not previewed", async () => {
    render(
      <FilePreview
        reference={{ path: "doc.pdf", fileUrl: dataUrl("application/pdf", "%PDF-1.7 body") }}
        name="doc.pdf"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview file: doc.pdf (PDF document)" }));
    // Inline-only bytes have no authorized backend source for a first-page preview.
    expect(await screen.findByText(/No first-page preview is available/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download original" })).toBeTruthy();
    cleanup();
    render(
      <FilePreview
        reference={{ path: "fake.pdf", fileUrl: dataUrl("application/pdf", "<html>not a pdf") }}
        name="fake.pdf"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview file: fake.pdf (PDF document)" }));
    expect(await screen.findByText(/do not match its PDF document type/)).toBeTruthy();
  });

  test("CSV previews are bounded tables with a row count; a file without bytes says so", async () => {
    render(
      <FilePreview
        reference={{ path: "rows.csv", fileUrl: dataUrl("text/csv", 'a,b\n1,"x, y"\n2,"q""t"\n') }}
        name="rows.csv"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview file: rows.csv (CSV)" }));
    expect(await screen.findByText("3 rows")).toBeTruthy();
    expect(screen.getByText("x, y")).toBeTruthy();
    cleanup();
    render(<FilePreview reference={{ path: "report.txt" }} name="report.txt" />);
    fireEvent.click(screen.getByRole("button", { name: "Preview file: report.txt (Text)" }));
    expect(await screen.findByText(/does not carry the file's bytes/)).toBeTruthy();
  });

  test("parseDelimitedRows handles quotes, embedded newlines and the row bound", () => {
    expect(parseDelimitedRows('a,"b\nc",d\r\n1,2,3', ",", 10)).toEqual({
      rows: [
        ["a", "b\nc", "d"],
        ["1", "2", "3"],
      ],
      totalRows: 2,
    });
    expect(parseDelimitedRows("x\ty\n1\t2\n3\t4\n", "\t", 2)).toEqual({
      rows: [
        ["x", "y"],
        ["1", "2"],
      ],
      totalRows: 3,
    });
  });
});
