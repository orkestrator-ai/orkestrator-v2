import { describe, expect, mock, test } from "bun:test";

import {
  ARTIFACT_FRAME_CHANNEL,
  parseArtifactFrameMessage,
  parseArtifactShellMessage,
} from "@orkestrator/protocol/artifact-frame-channel";
import { FRAME_CHANNEL_POLICY } from "@orkestrator/protocol/rich-content-policy";

import { artifactShellResponse, artifactShellScript } from "./content-shell.js";
import { inlineScriptHash } from "./interactive-csp.js";

const DOCUMENT_URL = `http://localhost:47123/a/${"A".repeat(43)}`;
const APP = "http://127.0.0.1:4100";
const identity = { artifactId: "art_shell0001", revision: 2, generation: "gen-shell-1" };

type Listener = (event: Record<string, unknown>) => void;

/** Runs the real shell script against a minimal window, document and frame element. */
function runShell({
  parentOrigins = [APP],
  topLevel = false,
}: { parentOrigins?: string[]; topLevel?: boolean } = {}) {
  const artifactWindow = { postMessage: mock((_message: unknown, _target: string) => undefined) };
  const parentWindow = { postMessage: mock((_message: unknown, _target: string) => undefined) };
  const listeners: Record<string, Listener[]> = {};
  const documentListeners: Record<string, Listener[]> = {};
  const frameListeners: Record<string, Listener[]> = {};
  const steps: string[] = [];
  const attributes: Record<string, string> = {};
  let removed = false;
  const frame = {
    setAttribute: (name: string, value: string) => {
      steps.push(`attr:${name}`);
      attributes[name] = value;
    },
    addEventListener: (type: string, callback: Listener) => {
      (frameListeners[type] ??= []).push(callback);
    },
    remove: () => {
      removed = true;
    },
    get contentWindow() {
      return removed ? null : artifactWindow;
    },
  };
  const fakeWindow: Record<string, unknown> = {
    addEventListener: (type: string, callback: Listener) => {
      (listeners[type] ??= []).push(callback);
    },
  };
  fakeWindow.parent = topLevel ? fakeWindow : parentWindow;
  const fakeDocument = {
    createElement: (tag: string) => {
      steps.push(`create:${tag}`);
      return frame;
    },
    addEventListener: (type: string, callback: Listener) => {
      (documentListeners[type] ??= []).push(callback);
    },
    body: {
      appendChild: () => {
        steps.push("append");
      },
    },
  };
  const script = artifactShellScript({ documentUrl: DOCUMENT_URL, parentOrigins, identity });
  new Function("window", "document", script)(fakeWindow, fakeDocument);
  const dispatch = (event: Record<string, unknown>) =>
    (listeners.message ?? []).forEach((listener) => listener(event));
  return {
    steps,
    attributes,
    artifactWindow,
    parentWindow,
    removed: () => removed,
    fromFrame(data: unknown, overrides: Record<string, unknown> = {}) {
      dispatch({ source: artifactWindow, origin: "null", data, ...overrides });
    },
    fromParent(data: unknown, overrides: Record<string, unknown> = {}) {
      dispatch({ source: parentWindow, origin: APP, data, ...overrides });
    },
    load() {
      (frameListeners.load ?? []).forEach((listener) => listener({}));
    },
    violation(effectiveDirective: string) {
      (documentListeners.securitypolicyviolation ?? []).forEach((listener) =>
        listener({ effectiveDirective, violatedDirective: effectiveDirective }),
      );
    },
    toParent: () => parentWindow.postMessage.mock.calls.map((call) => call[0]),
    toFrame: () => artifactWindow.postMessage.mock.calls.map((call) => call[0]),
  };
}

const base = { channel: ARTIFACT_FRAME_CHANNEL, v: 1 };
const ready = { ...base, type: "ready", protocolVersion: 1, nonce: "nonce_12345678" };
const size = (extra: Record<string, unknown> = {}) => ({
  ...base,
  type: "size",
  height: 320,
  ...identity,
  ...extra,
});
const link = (extra: Record<string, unknown> = {}) => ({
  ...base,
  type: "link-request",
  url: "https://example.com/docs",
  label: "Docs",
  ...identity,
  ...extra,
});
const theme = (extra: Record<string, unknown> = {}) => ({
  ...base,
  type: "theme",
  ...identity,
  appearance: "dark",
  reducedMotion: true,
  viewport: { width: 800, height: 600 },
  tokens: { "--accent": "#123456" },
  ...extra,
});

