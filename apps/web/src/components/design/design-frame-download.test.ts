import { describe, expect, mock, test } from "bun:test";
import {
  browserImageCodec,
  downloadFileName,
  downloadFrames,
  type DesignDownloadDeps,
  type DesignImageCodec,
} from "./design-frame-download";
import { base64ToBytes } from "./design-frame-files";
import { TINY_PNG_BASE64 } from "./design-test-backend";

const frames = [
  { id: "f1", name: "Keep or pass · List view" },
  { id: "f2", name: "Keep or pass · Stack view" },
];

function harness(codec?: Partial<DesignImageCodec>) {
  const saved: Array<{ file: Blob; name: string }> = [];
  const capture = mock((frameId: string) =>
    Promise.resolve({ data: TINY_PNG_BASE64, mimeType: "image/png", frameId }),
  );
  const fake: DesignImageCodec = {
    toWebp: mock(() => Promise.resolve(new Uint8Array([0x52, 0x49, 0x46, 0x46]))),
    toRgb: mock(() =>
      Promise.resolve({ width: 1480, height: 1016, rgb: new Uint8Array([255, 255, 255]) }),
    ),
    deflate: mock((bytes: Uint8Array<ArrayBuffer>) => Promise.resolve(bytes)),
    ...codec,
  };
  const deps: DesignDownloadDeps = {
    capture,
    save: (file, name) => saved.push({ file, name }),
    codec: fake,
  };
  return { saved, capture, deps, codec: fake };
}

const bytes = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

describe("downloadFrames", () => {
  test("one frame as PNG saves the renderer's capture unchanged", async () => {
    const { saved, capture, deps } = harness();
    const name = await downloadFrames({
      scope: "frame",
      frames: [frames[0]!],
      format: "png",
      canvasName: "Angela",
      deps,
    });
    expect(name).toBe("Keep-or-pass-List-view.png");
    expect(capture.mock.calls.map((call) => call[0])).toEqual(["f1"]);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.file.type).toBe("image/png");
    expect(Array.from(await bytes(saved[0]!.file))).toEqual(
      Array.from(base64ToBytes(TINY_PNG_BASE64)),
    );
  });

  test("one frame as WEBP re-encodes the capture", async () => {
    const { saved, deps, codec } = harness();
    await downloadFrames({
      scope: "frame",
      frames: [frames[1]!],
      format: "webp",
      canvasName: "Angela",
      deps,
    });
    expect(codec.toWebp).toHaveBeenCalledTimes(1);
    expect(saved[0]!.name).toBe("Keep-or-pass-Stack-view.webp");
    expect(saved[0]!.file.type).toBe("image/webp");
  });

  test("several frames as PNG or WEBP save one ZIP named for the canvas", async () => {
    const { saved, capture, deps } = harness();
    const progress: Array<[number, number]> = [];
    await downloadFrames({
      scope: "selected",
      frames,
      format: "png",
      canvasName: "Keep or pass",
      deps,
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(capture.mock.calls.map((call) => call[0])).toEqual(["f1", "f2"]);
    expect(progress).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
    expect(saved[0]!.name).toBe("Keep-or-pass-selected.zip");
    expect(saved[0]!.file.type).toBe("application/zip");
    const zip = new TextDecoder("latin1").decode(await bytes(saved[0]!.file));
    expect(zip).toContain("01-Keep-or-pass-List-view.png");
    expect(zip).toContain("02-Keep-or-pass-Stack-view.png");

    await downloadFrames({ scope: "all", frames, format: "webp", canvasName: "Deck", deps });
    expect(saved[1]!.name).toBe("Deck.zip");
    expect(new TextDecoder("latin1").decode(await bytes(saved[1]!.file))).toContain(
      "02-Keep-or-pass-Stack-view.webp",
    );
  });

  test("PDF puts every frame on its own page at its captured size", async () => {
    const { saved, deps, codec } = harness();
    await downloadFrames({ scope: "all", frames, format: "pdf", canvasName: "Deck", deps });
    expect(codec.toRgb).toHaveBeenCalledTimes(2);
    expect(codec.deflate).toHaveBeenCalledTimes(2);
    expect(saved[0]!.name).toBe("Deck.pdf");
    expect(saved[0]!.file.type).toBe("application/pdf");
    const pdf = new TextDecoder("latin1").decode(await bytes(saved[0]!.file));
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf).toContain("/Count 2");
    expect(pdf.match(/\/MediaBox \[0 0 1110 762\]/g)).toHaveLength(2);

    await downloadFrames({
      scope: "frame",
      frames: [frames[0]!],
      format: "pdf",
      canvasName: "Deck",
      deps,
    });
    expect(saved[1]!.name).toBe("Keep-or-pass-List-view.pdf");
  });

  test("a failed capture or encoder saves nothing", async () => {
    const failing = harness();
    failing.capture.mockImplementationOnce(() => Promise.reject(new Error("Renderer unavailable")));
    await expect(
      downloadFrames({ scope: "all", frames, format: "png", canvasName: "D", deps: failing.deps }),
    ).rejects.toThrow("Renderer unavailable");
    expect(failing.saved).toHaveLength(0);

    const noWebp = harness({
      toWebp: () => Promise.reject(new Error("This browser cannot save WEBP images")),
    });
    await expect(
      downloadFrames({
        scope: "frame",
        frames,
        format: "webp",
        canvasName: "D",
        deps: noWebp.deps,
      }),
    ).rejects.toThrow("WEBP");
    expect(noWebp.saved).toHaveLength(0);

    await expect(
      downloadFrames({
        scope: "all",
        frames: [],
        format: "png",
        canvasName: "D",
        deps: noWebp.deps,
      }),
    ).rejects.toThrow("no frames");
  });

  test("file names", () => {
    expect(downloadFileName("frame", "pdf", "Deck", [frames[0]!])).toBe(
      "Keep-or-pass-List-view.pdf",
    );
    expect(downloadFileName("selected", "pdf", "Deck", frames)).toBe("Deck-selected.pdf");
    expect(downloadFileName("all", "png", "", frames)).toBe("design.zip");
  });

  test("the browser codec deflates as zlib", async () => {
    const input = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const deflated = await browserImageCodec.deflate(input);
    // zlib header: CMF 0x78.
    expect(deflated[0]).toBe(0x78);
    const inflated = new Uint8Array(
      await new Response(
        new Blob([deflated]).stream().pipeThrough(new DecompressionStream("deflate")),
      ).arrayBuffer(),
    );
    expect(Array.from(inflated)).toEqual(Array.from(input));
  });
});
