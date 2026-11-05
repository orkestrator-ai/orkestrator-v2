import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { installDesignRuntime } from "./design-runtime.js";
import { FRAME_CHANNEL_POLICY, STATIC_PRESENTATION_POLICY } from "./rich-content-policy.js";
import {
  STATIC_HTML_FRAME_CHANNEL,
  STATIC_HTML_MAX_TEXT_CHUNKS,
  installStaticHtmlPresentationRuntime,
  parseStaticHtmlFrameMessage,
  staticHtmlFrameBootstrap,
  staticHtmlFrameDocument,
} from "./static-html-presentation.js";
import {
  ACTIVITY_REPORT_HTML,
  ACTIVITY_REPORT_MODELS,
  ACTIVITY_REPORT_SESSIONS,
  HOSTILE_REPORT_HTML,
  PLAIN_REPORT_HTML,
} from "./testing/static-html-fixtures.js";

const NONCE = "a".repeat(32);
const GENERATION = "g".repeat(32);
const THEME = {
  appearance: "dark",
  reducedMotion: false,
  tokens: { "--ork-foreground": "#fafafa", "--internal-token": "#000000" },
};

type Posted = Record<string, unknown>;

interface Frame {
  window: Window;
  posted: () => Posted[];
  send: (message: Record<string, unknown>) => Promise<void>;
  evaluate: (code: string) => unknown;
}

/** A runtime in a happy-dom window whose parent is observable and addressable. */
async function frameWith(url = "https://frame.invalid/doc"): Promise<Frame> {
  const window = new Window({ url });
  window.eval(
    "window.__posted = []; window.parent = { postMessage: (message) => window.__posted.push(message) };",
  );
  window.eval(
    `(${installStaticHtmlPresentationRuntime.toString()})(${JSON.stringify({
      nonce: NONCE,
      maxHtmlBytes: STATIC_PRESENTATION_POLICY.maxDocumentBytes,
      maxElements: STATIC_PRESENTATION_POLICY.maxElements,
      maxLinkCharacters: FRAME_CHANNEL_POLICY.maxLinkCharacters,
      maxReportedHeight: 100_000,
      maxTextCharacters: STATIC_PRESENTATION_POLICY.maxSearchTextCharacters,
      textChunkCharacters: STATIC_PRESENTATION_POLICY.searchTextChunkCharacters,
    })})`,
  );
  return {
    window,
    posted: () => window.eval("window.__posted") as Posted[],
    evaluate: (code) => window.eval(code),
    send: async (message) => {
      const event = new window.MessageEvent("message", {
        data: { channel: STATIC_HTML_FRAME_CHANNEL, v: 1, ...message },
        source: window.parent as never,
      });
      window.dispatchEvent(event);
    },
  };
}

function renderMessage(html: string) {
  return {
    type: "render",
    generation: GENERATION,
    html,
    theme: THEME,
    verifiedAppearance: "light",
  };
}

function reported(frame: Frame): Posted[] {
  return frame.posted().filter((message) => message.type === "text");
}

async function reportedText(html: string): Promise<string> {
  const frame = await frameWith();
  await frame.send(renderMessage(html));
  return reported(frame)
    .map((message) => message.text)
    .join("");
}

