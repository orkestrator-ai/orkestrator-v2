import { afterEach, describe, expect, test } from "bun:test";
import { designFrameSource } from "./design-frame-source";

const env = import.meta.env as Record<string, string | undefined>;

describe("designFrameSource", () => {
  afterEach(() => {
    delete env.ORKESTRATOR_DESIGN_FRAME_DOCUMENT;
  });

  test("uses a fresh nonce-bearing srcdoc where no document was built", () => {
    const source = designFrameSource();
    if (!("srcDoc" in source)) throw new Error("Expected a srcdoc frame");
    expect(source.srcDoc).toContain("script-src 'nonce-");
    expect(designFrameSource()).not.toEqual(source);
  });

  test("loads the document a production build emitted", () => {
    env.ORKESTRATOR_DESIGN_FRAME_DOCUMENT = "design-frame.html";
    expect(designFrameSource()).toEqual({ src: "design-frame.html" });
  });
});
