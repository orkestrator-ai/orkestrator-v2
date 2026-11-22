export const CONTRACT_MANIFEST_SCHEMA_VERSION = 1;
const PRINT_WIDTH = 100;
type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/**
 * JSON with two-space indentation in the shape `bun fmt` keeps: objects
 * expanded (an empty one as `{}`), and an array of scalars on one line when
 * it fits the print width, one element per line otherwise.
 */
export function serializeContractManifest(manifest: unknown): string {
  return `${formatJson(manifest as Json, "", "", 0)}\n`;
}

/**
 * `prefix` is what precedes the value on its line (`"key": `), and `suffix`
 * the length of what follows it (1 for a separating comma), so an inline array
 * is measured on the whole line.
 */
function formatJson(value: Json, indent: string, prefix: string, suffix: number): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const scalars = value.every((item) => item === null || typeof item !== "object");
    if (scalars) {
      const inline = `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
      if (indent.length + prefix.length + inline.length + suffix <= PRINT_WIDTH) return inline;
    }
    const items = value.map(
      (item, index) => `${inner}${formatJson(item, inner, "", index < value.length - 1 ? 1 : 0)}`,
    );
    return `[\n${items.join(",\n")}\n${indent}]`;
  }
  const record = value as { readonly [key: string]: Json };
  const keys = Object.keys(record);
  if (keys.length === 0) return "{}";
  const lines = keys.map((key, index) => {
    const keyText = `${JSON.stringify(key)}: `;
    const comma = index < keys.length - 1 ? 1 : 0;
    return `${inner}${keyText}${formatJson(record[key] as Json, inner, keyText, comma)}`;
  });
  return `{\n${lines.join(",\n")}\n${indent}}`;
}
