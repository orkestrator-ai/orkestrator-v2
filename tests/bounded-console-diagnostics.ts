import { StringDecoder } from "node:string_decoder";

export const TEST_DIAGNOSTIC_STRING_BYTES = 8_192;
export const TEST_DIAGNOSTIC_ERROR_BYTES = 16_384;

const CONSOLE_INSTALL_MARK = Symbol.for("orkestrator.test.bounded-console-diagnostics");
const MAX_COLLECTION_ITEMS = 12;
const MAX_OBJECT_KEYS = 20;

export function truncateUtf8(value: string, limit: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= limit) return value;

  const marker = `\n… [truncated at ${limit} bytes]`;
  const markerBytes = Buffer.byteLength(marker);
  if (markerBytes >= limit) return Buffer.from(marker).subarray(0, limit).toString("utf8");

  // StringDecoder retains an incomplete trailing code point rather than
  // emitting U+FFFD, so the diagnostic stays valid UTF-8 at the byte boundary.
  const decoder = new StringDecoder("utf8");
  const prefix = decoder.write(encoded.subarray(0, limit - markerBytes));
  return `${prefix}${marker}`;
}

function isDomNode(value: object): value is {
  nodeType: number;
  nodeName: string;
  textContent?: string | null;
  getAttribute?: (name: string) => string | null;
} {
  const candidate = value as { nodeType?: unknown; nodeName?: unknown };
  return typeof candidate.nodeType === "number" && typeof candidate.nodeName === "string";
}

function summarizeDomNode(
  value: object & {
    nodeType: number;
    nodeName: string;
    textContent?: string | null;
    getAttribute?: (name: string) => string | null;
  },
): string {
  const name = value.nodeName.toLowerCase();
  const attributes: string[] = [];
  for (const attribute of ["role", "aria-label", "data-testid", "id"]) {
    try {
      const attributeValue = value.getAttribute?.(attribute);
      if (attributeValue)
        attributes.push(`${attribute}=${JSON.stringify(truncateUtf8(attributeValue, 256))}`);
    } catch {
      // A diagnostic must never invoke a hostile DOM accessor twice.
    }
  }
  let text = "";
  try {
    text = truncateUtf8(value.textContent?.trim() ?? "", 512);
  } catch {
    text = "<unavailable>";
  }
  return `<${name}${attributes.length ? ` ${attributes.join(" ")}` : ""}>${text ? ` ${JSON.stringify(text)}` : ""}`;
}

export function summarizeValue(
  value: unknown,
  depth = 0,
  ancestors = new WeakSet<object>(),
): string {
  if (typeof value === "string") return truncateUtf8(value, TEST_DIAGNOSTIC_STRING_BYTES);
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  )
    return String(value);
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (value instanceof Error) {
    return truncateUtf8(
      value.stack || `${value.name}: ${value.message}`,
      TEST_DIAGNOSTIC_ERROR_BYTES,
    );
  }
  if (isDomNode(value)) return summarizeDomNode(value);
  if (ancestors.has(value)) return "[Circular]";
  if (depth >= 2) return `[${value.constructor?.name || "Object"}]`;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value
        .slice(0, MAX_COLLECTION_ITEMS)
        .map((entry) => summarizeValue(entry, depth + 1, ancestors));
      if (value.length > items.length) items.push(`… ${value.length - items.length} more`);
      return `[${items.join(", ")}]`;
    }
    if (value instanceof Map || value instanceof Set) {
      return `[${value.constructor.name}(size=${value.size})]`;
    }

    const name = value.constructor?.name || "Object";
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const entries: string[] = [];
    for (const key of keys.slice(0, MAX_OBJECT_KEYS)) {
      const descriptor = descriptors[key];
      if (!descriptor) continue;
      const renderedKey = typeof key === "symbol" ? key.toString() : key;
      entries.push(
        "value" in descriptor
          ? `${renderedKey}: ${summarizeValue(descriptor.value, depth + 1, ancestors)}`
          : `${renderedKey}: [Accessor]`,
      );
    }
    if (keys.length > entries.length) entries.push(`… ${keys.length - entries.length} more keys`);
    return `${name} { ${entries.join(", ")} }`;
  } finally {
    ancestors.delete(value);
  }
}

export function installBoundedConsoleDiagnostics(): void {
  const globalWithMark = globalThis as typeof globalThis & Record<symbol, boolean | undefined>;
  if (globalWithMark[CONSOLE_INSTALL_MARK]) return;
  globalWithMark[CONSOLE_INSTALL_MARK] = true;

  if (process.env.ORKESTRATOR_TEST_RAW_CONSOLE === "1") return;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[level].bind(console);
    console[level] = ((...args: unknown[]) => {
      if (
        (level === "log" || level === "info" || level === "debug") &&
        process.env.ORKESTRATOR_TEST_VERBOSE_CONSOLE !== "1"
      )
        return;
      original(...args.map((argument) => summarizeValue(argument)));
    }) as (typeof console)[typeof level];
  }
}
