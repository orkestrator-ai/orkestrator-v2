/**
 * The page-side frame kit's pure parts (todo 0047 task 5): a frame document's
 * identity never carries an origin, query, fragment or token-like segment, and
 * the kit's limits mirror the protocol's. Frame traversal itself needs a real
 * browser and is covered in browser-preview-frame-targets.integration.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Window } from "happy-dom";
import {
  WEB_ANNOTATION_FRAME_DOCUMENT_PATH_CHARS,
  WEB_ANNOTATION_MAX_FRAME_DEPTH,
} from "@orkestrator/protocol/web-annotations";
import { isWebAnnotationTarget } from "@orkestrator/protocol/web-annotations-validation";
import { fixtureTargets } from "@orkestrator/protocol/testing/web-annotations-fixtures";
import {
  browserPreviewFrameKit,
  type BrowserPreviewFrameKit,
} from "../electron/browser-preview-frame-kit";

function kit(): BrowserPreviewFrameKit {
  const window = new Window({ url: "http://localhost:3000/" });
  return window.eval(`(${browserPreviewFrameKit.toString()})()`) as BrowserPreviewFrameKit;
}

const documentAt = (href: string) =>
  ({ defaultView: { location: { href } } }) as unknown as Document;

describe("frame document paths", () => {
  test("document identities match SHA-256 and distinguish private URL components", () => {
    const frames = kit();
    for (const href of [
      "about:srcdoc",
      "https://local.test/editor?record=1",
      "https://local.test/editor?record=2",
      `https://local.test/${"a".repeat(200)}`,
    ]) {
      expect(frames.documentIdentityOf(documentAt(href))).toBe(
        createHash("sha256").update(href).digest("hex"),
      );
    }
    const doc = documentAt("https://local.test/editor?record=1");
    const first = frames.documentIdentityOf(doc);
    Object.assign(doc.defaultView!.location, { href: "https://local.test/editor?record=2" });
    expect(frames.documentIdentityOf(doc)).not.toBe(first);
  });

  test("keep only the path of an http(s) URL", () => {
    const frames = kit();
    expect(
      frames.documentPathOf(documentAt("http://localhost:3000/embed/editor.html?token=abc#x")),
    ).toBe("/embed/editor.html");
    expect(frames.documentPathOf(documentAt("https://localhost:3000"))).toBe("/");
    expect(frames.documentPathOf(documentAt("about:srcdoc"))).toBe("about:srcdoc");
    expect(frames.documentPathOf(documentAt("about:blank"))).toBe("about:blank");
  });

  test("replace token-like segments and refuse other schemes or oversized paths", () => {
    const frames = kit();
    const token = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7";
    expect(frames.documentPathOf(documentAt(`http://localhost:3000/reset/${token}/form`))).toBe(
      "/reset/:opaque/form",
    );
    for (const href of [
      "file:///etc/passwd",
      "data:text/html,hi",
      "about:config",
      "not a url",
      `http://localhost:3000${"/ab".repeat(WEB_ANNOTATION_FRAME_DOCUMENT_PATH_CHARS / 3 + 1)}`,
    ]) {
      expect(frames.documentPathOf(documentAt(href))).toBeNull();
    }
  });

  test("every path the kit produces is one the protocol accepts", () => {
    const frames = kit();
    const element = fixtureTargets.element as Extract<
      (typeof fixtureTargets)["element"],
      { kind: "element" }
    >;
    for (const href of [
      "http://localhost:3000/a/b%20c/d.html",
      "http://localhost:3000/a/./b/../c",
      "about:srcdoc",
    ]) {
      const documentPath = frames.documentPathOf(documentAt(href))!;
      const scope = {
        kind: "frame",
        path: [{ boundary: "frame", tagName: "iframe", cssPath: "iframe", documentPath }],
      };
      expect(isWebAnnotationTarget({ ...element, anchor: { ...element.anchor, scope } })).toBe(
        true,
      );
    }
  });
});

describe("frame kit limits", () => {
  test("mirror the protocol", () => {
    const frames = kit();
    expect(frames.MAX_FRAME_DEPTH).toBe(WEB_ANNOTATION_MAX_FRAME_DEPTH);
    // A path at the protocol's length limit is kept; one character more is refused.
    const atLimit = `/${"a/".repeat((WEB_ANNOTATION_FRAME_DOCUMENT_PATH_CHARS - 2) / 2)}b`;
    expect(atLimit).toHaveLength(WEB_ANNOTATION_FRAME_DOCUMENT_PATH_CHARS);
    expect(frames.documentPathOf(documentAt(`http://localhost:3000${atLimit}`))).toBe(atLimit);
    expect(frames.documentPathOf(documentAt(`http://localhost:3000${atLimit}c`))).toBeNull();
  });

  test("an element that is not a frame has no reachable document", () => {
    const window = new Window({ url: "http://localhost:3000/" });
    window.document.body.innerHTML = `<div id="d"></div><iframe id="f"></iframe>`;
    const frames = window.eval(
      `(${browserPreviewFrameKit.toString()})()`,
    ) as BrowserPreviewFrameKit;
    expect(frames.reachableDocument(window.document.getElementById("d") as never) === null).toBe(
      true,
    );
    // happy-dom gives frames an opaque origin, which the kit refuses like a
    // cross-origin or sandboxed frame.
    expect(frames.reachableDocument(window.document.getElementById("f") as never) === null).toBe(
      true,
    );
    expect(frames.isLiveDocument(window.document as never)).toBe(true);
  });
});