describe("presentation runtime", () => {
  test("reports readiness with its nonce before it holds any content", async () => {
    const frame = await frameWith();
    expect(frame.posted()).toEqual([
      { channel: STATIC_HTML_FRAME_CHANNEL, v: 1, type: "ready", nonce: NONCE },
    ]);
  });

  test("tall documents clamp rendered and later size reports to the parser limit", async () => {
    const frame = await frameWith();
    frame.evaluate("Element.prototype.getBoundingClientRect = () => ({ height: 150000 })");
    await frame.send(renderMessage("<p>Tall report</p>"));
    const rendered = frame.posted().find((message) => message.type === "rendered")!;
    expect(rendered.height).toBe(100_000);
    expect(parseStaticHtmlFrameMessage(rendered, GENERATION).ok).toBe(true);
    frame.evaluate("Element.prototype.getBoundingClientRect = () => ({ height: 400 })");
    frame.window.document.dispatchEvent(new frame.window.Event("toggle"));
    await frame.window.happyDOM.waitUntilComplete();
    frame.evaluate("Element.prototype.getBoundingClientRect = () => ({ height: 200000 })");
    frame.window.document.dispatchEvent(new frame.window.Event("toggle"));
    await frame.window.happyDOM.waitUntilComplete();
    const size = frame
      .posted()
      .filter((message) => message.type === "size")
      .at(-1)!;
    expect(size.height).toBe(100_000);
    expect(parseStaticHtmlFrameMessage(size, GENERATION).ok).toBe(true);
  });

  test("renders the reference dashboard as real selectable document content", async () => {
    const frame = await frameWith();
    await frame.send(renderMessage(ACTIVITY_REPORT_HTML));
    const document = frame.window.document;
    expect(document.querySelector("h1")?.textContent).toBe("Agent activity and cost");
    for (const session of ACTIVITY_REPORT_SESSIONS)
      expect(document.body.textContent).toContain(session.label);
    for (const model of ACTIVITY_REPORT_MODELS)
      expect(document.body.textContent).toContain(`$${model.cost.toFixed(2)}`);
    expect(document.querySelectorAll("svg.timeline")).toHaveLength(ACTIVITY_REPORT_SESSIONS.length);
    expect(document.querySelector("table")).not.toBeNull();
    expect(document.querySelector("details#methodology")).not.toBeNull();
    const rendered = frame.posted().find((message) => message.type === "rendered");
    expect(rendered?.generation).toBe(GENERATION);
    expect(rendered?.elementCount).toBeGreaterThan(20);
  });

  test("applies only --ork-* theme tokens, ahead of the rendered report", async () => {
    const frame = await frameWith();
    await frame.send(renderMessage("<p style='color:var(--ork-foreground)'>Report</p>"));
    const root = frame.window.document.documentElement;
    expect(root.style.getPropertyValue("--ork-foreground")).toBe("#fafafa");
    expect(root.style.getPropertyValue("--internal-token")).toBe("");
    expect(root.dataset.orkTheme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
    await frame.send({
      type: "theme",
      generation: GENERATION,
      theme: { appearance: "light", reducedMotion: true, tokens: {} },
    });
    expect(root.dataset.orkTheme).toBe("light");
    expect(root.dataset.orkReducedMotion).toBe("true");
    expect(root.style.getPropertyValue("--ork-foreground")).toBe("");
  });

  test("a document without tokens keeps its verified appearance on an opaque canvas", async () => {
    const frame = await frameWith();
    await frame.send(renderMessage(PLAIN_REPORT_HTML));
    const document = frame.window.document;
    const root = document.documentElement;
    expect(frame.posted().find((message) => message.type === "rendered")).toMatchObject({
      themed: false,
    });
    expect(root.dataset.orkTheme).toBe("light");
    expect(root.style.colorScheme).toBe("light");
    expect(root.style.getPropertyValue("--ork-foreground")).toBe("");
    const style = document.querySelector("style[data-ork-presentation]")?.textContent ?? "";
    expect(style).toContain("background:Canvas");
    expect(style).not.toContain("--ork-foreground");
    // A later theme change is not this document's to follow.
    await frame.send({ type: "theme", generation: GENERATION, theme: THEME });
    expect(root.dataset.orkTheme).toBe("light");
  });

  test("a document naming a token follows the application theme", async () => {
    const frame = await frameWith();
    await frame.send(renderMessage(ACTIVITY_REPORT_HTML));
    expect(frame.posted().find((message) => message.type === "rendered")).toMatchObject({
      themed: true,
    });
    expect(frame.window.document.documentElement.dataset.orkTheme).toBe("dark");
  });

  test("reports the document's text for Find after it renders, including closed disclosures", async () => {
    const frame = await frameWith();
    await frame.send(renderMessage(ACTIVITY_REPORT_HTML));
    const types = frame.posted().map((message) => message.type);
    expect(types.indexOf("text")).toBeGreaterThan(types.indexOf("rendered"));
    const text = reported(frame)
      .map((message) => message.text)
      .join("");
    expect(text).toContain("Agent activity and cost");
    for (const session of ACTIVITY_REPORT_SESSIONS) expect(text).toContain(session.label);
    const closed = frame.window.document.querySelector("details#methodology p")?.textContent;
    expect(closed).toBeTruthy();
    expect(text).toContain(closed!.replace(/\s+/g, " ").trim());
    expect(text).not.toContain("{");
  });

  test("reported text leaves out code, styles and hidden elements, in hostile documents too", async () => {
    const text = await reportedText(
      `<!doctype html><html><head><title>Tab title</title><style>.a{color:red}</style></head>
       <body><style>.b{color:red}</style><p>Kept</p><script>window.__authored = "authored script"</script>
       <noscript>No script fallback</noscript><p hidden>Hidden paragraph</p>
       <template><p>Template content</p></template>
       <svg><text>Axis label</text></svg></body></html>`,
    );
    expect(text).toBe("Kept\nAxis label");
    const hostile = await reportedText(HOSTILE_REPORT_HTML);
    expect(hostile).toContain("Hostile report");
    expect(hostile).not.toContain("__authored");
  });

  test("reported text keeps inline runs together and block boundaries apart", async () => {
    expect(
      await reportedText(
        "<p>Total  <b>cost</b>\n was $<span>12</span>.50&nbsp;net</p><table><tr><td>One</td><td>Two</td></tr></table>",
      ),
    ).toBe("Total cost was $12.50 net\nOne\nTwo");
  });

  test("reported text collapses whitespace across nested inline and comment boundaries", async () => {
    const text = await reportedText(
      "<p>Hello <strong> world</strong></p>" +
        "<p><span>Status: </span> <b>ok</b> <!-- c --> done</p>" +
        "<p>Nested <span> <em> inline </em> </span> text</p>",
    );
    expect(text).toBe("Hello world\nStatus: ok done\nNested inline text");
    for (const phrase of ["Hello world", "Status: ok done", "Nested inline text"])
      expect(text.match(new RegExp(phrase, "g"))).toHaveLength(1);
    expect(text).not.toContain("world Status");
  });

  test("a document with no text reports none", async () => {
    const frame = await frameWith();
    await frame.send(renderMessage("<svg><rect width='5' height='5'/></svg>"));
    expect(frame.posted().at(-1)).toMatchObject({ type: "rendered" });
  });

  test("a refused document reports no text", async () => {
    const frame = await frameWith();
    await frame.send(
      renderMessage(`<p>Words</p>${"<i></i>".repeat(STATIC_PRESENTATION_POLICY.maxElements + 1)}`),
    );
    expect(reported(frame)).toEqual([]);
  });

  test("reported text is bounded and split into messages the channel accepts", async () => {
    const limit = STATIC_PRESENTATION_POLICY.maxSearchTextCharacters;
    const frame = await frameWith();
    await frame.send(renderMessage(`<p>${"漢".repeat(limit + 500)}</p>`));
    const chunks = reported(frame);
    expect(chunks).toHaveLength(STATIC_HTML_MAX_TEXT_CHUNKS);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe("漢".repeat(limit));
    chunks.forEach((chunk, index) => {
      expect(chunk).toMatchObject({ index, count: chunks.length, generation: GENERATION });
      expect(parseStaticHtmlFrameMessage(chunk, GENERATION).ok).toBe(true);
      const encoded = new TextEncoder().encode(JSON.stringify(chunk)).length;
      expect(encoded).toBeLessThanOrEqual(FRAME_CHANNEL_POLICY.maxMessageBytes);
    });
    // A full report, with `ready` and `rendered`, fits the channel's burst.
    expect(STATIC_HTML_MAX_TEXT_CHUNKS + 2).toBeLessThanOrEqual(FRAME_CHANNEL_POLICY.burst);
  });

  test("removes authored code, frames and executable URLs", async () => {
    const frame = await frameWith();
    await frame.send(renderMessage(HOSTILE_REPORT_HTML));
    const document = frame.window.document;
    expect(document.querySelectorAll("script,iframe,object,embed,base,meta,link")).toHaveLength(0);
    expect(document.querySelector("#tpl")?.innerHTML).not.toContain("script");
    expect(document.querySelector("#beacon")?.hasAttribute("onerror")).toBe(false);
    expect(document.querySelector("#js-link")?.hasAttribute("href")).toBe(false);
    expect(document.querySelector("#form")?.hasAttribute("action")).toBe(false);
    expect(document.querySelector("#submit")?.hasAttribute("formaction")).toBe(false);
    expect(document.body.hasAttribute("onload")).toBe(false);
    expect(frame.evaluate("window.__authored")).toBeUndefined();
  });

  test("matches the design runtime's sanitizer exactly", async () => {
    for (const html of [HOSTILE_REPORT_HTML, ACTIVITY_REPORT_HTML]) {
      const design = new Window();
      design.eval(`(${installDesignRuntime.toString()})()`);
      const run = (design as unknown as { orkDesign: (operation: unknown) => unknown }).orkDesign;
      run({ op: "render", html });
      const frame = await frameWith();
      await frame.send(renderMessage(html));
      const document = frame.window.document;
      document.querySelector("style[data-ork-presentation]")?.remove();
      document.documentElement.removeAttribute("style");
      document.documentElement.removeAttribute("data-ork-theme");
      document.documentElement.removeAttribute("data-ork-reduced-motion");
      expect(document.documentElement.outerHTML).toBe(design.document.documentElement.outerHTML);
    }
  });

  test("renders one document per mount and ignores a second render", async () => {
    const frame = await frameWith();
    await frame.send(renderMessage("<p id='first'>First</p>"));
    await frame.send({ ...renderMessage("<p id='second'>Second</p>"), generation: "h".repeat(32) });
    await frame.send(renderMessage("<p id='third'>Third</p>"));
    expect(frame.window.document.querySelector("#first")).not.toBeNull();
    expect(frame.window.document.querySelector("#second")).toBeNull();
    expect(frame.window.document.querySelector("#third")).toBeNull();
  });

  test("ignores a render from anything but its parent, or with a malformed generation", async () => {
    const frame = await frameWith();
    frame.window.dispatchEvent(
      new frame.window.MessageEvent("message", {
        data: { channel: STATIC_HTML_FRAME_CHANNEL, v: 1, ...renderMessage("<p id='x'>x</p>") },
        source: frame.window as never,
      }),
    );
    expect(frame.window.document.querySelector("#x")).toBeNull();
    await frame.send({ ...renderMessage("<p id='y'>y</p>"), generation: "short" });
    expect(frame.window.document.querySelector("#y")).toBeNull();
    expect(frame.posted().map((message) => message.type)).toEqual(["ready"]);
  });

  test("refuses an over-budget document without parsing it into the frame", async () => {
    const frame = await frameWith();
    const oversized = `<p>${"x".repeat(STATIC_PRESENTATION_POLICY.maxDocumentBytes + 1)}</p>`;
    await frame.send(renderMessage(oversized));
    expect(frame.posted().at(-1)).toMatchObject({ type: "error", code: "too-large" });
    expect(frame.window.document.querySelector("p")).toBeNull();
  });

  test("enforces the element budget before the document becomes visible", async () => {
    const frame = await frameWith();
    const html = `<div>${"<i></i>".repeat(STATIC_PRESENTATION_POLICY.maxElements + 1)}</div>`;
    await frame.send(renderMessage(html));
    expect(frame.posted().at(-1)).toMatchObject({ type: "error", code: "too-many-elements" });
    expect(frame.window.document.querySelector("i")).toBeNull();
  });

  test("native disclosure toggling keeps its default action", async () => {
    const frame = await frameWith();
    await frame.send(renderMessage(HOSTILE_REPORT_HTML));
    const summary = frame.window.document.querySelector("#disclosure-summary")!;
    const click = new frame.window.MouseEvent("click", { bubbles: true, cancelable: true });
    summary.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
  });

  test("links, SVG links and form submission never navigate", async () => {
    const frame = await frameWith();
    await frame.send(renderMessage(HOSTILE_REPORT_HTML));
    const document = frame.window.document;
    for (const selector of ["#web-link", "#download-link", "#fragment-link", "#svg-rect"]) {
      const click = new frame.window.MouseEvent("click", { bubbles: true, cancelable: true });
      document.querySelector(selector)!.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
    }
    const aux = new frame.window.MouseEvent("auxclick", {
      bubbles: true,
      cancelable: true,
      button: 1,
    });
    document.querySelector("#web-link")!.dispatchEvent(aux);
    expect(aux.defaultPrevented).toBe(true);
    const submit = new frame.window.Event("submit", { bubbles: true, cancelable: true });
    document.querySelector("#form")!.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);
  });

  test("a synthetic click cannot request a link", async () => {
    const frame = await frameWith();
    await frame.send(renderMessage(HOSTILE_REPORT_HTML));
    const click = new frame.window.MouseEvent("click", { bubbles: true, cancelable: true });
    frame.window.document.querySelector("#web-link")!.dispatchEvent(click);
    expect(frame.posted().some((message) => message.type === "link-request")).toBe(false);
  });

  test("Escape is the only key that reaches the host, and carries no key data", async () => {
    const frame = await frameWith();
    await frame.send(renderMessage("<p>Report</p>"));
    const before = frame.posted().length;
    for (const key of ["k", "Enter", "ArrowDown"]) {
      frame.window.document.dispatchEvent(
        new frame.window.KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true }),
      );
    }
    expect(frame.posted()).toHaveLength(before);
    frame.window.document.dispatchEvent(
      new frame.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(frame.posted().at(-1)).toEqual({
      channel: STATIC_HTML_FRAME_CHANNEL,
      v: 1,
      type: "escape",
      generation: GENERATION,
    });
  });

  test("interaction reports are coalesced booleans with no selected text", async () => {
    const frame = await frameWith();
    await frame.send(renderMessage("<p>Report</p>"));
    frame.window.dispatchEvent(new frame.window.Event("focus"));
    await frame.window.happyDOM.waitUntilComplete();
    const report = frame.posted().find((message) => message.type === "interaction");
    expect(report).toEqual({
      channel: STATIC_HTML_FRAME_CHANNEL,
      v: 1,
      type: "interaction",
      generation: GENERATION,
      focused: true,
      hasSelection: false,
      pointerSelecting: false,
    });
  });
});

