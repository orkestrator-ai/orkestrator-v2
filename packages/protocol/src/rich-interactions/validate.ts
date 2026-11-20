/**
 * A small path-aware reader for the rich interaction contracts.
 *
 * Every rich interaction payload crosses a trust boundary (an agent tool
 * argument, a renderer submission), so it is read field by field: unknown keys
 * are refused, strings and arrays are bounded, and the first failure carries
 * the JSON path that caused it so an agent can repair its call. Nothing here
 * coerces: `0`, `false`, `""`, `null` and an absent key stay distinct.
 *
 * Browser-safe.
 */

export class RichInteractionValidationError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly code: "invalid" | "capacity" = "invalid",
  ) {
    super(`${path}: ${message}`);
    this.name = "RichInteractionValidationError";
  }
}

export type Validated<T> =
  { ok: true; value: T } | { ok: false; error: string; path: string; code: "invalid" | "capacity" };

export function validated<T>(read: () => T): Validated<T> {
  try {
    return { ok: true, value: read() };
  } catch (error) {
    if (error instanceof RichInteractionValidationError) {
      return { ok: false, error: error.message, path: error.path, code: error.code };
    }
    throw error;
  }
}

export function fail(path: string, message: string): never {
  throw new RichInteractionValidationError(message, path);
}

export function capacity(path: string, message: string): never {
  throw new RichInteractionValidationError(message, path, "capacity");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** An object whose keys are all in `allowed`. */
export function obj(
  value: unknown,
  path: string,
  allowed: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) fail(path, "must be an object");
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${path}.${key}`, "is not a supported field");
  }
  return value;
}

/** Printable, no control characters, no surrounding whitespace (chart and table ids may contain spaces). */
const ID_PATTERN = /^(?![\s])[^\u0000-\u001f\u007f]*(?<![\s])$/u;

/** A stable, bounded opaque identifier. */
export function id(value: unknown, path: string, max = 200): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    fail(path, `must be an id of 1-${max} characters`);
  }
  if (!ID_PATTERN.test(value))
    fail(path, "must be printable text without control characters or surrounding whitespace");
  return value;
}

export function optId(value: unknown, path: string, max = 200): string | undefined {
  return value === undefined ? undefined : id(value, path, max);
}

export function str(value: unknown, path: string, max: number, min = 0): string {
  if (typeof value !== "string") fail(path, "must be a string");
  if (value.length > max) capacity(path, `must be at most ${max} characters`);
  if (value.trim().length < min)
    fail(path, min === 1 ? "must not be empty" : `must be at least ${min} characters`);
  return value;
}

export function optStr(value: unknown, path: string, max: number): string | undefined {
  return value === undefined ? undefined : str(value, path, max);
}

export function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

export function optBool(value: unknown, path: string): boolean | undefined {
  return value === undefined ? undefined : bool(value, path);
}

export function num(
  value: unknown,
  path: string,
  options: { min?: number; max?: number; integer?: boolean } = {},
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "must be a finite number");
  if (options.integer && !Number.isSafeInteger(value)) fail(path, "must be an integer");
  if (options.min !== undefined && value < options.min)
    fail(path, `must be at least ${options.min}`);
  if (options.max !== undefined && value > options.max)
    fail(path, `must be at most ${options.max}`);
  return value;
}

export function optNum(
  value: unknown,
  path: string,
  options: { min?: number; max?: number; integer?: boolean } = {},
): number | undefined {
  return value === undefined ? undefined : num(value, path, options);
}

export function revision(value: unknown, path: string): number {
  return num(value, path, { min: 0, max: Number.MAX_SAFE_INTEGER - 1, integer: true });
}

export function oneOf<T extends string>(value: unknown, path: string, options: readonly T[]): T {
  if (typeof value !== "string" || !(options as readonly string[]).includes(value)) {
    fail(path, `must be one of ${options.join(", ")}`);
  }
  return value as T;
}

export function optOneOf<T extends string>(
  value: unknown,
  path: string,
  options: readonly T[],
): T | undefined {
  return value === undefined ? undefined : oneOf(value, path, options);
}

export function arr<T>(
  value: unknown,
  path: string,
  max: number,
  read: (item: unknown, path: string, index: number) => T,
  min = 0,
): T[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  if (value.length > max) capacity(path, `must have at most ${max} entries`);
  if (value.length < min) fail(path, `must have at least ${min} entries`);
  return value.map((item, index) => read(item, `${path}[${index}]`, index));
}

export function optArr<T>(
  value: unknown,
  path: string,
  max: number,
  read: (item: unknown, path: string, index: number) => T,
): T[] | undefined {
  return value === undefined ? undefined : arr(value, path, max, read);
}

/** Refuses duplicate ids in a list of records. */
export function uniqueIds<T>(items: readonly T[], path: string, key: (item: T) => string): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const value = key(item);
    if (seen.has(value)) fail(`${path}[${index}]`, `duplicates id ${JSON.stringify(value)}`);
    seen.add(value);
  });
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Plain-data JSON value (no functions, no non-finite numbers), bounded in depth. */
export function jsonValue(value: unknown, path: string, depth = 0): unknown {
  if (depth > 8) fail(path, "is nested too deeply");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "must be a finite number");
    return value;
  }
  if (Array.isArray(value))
    return value.map((item, index) => jsonValue(item, `${path}[${index}]`, depth + 1));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value))
      out[key] = jsonValue(item, `${path}.${key}`, depth + 1);
    return out;
  }
  fail(path, "must be plain JSON");
}
