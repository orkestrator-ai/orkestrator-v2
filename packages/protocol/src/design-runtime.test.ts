import { beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type {
  DesignElement,
  DesignHierarchyPage,
  DesignStyleResult,
  DesignValidationReport,
} from "./design-canvas.js";
import { installDesignRuntime } from "./design-runtime.js";

describe("design runtime sanitizer", () => {
  let testWindow: Window;
  beforeEach(() => {
    testWindow = new Window();
    testWindow.eval(`(${installDesignRuntime.toString()})()`);
  });

  const run = (operation: unknown) =>
    (testWindow as unknown as { orkDesign: (operation: unknown) => unknown }).orkDesign(operation);

  test("removes forbidden markup recursively from template contents", () => {
    run({
      op: "render",
      html: '<template id="outer"><script>bad()</script><iframe src="data:text/html,bad"></iframe><template><frame src="bad"></frame></template><p>safe</p></template>',
    });

    const template = testWindow.document.querySelector("#outer") as unknown as HTMLTemplateElement;
    expect(template.content.querySelectorAll("script,iframe,frame")).toHaveLength(0);
    expect(template.content.querySelector("p")?.textContent).toBe("safe");
    expect(String(run({ op: "serialize" }))).not.toContain("<script");
  });

  test("removes event handlers and executable URL attributes", () => {
    run({
      op: "render",
      html: '<a id="bad" href=" javascript:alert(1)" onclick="bad()">bad</a><img id="safe" src="data:image/png;base64,AA==">',
    });

    expect(testWindow.document.querySelector("#bad")?.hasAttribute("href")).toBe(false);
    expect(testWindow.document.querySelector("#bad")?.hasAttribute("onclick")).toBe(false);
    expect(testWindow.document.querySelector("#safe")?.getAttribute("src")).toStartWith(
      "data:image/png",
    );
  });

  test("validation reports removed and blocked content with bounded counts", () => {
    const report = run({
      op: "validate",
      html: '<script>x()</script><script>y()</script><img src="https://example.invalid/a.png" onerror="z()"><div style="background:url(https://example.invalid/b.png)"></div><a href="javascript:void 0">x</a><iframe></iframe>',
    }) as DesignValidationReport;
    expect(report.removed.scripts).toBe(2);
    expect(report.removed.handlers).toBe(1);
    expect(report.removed.executableUrls).toBe(1);
    expect(report.removed.forbiddenElements).toBe(1);
    expect(report.removed.externalReferences).toBeGreaterThanOrEqual(2);
    expect(report.overElementLimit).toBe(false);
    // Validation never renders into the live document.
    expect(testWindow.document.querySelector("img")).toBeNull();
  });

  test("validation counts template contents toward the element budget", () => {
    const inner = "<i></i>".repeat(2600);
    const report = run({
      op: "validate",
      html: `<template>${inner}</template><template>${inner}</template>`,
    }) as DesignValidationReport;
    expect(report.elementCount).toBeGreaterThan(5000);
    expect(report.overElementLimit).toBe(true);
    expect(() =>
      run({ op: "render", html: `<template>${inner}</template><template>${inner}</template>` }),
    ).toThrow("Frame exceeds 5000 elements");
  });
});

describe("design runtime editing", () => {
  let testWindow: Window;
  const run = (operation: unknown) =>
    (testWindow as unknown as { orkDesign: (operation: unknown) => unknown }).orkDesign(operation);
  beforeEach(() => {
    testWindow = new Window();
    testWindow.eval(`(${installDesignRuntime.toString()})()`);
    run({
      op: "render",
      html: '<main id="root"><h1 id="title" style="color: red">Title</h1><section><p>One</p><p>Two</p></section></main>',
    });
  });

  test("moveElement rejects parents that cannot preserve element children", () => {
    run({
      op: "appendHtml",
      html: '<img id="image"><input id="field"><template id="slot"></template><style id="css"></style><textarea id="text"></textarea>',
    });
    for (const parentSelector of ["#image", "#field", "#slot", "#css", "#text"]) {
      expect(() => run({ op: "moveElement", selector: "#title", parentSelector })).toThrow(
        "Invalid element move",
      );
      expect(testWindow.document.querySelector("#title")?.parentElement?.id).toBe("root");
    }
    expect(() => run({ op: "moveElement", selector: "#root", parentSelector: "#title" })).toThrow(
      "Invalid element move",
    );
    expect(() =>
      run({
        op: "moveElement",
        selector: "#title",
        parentSelector: "#root",
        beforeSelector: "section p:first-child",
      }),
    ).toThrow("Invalid element move");
    expect(
      String(run({ op: "moveElement", selector: "#title", parentSelector: "section" })),
    ).toContain('<h1 id="title"');
  });

  test("applyStyles is atomic: one invalid value applies nothing", () => {
    const result = run({
      op: "applyStyles",
      selector: "#title",
      styles: { color: "blue", "font-size": "definitely-not-a-size" },
    }) as DesignStyleResult;
    expect(result.invalid).toEqual(["font-size"]);
    expect(result.html).toBe("");
    expect(
      (testWindow.document.querySelector("#title") as unknown as HTMLElement).style.color,
    ).toBe("red");
  });

  test("applyStyles reports unchanged declarations and serializes real changes", () => {
    const same = run({
      op: "applyStyles",
      selector: "#title",
      styles: { color: "red" },
    }) as DesignStyleResult;
    expect(same.unchanged).toEqual(["color"]);
    expect(same.html).toBe("");
    const changed = run({
      op: "applyStyles",
      selector: "#title",
      styles: { color: null, "font-weight": "700 !important" },
    }) as DesignStyleResult;
    expect(changed.invalid).toEqual([]);
    expect(changed.html).toContain("font-weight: 700 !important");
    expect(changed.html).not.toContain("color: red");
  });

  test("inspection reports inline overrides separately from computed values", () => {
    const element = run({ op: "inspectElement", selector: "#title" }) as DesignElement;
    expect(element.inline).toEqual({ color: "red" });
    expect(element.styles.color).toBeTruthy();
    expect(element.key).toBe(element.selector);
    expect(element.textTruncated).toBe(false);
  });

  test("hierarchy pages are bounded and their cursors are bound to structure", () => {
    const first = run({ op: "hierarchyPage", maxNodes: 1, maxDepth: 3 }) as DesignHierarchyPage;
    expect(first.layers).toHaveLength(1);
    expect(first.layers[0]).toMatchObject({ tag: "main", childCount: 2 });
    expect(first.truncated).toBe(true);
    const second = run({
      op: "hierarchyPage",
      maxNodes: 2,
      maxDepth: 3,
      cursor: first.nextCursor,
    }) as DesignHierarchyPage;
    expect(second.layers.map((layer) => layer.tag)).toEqual(["h1", "section"]);
    // A structural change invalidates the cursor instead of mixing trees.
    run({ op: "appendHtml", html: "<footer>new</footer>" });
    expect(() => run({ op: "hierarchyPage", maxNodes: 2, cursor: second.nextCursor })).toThrow(
      "Hierarchy changed; reload this branch",
    );
  });

  test("children of a branch load lazily from its selector", () => {
    const page = run({
      op: "hierarchyPage",
      rootSelector: "#root > section",
      maxDepth: 1,
    }) as DesignHierarchyPage;
    expect(page.layers.map((layer) => layer.tag)).toEqual(["p", "p"]);
    expect(page.total).toBe(2);
    expect(page.truncated).toBe(false);
  });

  test("preview mode is a runtime flag only; inspect mode restores scroll", () => {
    expect(run({ op: "setMode", mode: "preview" })).toBe("preview");
    expect(testWindow.document.documentElement.hasAttribute("data-ork-preview")).toBe(true);
    expect(run({ op: "setMode", mode: "inspect" })).toBe("inspect");
    expect(testWindow.document.documentElement.hasAttribute("data-ork-preview")).toBe(false);
  });
});
