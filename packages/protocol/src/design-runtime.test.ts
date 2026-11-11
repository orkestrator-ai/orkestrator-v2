import { beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type {
  DesignElement,
  DesignHierarchyPage,
  DesignStyleResult,
  DesignValidationReport,
} from "./design-canvas.js";
import {
  APP_SHORTCUTS,
  matchAppShortcut,
  appClaimsShortcut,
  shortcutFocus,
} from "./keyboard-shortcuts.js";
import { designBootstrap, designFrameDocument, installDesignRuntime } from "./design-runtime.js";

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

test("a frame regaining focus with nothing focused returns it to the field it last had", () => {
  const frame = new Window();
  frame.eval(`(${installDesignRuntime.toString()})()`);
  frame.document.body.innerHTML = '<input id="field"><input id="other">';
  const field = frame.document.querySelector("#field") as unknown as HTMLInputElement;
  const other = frame.document.querySelector("#other") as unknown as HTMLInputElement;
  const regainFocus = () => frame.dispatchEvent(new frame.Event("focus"));

  field.focus();
  // An app dialog in the editor took focus and left the frame with none.
  field.blur();
  expect(frame.document.activeElement).toBe(frame.document.body as never);
  regainFocus();
  expect(frame.document.activeElement).toBe(field as never);

  // Something already focused (a click or Tab landed first) is left alone.
  other.focus();
  field.focus();
  other.focus();
  regainFocus();
  expect(frame.document.activeElement).toBe(other as never);

  // A field the frame no longer contains (a re-render replaced it) is not revived.
  other.blur();
  other.remove();
  regainFocus();
  expect(frame.document.activeElement).toBe(frame.document.body as never);
});

test("serialized design runtime forwards each app shortcut once and consumes auto-repeat", () => {
  const frame = new Window();
  frame.eval(
    "window.__forwarded = []; window.parent.postMessage = (message) => window.__forwarded.push([message.channel, message.shortcut])",
  );
  frame.eval(
    `(${installDesignRuntime.toString()})(${matchAppShortcut.toString()}, ${JSON.stringify(APP_SHORTCUTS)}, ${appClaimsShortcut.toString()}, ${shortcutFocus.toString()})`,
  );
  // Ctrl+Shift+/ as browsers report it, and ⌘K on a Cyrillic layout.
  const dialog = { key: "?", code: "Slash", ctrlKey: true, shiftKey: true };
  const search = { key: "Л", code: "KeyK", metaKey: true, shiftKey: false };
  const press = (
    init: { key: string; code: string; shiftKey: boolean; metaKey?: boolean; ctrlKey?: boolean },
    repeat: boolean,
  ) => {
    const event = new frame.KeyboardEvent("keydown", {
      ...init,
      repeat,
      bubbles: true,
      cancelable: true,
    });
    frame.document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  };
  press(dialog, false);
  press(dialog, true);
  press(search, false);
  press(search, true);
  expect(frame.eval("window.__forwarded")).toEqual([
    ["orkestrator-design-shortcuts", "show-shortcuts"],
    ["orkestrator-design-shortcuts", "search-projects"],
  ]);
});

// Exercise the exact bootstrap output, including after the production bundler
// renames functions and local bindings. No module scope exists inside the frame.
for (const minified of [false, true]) {
  test(`design bootstrap platform/focus claims (minified=${minified})`, async () => {
    let bootstrap = designBootstrap;
    if (minified) {
      const build = await Bun.build({
        entrypoints: [import.meta.dir + "/design-runtime.ts"],
        target: "browser",
        format: "esm",
        minify: true,
      });
      expect(build.success).toBe(true);
      const code = await build.outputs[0]!.text();
      const bundled = await import(
        `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
      );
      bootstrap = bundled.designBootstrap;
    }
    for (const platform of ["MacIntel", "Win32", "Linux x86_64"]) {
      for (const tag of ["input", "textarea", "div"]) {
        const frame = new Window();
        Object.defineProperty(frame.navigator, "platform", { value: platform, configurable: true });
        frame.eval(
          "window.__forwarded = []; window.parent.postMessage = message => window.__forwarded.push(message)",
        );
        const html = bootstrap("serialized-runtime-test-nonce");
        const script = html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)![1]!;
        frame.eval(script);
        const input = frame.document.createElement(tag);
        frame.document.body.append(input);
        input.focus();
        const press = (mods: {
          ctrlKey?: boolean;
          metaKey?: boolean;
          shiftKey?: boolean;
          key?: string;
          code?: string;
        }) => {
          const event = new frame.KeyboardEvent("keydown", {
            key: "k",
            code: "KeyK",
            bubbles: true,
            cancelable: true,
            ...mods,
          });
          input.dispatchEvent(event);
          return event.defaultPrevented;
        };
        const killLine = platform === "MacIntel" && tag !== "div";
        expect(press({ ctrlKey: true })).toBe(!killLine);
        expect(frame.eval("window.__forwarded.length")).toBe(killLine ? 0 : 1);
        expect(press({ metaKey: true })).toBe(true);
        expect(press({ ctrlKey: true, shiftKey: true, key: "?", code: "Slash" })).toBe(true);
        expect(frame.eval("window.__forwarded.map(message => message.shortcut)")).toEqual([
          ...(!killLine ? ["search-projects"] : []),
          "search-projects",
          "show-shortcuts",
        ]);
        await frame.happyDOM.close();
      }
    }
  });
}

describe("designFrameDocument", () => {
  const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("base64");
  const document = designFrameDocument(sha256);
  const script = /<script>([\s\S]*)<\/script><\/body>/.exec(document)?.[1];

  test("pins exactly the script it carries, so authored code still cannot execute", () => {
    if (!script) throw new Error("Expected an inline bootstrap");
    expect(document).toContain(`script-src 'sha256-${sha256(script)}'`);
    expect(document).not.toContain("'nonce-");
    expect(document).toContain("connect-src 'none'");
  });

  test("declares its charset, because the hash covers the decoded script", () => {
    expect(document.indexOf('<meta charset="utf-8">')).toBeLessThan(document.indexOf("<script"));
  });

  test("carries the same runtime as the nonce form", () => {
    const nonced = designBootstrap("a".repeat(32));
    expect(nonced).toContain(`<script nonce="${"a".repeat(32)}">${script}</script>`);
  });
});
