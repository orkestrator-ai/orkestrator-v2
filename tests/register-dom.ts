// This must be a separate, earlier preload. Static imports in tests/setup.ts
// evaluate before that module's body, and Testing Library binds `screen` when
// it evaluates. Registering the document in the preceding preload keeps setup
// synchronous, which Bun requires for reliable mock.module registration.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

export const NATIVE_WEB_PLATFORM_KEY = Symbol.for("orkestrator.tests.native-web-platform");

export const nativeWebPlatform = {
  fetch: globalThis.fetch,
  AbortController: globalThis.AbortController,
  AbortSignal: globalThis.AbortSignal,
  Response: globalThis.Response,
};

GlobalRegistrator.register();

// Happy DOM installs its own fetch, abort and Response classes. Bun 1.4 rejects
// a Happy DOM AbortSignal passed to Bun's native fetch, and `Bun.serve` rejects
// a Happy DOM Response returned from a handler, both because they belong to a
// different Web API implementation. Integration tests that drive a loopback
// server therefore need the matching native constructors captured before
// registration.
Object.defineProperty(globalThis, NATIVE_WEB_PLATFORM_KEY, {
  value: nativeWebPlatform,
  configurable: true,
});

// Bun's `expect` prints a failing value by walking its whole object graph, and
// a Happy DOM node reaches the document, the window, and every other node from
// there. One failing `expect(document.activeElement).toBe(input)` built a
// ~400 MB message and blocked the event loop for ~30 s; inside a `waitFor`,
// that single failed poll outlasted every timeout (flake 0161). Nodes print as
// a short, bounded description instead. Bun's formatter and `console.log` both
// honour this hook; Testing Library's own `prettyDOM` output is unaffected.
const INSPECT_CUSTOM = Symbol.for("nodejs.util.inspect.custom");
const MAX_INSPECTED_TEXT = 60;

function describeNodeForInspection(node: Node): string {
  const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
  const snippet = text.length > MAX_INSPECTED_TEXT ? `${text.slice(0, MAX_INSPECTED_TEXT)}…` : text;
  if (node.nodeType === 1) {
    const element = node as Element;
    const attributes = ["id", "role", "aria-label", "name", "type", "data-testid"]
      .map((name) => [name, element.getAttribute(name)] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== null)
      .map(([name, value]) => ` ${name}=${JSON.stringify(value.slice(0, MAX_INSPECTED_TEXT))}`)
      .join("");
    const connected = element.isConnected ? "" : " (detached)";
    return `<${element.tagName.toLowerCase()}${attributes}>${snippet ? ` ${JSON.stringify(snippet)}` : ""}${connected}`;
  }
  if (node.nodeType === 9) return "#document";
  return `${node.nodeName}${snippet ? ` ${JSON.stringify(snippet)}` : ""}`;
}

Object.defineProperty(globalThis.Node.prototype, INSPECT_CUSTOM, {
  configurable: true,
  writable: true,
  value(this: Node) {
    return describeNodeForInspection(this);
  },
});