describe("browser viewer shell relay", () => {
  test("creates the sandboxed artifact frame only when framed, configured before it loads", () => {
    const top = runShell({ topLevel: true });
    expect(top.steps).toEqual([]);

    const shell = runShell();
    expect(shell.steps[0]).toBe("create:iframe");
    expect(shell.steps.at(-1)).toBe("append");
    expect(shell.steps.at(-2)).toBe("attr:src");
    expect(shell.attributes).toEqual({
      id: "artifact",
      title: "Interactive artifact",
      sandbox: "allow-scripts",
      referrerpolicy: "no-referrer",
      allow: "",
      src: DOCUMENT_URL,
    });
  });

  test("relays frame messages only from the exact opaque-origin frame, to the exact parent origin", () => {
    const shell = runShell();
    shell.fromFrame(size()); // before ready: no identity yet
    shell.fromFrame(ready, { source: {} });
    shell.fromFrame(ready, { source: shell.parentWindow });
    shell.fromFrame(ready, { origin: "http://localhost:47123" });
    shell.fromFrame(ready, { ports: [{}] });
    shell.fromFrame(ready);
    shell.fromFrame(ready); // a second ready is never relayed
    shell.fromFrame(size());
    expect(shell.toParent()).toEqual([ready, size()]);
    expect(shell.parentWindow.postMessage.mock.calls.map((call) => call[1])).toEqual([APP, APP]);
  });

  test("forwards exactly what parseArtifactFrameMessage accepts with the shell's identity", () => {
    const cyclic: Record<string, unknown> = size();
    cyclic.self = cyclic;
    const corpus: unknown[] = [
      size(),
      size({ width: 640 }),
      size({ height: 0 }),
      size({ height: 100_000 }),
      size({ height: 100_001 }),
      size({ height: -1 }),
      size({ height: Number.NaN }),
      size({ height: "300" }),
      size({ width: "wide" }),
      size({ generation: "forged" }),
      size({ artifactId: "art_other0001" }),
      size({ revision: 3 }),
      size({ extra: true }),
      size({ v: 2 }),
      size({ channel: "other" }),
      link(),
      link({ url: "http://example.com/" }),
      link({ url: "javascript:alert(1)" }),
      link({ url: "https://user:pw@example.com/" }),
      link({ url: "file:///etc/passwd" }),
      link({ url: `https://exa${String.fromCharCode(0x202e)}mple.com` }),
      link({ url: `https://example.com/${"x".repeat(FRAME_CHANNEL_POLICY.maxLinkCharacters)}` }),
      link({ url: "" }),
      link({ label: "y".repeat(FRAME_CHANNEL_POLICY.maxLinkLabelCharacters + 1) }),
      link({ label: 7 }),
      link({ padding: "x".repeat(20_000) }),
      { ...base, type: "theme", ...identity },
      { ...base, type: "tool-call", tool: "bash", ...identity },
      { ...base, type: "prompt", text: "send this", ...identity },
      { ...base, type: "shell-disposed", reason: "unexpected-load" },
      cyclic,
      "plain string",
      null,
      [size()],
    ];
    corpus.forEach((data, index) => {
      const shell = runShell();
      shell.fromFrame(ready);
      shell.fromFrame(data);
      const relayed = shell.toParent().slice(1);
      const verdict = parseArtifactFrameMessage(data, identity);
      // The index names the corpus entry in a failure.
      expect({ index, relayed: relayed.length }).toEqual({ index, relayed: verdict.ok ? 1 : 0 });
      if (verdict.ok) expect(relayed[0]).toEqual(data);
    });
    // Ready variants the parser refuses are refused too.
    for (const data of [
      { ...ready, nonce: "short" },
      { ...ready, nonce: "has space 123" },
      { ...ready, protocolVersion: 2 },
      { ...ready, extra: 1 },
    ]) {
      const shell = runShell();
      shell.fromFrame(data);
      expect(parseArtifactFrameMessage(data, null).ok).toBe(false);
      expect(shell.toParent()).toEqual([]);
    }
  });

  test("relays the host's theme only from the permitted parent, after ready, rebuilt", () => {
    const shell = runShell();
    shell.fromParent(theme()); // before ready
    shell.fromFrame(ready);
    shell.fromParent(theme(), { origin: "http://evil.example" });
    shell.fromParent(theme(), { source: {} });
    shell.fromParent(theme(), { source: shell.artifactWindow, origin: "null" });
    shell.fromParent(theme(), { ports: [{}] });
    shell.fromParent(theme({ generation: "old" }));
    shell.fromParent(theme({ appearance: "neon" }));
    shell.fromParent(theme({ extra: 1 }));
    shell.fromParent(theme({ viewport: { width: 1, height: 1, depth: 1 } }));
    shell.fromParent(theme({ tokens: { color: "red" } }));
    shell.fromParent(theme({ tokens: { "--x": "y".repeat(200) } }));
    shell.fromParent(theme({ reducedMotion: "yes" }));
    shell.fromParent(theme());
    expect(shell.toFrame()).toEqual([theme()]);
    expect(shell.artifactWindow.postMessage.mock.calls[0]![1]).toBe("*");
  });

  test("a loopback port wildcard ancestor accepts any port and addresses the parent with '*'", () => {
    const shell = runShell({ parentOrigins: ["http://127.0.0.1:*"] });
    shell.fromFrame(ready);
    shell.fromParent(theme(), { origin: "http://127.0.0.1:5173" });
    shell.fromParent(theme(), { origin: "http://127.0.0.10:5173" });
    expect(shell.toFrame()).toHaveLength(1);
    expect(shell.parentWindow.postMessage.mock.calls[0]![1]).toBe("*");
  });

  test("any load after the first disposes the frame and tells the parent once", () => {
    const shell = runShell();
    shell.load();
    shell.fromFrame(ready);
    expect(shell.removed()).toBe(false);
    shell.load();
    expect(shell.removed()).toBe(true);
    shell.load();
    shell.fromFrame(size());
    const sent = shell.toParent();
    expect(sent).toHaveLength(2);
    expect(parseArtifactShellMessage(sent[1]).ok).toBe(true);
    expect(sent[1]).toEqual({ ...base, type: "shell-disposed", reason: "unexpected-load" });
  });

  test("a navigation blocked by the shell's frame-src disposes; other violations do not", () => {
    const shell = runShell();
    shell.load();
    shell.violation("style-src-elem");
    expect(shell.removed()).toBe(false);
    shell.violation("frame-src");
    expect(shell.removed()).toBe(true);
    expect(shell.toParent()).toEqual([
      { ...base, type: "shell-disposed", reason: "blocked-navigation" },
    ]);
  });

  test("frame messages are rate limited", () => {
    const shell = runShell();
    shell.fromFrame(ready);
    for (let index = 0; index < 100; index += 1) shell.fromFrame(size({ height: index }));
    expect(shell.toParent().length).toBeLessThanOrEqual(FRAME_CHANNEL_POLICY.burst);
  });

  test("the document carries one hashed script and no markup from its inputs", () => {
    const response = artifactShellResponse({
      documentUrl: DOCUMENT_URL,
      frameAncestors: [APP],
      identity: { ...identity, artifactId: "art_</script><b>" },
    });
    const scripts = Array.from(response.html.matchAll(/<script>([\s\S]*?)<\/script>/g));
    expect(scripts).toHaveLength(1);
    expect(response.contentSecurityPolicy).toContain(
      `script-src ${inlineScriptHash(scripts[0]![1]!)}`,
    );
    expect(response.html).not.toContain("<b>");
    expect(() =>
      artifactShellResponse({
        documentUrl: "http://localhost:1/a/x; frame-src *",
        frameAncestors: [APP],
        identity,
      }),
    ).toThrow();
    expect(() =>
      artifactShellResponse({ documentUrl: "data:text/html,x", frameAncestors: [], identity }),
    ).toThrow();
    // No literal control or bidirectional-format characters in the generated script.
    expect(
      new RegExp(
        "[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]",
      ).test(scripts[0]![1]!),
    ).toBe(false);
  });
});