describe("parseStaticHtmlFrameMessage", () => {
  const envelope = { channel: STATIC_HTML_FRAME_CHANNEL, v: 1 };
  const reason = (data: unknown, generation: string | null = GENERATION) => {
    const parsed = parseStaticHtmlFrameMessage(data, generation);
    return parsed.ok ? "ok" : parsed.reason;
  };

  test("accepts each message in its exact shape", () => {
    for (const message of [
      { type: "ready", nonce: NONCE },
      { type: "rendered", generation: GENERATION, height: 400, elementCount: 12, themed: true },
      { type: "text", generation: GENERATION, index: 0, count: 1, text: "Report" },
      { type: "size", generation: GENERATION, height: 0 },
      { type: "error", generation: GENERATION, code: "render-failed" },
      {
        type: "interaction",
        generation: GENERATION,
        focused: true,
        hasSelection: false,
        pointerSelecting: false,
      },
      { type: "link-request", generation: GENERATION, url: "https://example.com/", label: "x" },
      { type: "escape", generation: GENERATION },
    ])
      expect(reason({ ...envelope, ...message })).toBe("ok");
  });

  test("rejects foreign, malformed and mismatched messages", () => {
    expect(reason(null)).toBe("not-object");
    expect(reason([])).toBe("not-object");
    expect(reason({ channel: "other", v: 1, type: "ready", nonce: NONCE })).toBe("wrong-channel");
    expect(reason({ ...envelope, v: 2, type: "ready", nonce: NONCE })).toBe("wrong-version");
    expect(reason({ ...envelope, type: "invoke", generation: GENERATION })).toBe("unknown-type");
    expect(reason({ ...envelope, type: "constructor", generation: GENERATION })).toBe(
      "unknown-type",
    );
    expect(reason({ ...envelope, type: "ready", nonce: "short" })).toBe("bad-shape");
    expect(reason({ ...envelope, type: "escape", generation: GENERATION, key: "k" })).toBe(
      "bad-shape",
    );
    expect(reason({ ...envelope, type: "escape", generation: "x".repeat(32) })).toBe(
      "generation-mismatch",
    );
    expect(reason({ ...envelope, type: "escape", generation: GENERATION }, null)).toBe(
      "generation-mismatch",
    );
    expect(
      reason({ ...envelope, type: "size", generation: GENERATION, height: { nested: 1 } }),
    ).toBe("bad-shape");
  });

  test("rejects nonfinite, negative and implausible sizes", () => {
    for (const height of [Number.NaN, Number.POSITIVE_INFINITY, -1, 100_001, "400"])
      expect(reason({ ...envelope, type: "size", generation: GENERATION, height })).toBe(
        "bad-shape",
      );
  });

  test("rejects malformed, oversized and out-of-range text chunks", () => {
    const chunk = { ...envelope, type: "text", generation: GENERATION, index: 0, count: 1 };
    const size = STATIC_PRESENTATION_POLICY.searchTextChunkCharacters;
    expect(reason({ ...chunk, text: "x".repeat(size) })).toBe("ok");
    for (const text of ["", "x".repeat(size + 1), 5, null])
      expect(reason({ ...chunk, text })).toBe("bad-shape");
    for (const [index, count] of [
      [1, 1],
      [-1, 1],
      [0.5, 1],
      [0, 0],
      [0, STATIC_HTML_MAX_TEXT_CHUNKS + 1],
      ["0", 1],
    ])
      expect(reason({ ...chunk, text: "x", index, count })).toBe("bad-shape");
    expect(reason({ ...chunk, text: "x", generation: "x".repeat(32) })).toBe("generation-mismatch");
  });

  test("rejects links that are not plain http(s), and unknown error codes", () => {
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "https://u:p@example.com/"])
      expect(
        reason({ ...envelope, type: "link-request", generation: GENERATION, url, label: "" }),
      ).toBe("bad-shape");
    expect(reason({ ...envelope, type: "error", generation: GENERATION, code: "other" })).toBe(
      "bad-shape",
    );
  });

  test("rejects an oversized message before reading it", () => {
    expect(
      reason({
        ...envelope,
        type: "link-request",
        generation: GENERATION,
        url: `https://example.com/${"x".repeat(FRAME_CHANNEL_POLICY.maxMessageBytes)}`,
        label: "",
      }),
    ).toBe("too-large");
  });
});

