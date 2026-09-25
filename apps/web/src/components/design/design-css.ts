/**
 * Local CSS checks for immediate inspector feedback. The design runtime and
 * backend stay authoritative: they validate the whole style set atomically.
 */

export const MAX_STYLE_PROPERTIES = 64;
export const MAX_STYLE_VALUE_LENGTH = 2048;
export const MAX_PROPERTY_NAME_LENGTH = 100;

const PROPERTY_NAME = /^(--[a-zA-Z0-9_-]+|[a-z-]+)$/;
const IMPORTANT = /^(.*?)\s*!\s*important\s*$/i;

/** Shorthands expand into several longhands; the note keeps that visible. */
const SHORTHANDS = new Set([
  "margin",
  "padding",
  "gap",
  "border",
  "border-width",
  "border-style",
  "border-color",
  "border-radius",
  "background",
  "font",
  "flex",
  "inset",
  "outline",
  "transition",
  "animation",
  "grid",
  "grid-template",
  "place-items",
  "place-content",
]);

export type CssCheck =
  | { ok: true; remove: true }
  | { ok: true; remove?: false; value: string; important: boolean; note?: string }
  | { ok: false; error: string };

export function isCustomProperty(name: string): boolean {
  return name.startsWith("--");
}

export function splitImportant(raw: string): { value: string; important: boolean } {
  const match = IMPORTANT.exec(raw.trim());
  return match
    ? { value: match[1]!.trim(), important: true }
    : { value: raw.trim(), important: false };
}

/** Inline declaration text as the user would type it back. */
export function formatInline(value: string | undefined, priority?: "important"): string {
  if (!value) return "";
  return priority === "important" ? `${value} !important` : value;
}

/** `undefined` when the environment cannot tell (no CSS.supports or it throws). */
export function cssSupports(property: string, value: string): boolean | undefined {
  try {
    const css = (
      globalThis as { CSS?: { supports?: (property: string, value: string) => boolean } }
    ).CSS;
    if (typeof css?.supports !== "function") return undefined;
    return css.supports(property, value);
  } catch {
    return undefined;
  }
}

export function checkPropertyName(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a property name";
  if (trimmed.length > MAX_PROPERTY_NAME_LENGTH) return "Property name is too long";
  if (!PROPERTY_NAME.test(trimmed))
    return "Use a lowercase CSS property or a custom property such as --brand-color";
  if (!isCustomProperty(trimmed) && cssSupports(trimmed, "inherit") === false)
    return "This browser does not support that property";
  return undefined;
}

/** Validates one declaration. Empty values mean "remove the inline declaration". */
export function checkDeclaration(property: string, raw: string | null): CssCheck {
  const nameError = checkPropertyName(property);
  if (nameError) return { ok: false, error: nameError };
  if (raw === null || raw.trim() === "") return { ok: true, remove: true };
  if (raw.length > MAX_STYLE_VALUE_LENGTH)
    return { ok: false, error: `Values are limited to ${MAX_STYLE_VALUE_LENGTH} characters` };
  const { value, important } = splitImportant(raw);
  if (!value) return { ok: false, error: "Enter a value before !important" };
  if (/[;{}]/.test(value) && !isCustomProperty(property))
    return { ok: false, error: "Enter a single value without ; or braces" };
  if (isCustomProperty(property)) {
    if (cssSupports(property, value) === false)
      return { ok: false, error: "Not a valid custom property value" };
    return {
      ok: true,
      value,
      important,
      note: "Custom property accepted as a token; it has an effect only where var() uses it",
    };
  }
  if (cssSupports(property, value) === false)
    return { ok: false, error: `Not a valid value for ${property}` };
  return {
    ok: true,
    value,
    important,
    ...(SHORTHANDS.has(property) ? { note: "Shorthand: sets every related longhand" } : {}),
  };
}

/** Errors per property for a whole proposed set; empty when all pass locally. */
export function checkStyleSet(styles: Record<string, string | null>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [property, value] of Object.entries(styles)) {
    const result = checkDeclaration(property, value);
    if (!result.ok) errors[property] = result.error;
  }
  return errors;
}
