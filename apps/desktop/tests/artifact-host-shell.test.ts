import { describe, expect, mock, test } from "bun:test";
import {
  ARTIFACT_SHELL_GLOBAL,
  ARTIFACT_SHELL_SCRIPT_SOURCE,
  ARTIFACT_SHELL_URL,
  artifactContentOrigin,
  artifactShellContentSecurityPolicy,
  artifactShellDocument,
  artifactShellHeaders,
  artifactShellThemeExpression,
} from "../electron/artifact-host-shell";
import { createHash } from "node:crypto";

const CONTENT_URL = "http://127.0.0.1:47123/artifact-content/cap_abc/document";

type MessageListener = (event: {
  source: unknown;
  origin: string;
  data: unknown;
  ports?: unknown[];
}) => void;

/** Run the real shell script against a minimal window with one artifact frame. */
function runShell() {
  const artifactWindow = { postMessage: mock((_message: unknown, _target: string) => undefined) };
  const frame = { contentWindow: artifactWindow };
  let listener: MessageListener | null = null;
  const fakeWindow: Record<string, unknown> = {
    addEventListener: (type: string, callback: MessageListener) => {
      if (type === "message") listener = callback;
    },
  };
  const fakeDocument = { getElementById: (id: string) => (id === "artifact" ? frame : null) };
  new Function("window", "document", ARTIFACT_SHELL_SCRIPT_SOURCE)(fakeWindow, fakeDocument);
  const api = fakeWindow[ARTIFACT_SHELL_GLOBAL] as {
    drain(): Promise<{ messages: unknown[]; dropped: number }>;
    theme(message: unknown): boolean;
  };
  return {
    api,
    artifactWindow,
    send(data: unknown, overrides: Partial<Parameters<MessageListener>[0]> = {}) {
      listener!({ source: artifactWindow, origin: "null", data, ...overrides });
    },
  };
}

const ready = {
  channel: "orkestrator-artifact",
  v: 1,
  type: "ready",
  protocolVersion: 1,
  nonce: "nonce_12345678",
};

describe("artifact shell relay script", () => {
  test("relays presentation messages only from the captured opaque-origin frame", async () => {
    const shell = runShell();
    shell.send(ready, { source: {} });
    shell.send(ready, { origin: "http://127.0.0.1:47123" });
    shell.send({ ...ready, type: "invoke-tool" });
    shell.send({ ...ready, channel: "other" });
    shell.send("text");
    shell.send(ready, { ports: [{}] });
    shell.send(ready);
    await expect(shell.api.drain()).resolves.toEqual({ messages: [ready], dropped: 5 });
  });

  test("drops oversized and cyclic data and bounds the queue and rate", async () => {
    const shell = runShell();
    shell.send({ ...ready, nonce: "x".repeat(9_000) });
    const cyclic: Record<string, unknown> = { ...ready };
    cyclic.self = cyclic;
    shell.send(cyclic);
    for (let index = 0; index < 100; index += 1) shell.send(ready);
    const batch = await shell.api.drain();
    expect(batch.messages.length).toBeLessThanOrEqual(40);
    expect(batch.dropped).toBe(2 + (100 - batch.messages.length));
  });

  test("a pending drain resolves with the next message", async () => {
    const shell = runShell();
    const pending = shell.api.drain();
    shell.send(ready);
    await expect(pending).resolves.toEqual({ messages: [ready], dropped: 0 });
  });

  test("posts only theme messages to the frame, with a wildcard target to its opaque origin", () => {
    const shell = runShell();
    expect(shell.api.theme({ channel: "orkestrator-artifact", v: 1, type: "size" })).toBe(false);
    const message = { channel: "orkestrator-artifact", v: 1, type: "theme", appearance: "dark" };
    expect(shell.api.theme(message)).toBe(true);
    expect(shell.artifactWindow.postMessage).toHaveBeenCalledTimes(1);
    expect(shell.artifactWindow.postMessage).toHaveBeenCalledWith(message, "*");
  });

  test("the shell global cannot be replaced", () => {
    const shell = runShell();
    expect(Object.isFrozen(shell.api)).toBe(true);
  });
});

describe("artifact shell document", () => {
  test("authorizes exactly its own inline script and style by hash", () => {
    const html = artifactShellDocument(CONTENT_URL);
    const script = html.match(/<script>([\s\S]*)<\/script>/)![1]!;
    const style = html.match(/<style>([\s\S]*)<\/style>/)![1]!;
    const hash = (value: string) =>
      `'sha256-${createHash("sha256").update(value).digest("base64")}'`;
    const policy = artifactShellHeaders(CONTENT_URL)["Content-Security-Policy"];
    expect(policy).toContain(`script-src ${hash(script)}`);
    expect(policy).toContain(`style-src ${hash(style)}`);
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).toContain("frame-src http://127.0.0.1:47123;");
  });

  test("escapes the content URL in the iframe attribute", () => {
    const url = 'http://127.0.0.1:47123/doc?a="><script>alert(1)</script>';
    const html = artifactShellDocument(url);
    expect(html).not.toContain('"><script>alert(1)');
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });

  test("the meta policy omits frame-ancestors, the header policy forbids framing", () => {
    expect(artifactShellContentSecurityPolicy("http://a.example", { header: false })).not.toContain(
      "frame-ancestors",
    );
    expect(artifactShellContentSecurityPolicy("http://a.example", { header: true })).toContain(
      "frame-ancestors 'none'",
    );
  });

  test("refuses non-HTTP content origins", () => {
    expect(() => artifactContentOrigin("file:///tmp/a.html")).toThrow();
    expect(() => artifactContentOrigin("data:text/html,x")).toThrow();
    expect(artifactContentOrigin("https://content.example:8443/x?y")).toBe(
      "https://content.example:8443",
    );
  });

  test("theme expressions are single JSON literals", () => {
    const theme = { tokens: { "--x": '</script> "); alert(1); ("' } };
    const expression = artifactShellThemeExpression(theme);
    expect(expression.startsWith(`globalThis.${ARTIFACT_SHELL_GLOBAL}.theme({`)).toBe(true);
    const received: unknown[] = [];
    const fakeGlobal = {
      [ARTIFACT_SHELL_GLOBAL]: { theme: (value: unknown) => received.push(value) },
    };
    new Function("globalThis", `return ${expression}`)(fakeGlobal);
    expect(received).toEqual([theme]);
    expect(ARTIFACT_SHELL_URL).toBe("orkestrator-artifact-shell://viewer/shell.html");
  });
});