describe("frame documents", () => {
  const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("base64");
  const document = staticHtmlFrameDocument(sha256);
  const script = /<script>([\s\S]*)<\/script><\/body>/.exec(document)?.[1];

  test("the production document pins exactly its script and refuses every other source", () => {
    if (!script) throw new Error("Expected an inline bootstrap");
    expect(document).toContain(`script-src 'sha256-${sha256(script)}'`);
    expect(document).not.toContain("'nonce-");
    for (const directive of [
      "default-src 'none'",
      "connect-src 'none'",
      "frame-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
    ])
      expect(document).toContain(directive);
  });

  test("the production document reads its readiness nonce from the URL fragment", async () => {
    if (!script) throw new Error("Expected an inline bootstrap");
    const frame = new Window({ url: `https://frame.invalid/static-html-frame.html#${NONCE}` });
    frame.eval(
      "window.__posted = []; window.parent = { postMessage: (m) => window.__posted.push(m) };",
    );
    frame.eval(script);
    expect(frame.eval("window.__posted")).toEqual([
      { channel: STATIC_HTML_FRAME_CHANNEL, v: 1, type: "ready", nonce: NONCE },
    ]);
  });

  test("without a valid nonce the frame never announces itself", () => {
    if (!script) throw new Error("Expected an inline bootstrap");
    const frame = new Window({ url: "https://frame.invalid/static-html-frame.html#short" });
    frame.eval(
      "window.__posted = []; window.parent = { postMessage: (m) => window.__posted.push(m) };",
    );
    frame.eval(script);
    expect(frame.eval("window.__posted")).toEqual([]);
  });

  test("the development bootstrap carries the mount nonce and rejects a bad one", () => {
    const bootstrap = staticHtmlFrameBootstrap(NONCE);
    expect(bootstrap).toContain(`script-src 'nonce-${NONCE}'`);
    expect(bootstrap).toContain(`<script nonce="${NONCE}">`);
    expect(() => staticHtmlFrameBootstrap("bad nonce")).toThrow("Invalid mount nonce");
  });

  test("the runtime survives the production bundler renaming its bindings", async () => {
    const build = await Bun.build({
      entrypoints: [`${import.meta.dir}/static-html-presentation.ts`],
      target: "browser",
      format: "esm",
      minify: true,
    });
    expect(build.success).toBe(true);
    const code = await build.outputs[0]!.text();
    const bundled = await import(
      `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
    );
    const html: string = bundled.staticHtmlFrameBootstrap(NONCE);
    const inline = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(html)![1]!;
    const frame = new Window({ url: "https://frame.invalid/doc" });
    frame.eval(
      "window.__posted = []; window.parent = { postMessage: (m) => window.__posted.push(m) };",
    );
    frame.eval(inline);
    frame.dispatchEvent(
      new frame.MessageEvent("message", {
        data: {
          channel: STATIC_HTML_FRAME_CHANNEL,
          v: 1,
          type: "render",
          generation: GENERATION,
          html: "<p id='minified'>Rendered</p>",
          theme: THEME,
          verifiedAppearance: "light",
        },
        source: frame.parent as never,
      }),
    );
    expect(frame.document.querySelector("#minified")?.textContent).toBe("Rendered");
    expect(frame.eval("window.__posted").map((message: Posted) => message.type)).toEqual([
      "ready",
      "rendered",
      "text",
    ]);
    expect(frame.eval("window.__posted").at(-1).text).toBe("Rendered");
  });
});
