import { describe, expect, test } from "bun:test";
import { WEB_ANNOTATION_SOURCE_ATTRIBUTES } from "@orkestrator/protocol/web-annotations";
import { browserPreviewAnchorKit } from "../electron/browser-preview-anchor-script";
import { BROWSER_PREVIEW_CAPTURE_STATUS_SCRIPT } from "../electron/browser-preview-annotation-script";
import {
  parseCaptureRuntimeStatus,
  parseSourceHints,
} from "../electron/browser-preview-capture-parse";
import { click, page, type Json } from "./browser-preview-page-harness";

function selectedEvidence(harness: ReturnType<typeof page>, selector: string): Json {
  harness.start("element");
  click(harness, harness.document.querySelector(selector)!);
  const status = harness.status();
  expect(status.status).toBe("selected");
  return status.selection.evidence;
}

describe("development source hint producer", () => {
  test("the page kit uses the protocol's documented names", () => {
    const kit = browserPreviewAnchorKit.toString();
    for (const name of Object.values(WEB_ANNOTATION_SOURCE_ATTRIBUTES)) {
      expect(kit).toContain(`"${name}"`);
    }
  });

  test("reads the nearest annotated elements, joined to the declared project root", () => {
    const harness = page(`
      <section data-orkestrator-source="src/Settings.tsx:4" data-orkestrator-component="Settings">
        <div data-orkestrator-source="src/Settings.tsx:4">
          <button id="save" data-orkestrator-source="./src/SaveButton.tsx:12:7"
            data-orkestrator-component="SaveButton">Save</button>
        </div>
      </section>`);
    harness.document.head.innerHTML = `
      <meta name="orkestrator-source-root" content="./apps/web/">
      <meta name="orkestrator-source-producer" content="vite-plugin-example">`;
    const evidence = selectedEvidence(harness, "#save");

    expect(evidence.sourceHints).toEqual([
      {
        producer: "vite-plugin-example",
        path: "apps/web/src/SaveButton.tsx",
        line: 12,
        component: "SaveButton",
        verified: false,
      },
      // The duplicate path on the section is not repeated.
      {
        producer: "vite-plugin-example",
        path: "apps/web/src/Settings.tsx",
        line: 4,
        verified: false,
      },
    ]);
    // The convention's attributes are not page evidence attributes.
    expect(evidence.attributes).toEqual({ id: "save" });
  });

  test("defaults to the workspace root and names the convention as producer", () => {
    const harness = page(`<button id="save" data-orkestrator-source="src/Save.tsx">Save</button>`);
    expect(selectedEvidence(harness, "#save").sourceHints).toEqual([
      { producer: "data-orkestrator-source", path: "src/Save.tsx", verified: false },
    ]);
  });

  test("ignores paths that are absolute, escape, or carry a drive or control character", () => {
    const harness = page(`
      <div data-orkestrator-source="/home/person/app/src/A.tsx:1">
        <div data-orkestrator-source="../outside/B.tsx">
          <div data-orkestrator-source="C:/app/C.tsx">
            <div data-orkestrator-source="src/./D.tsx">
              <button id="save" data-orkestrator-source="src\\E.tsx">Save</button>
            </div>
          </div>
        </div>
      </div>`);
    expect(selectedEvidence(harness, "#save").sourceHints).toBeUndefined();
  });

  test("an escaping project root yields no hints rather than a guessed location", () => {
    const harness = page(`<button id="save" data-orkestrator-source="src/Save.tsx">Save</button>`);
    harness.document.head.innerHTML = `<meta name="orkestrator-source-root" content="../elsewhere">`;
    expect(selectedEvidence(harness, "#save").sourceHints).toBeUndefined();
  });

  test("keeps at most four hints and stops at the depth bound", () => {
    let html = `<button id="save" data-orkestrator-source="src/F0.tsx">Save</button>`;
    for (let index = 1; index < 10; index += 1) {
      html = `<div data-orkestrator-source="src/F${index}.tsx">${html}</div>`;
    }
    const harness = page(html);
    const hints = selectedEvidence(harness, "#save").sourceHints as Array<{ path: string }>;
    expect(hints.map((hint) => hint.path)).toEqual([
      "src/F0.tsx",
      "src/F1.tsx",
      "src/F2.tsx",
      "src/F3.tsx",
    ]);
  });

  test("an element without the convention adds no hints", () => {
    const harness = page(`<button id="save">Save</button>`);
    expect(selectedEvidence(harness, "#save").sourceHints).toBeUndefined();
  });
});

describe("source hint parsing in main", () => {
  test("rebuilds known fields, forces verified false, and drops invalid hints alone", () => {
    expect(
      parseSourceHints([
        { producer: "p", path: "src/A.tsx", line: 3, verified: true, smuggled: "x" },
        { producer: "p", path: "/etc/passwd", verified: false },
        { producer: "p", path: "src/../../B.tsx", verified: false },
        { producer: "p", path: "src/C.tsx", line: -1, verified: false },
        { producer: "x".repeat(101), path: "src/D.tsx", verified: false },
        { producer: "p", path: "src/A.tsx", verified: false },
        "not a hint",
        { producer: "p", path: "src/E.tsx", component: "E", verified: false },
      ]),
    ).toEqual([
      { producer: "p", path: "src/A.tsx", line: 3, verified: false },
      { producer: "p", path: "src/E.tsx", component: "E", verified: false },
    ]);
  });

  test("the page's hints survive the runtime status parse, unverified", () => {
    const harness = page(
      `<button id="save" data-orkestrator-source="src/Save.tsx:9">Save</button>`,
    );
    harness.start("element");
    click(harness, harness.document.querySelector("#save")!);
    const parsed = parseCaptureRuntimeStatus(
      harness.window.eval(BROWSER_PREVIEW_CAPTURE_STATUS_SCRIPT),
      { captureId: "capture-1", nonce: "nonce-1", mode: "element" },
    );
    expect(parsed.kind).toBe("selected");
    if (parsed.kind !== "selected") return;
    expect(parsed.selection.evidence?.sourceHints).toEqual([
      { producer: "data-orkestrator-source", path: "src/Save.tsx", line: 9, verified: false },
    ]);
  });

  test("absent, empty or non-array input carries no hints", () => {
    expect(parseSourceHints(undefined)).toBeUndefined();
    expect(parseSourceHints([])).toBeUndefined();
    expect(parseSourceHints({ path: "src/A.tsx" })).toBeUndefined();
  });

  test("keeps at most four", () => {
    const many = Array.from({ length: 6 }, (_, index) => ({
      producer: "p",
      path: `src/F${index}.tsx`,
      verified: false,
    }));
    expect(parseSourceHints(many)).toHaveLength(4);
  });
});
