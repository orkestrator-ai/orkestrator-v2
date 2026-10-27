/**
 * Small path-tracking validation helpers for strict runtime schemas.
 *
 * TypeScript types are not input validation. The rich-content schemas need
 * stable field paths (`series[1].points[2].value`) in their diagnostics and a
 * strict "unknown field" rejection, and nothing in this package depends on a
 * schema library, so these helpers keep that behaviour in one place.
 */

export interface FieldError {
  path: string;
  code: string;
  message: string;
}

export type FieldValidation<T> =
  { ok: true; value: T } | { ok: false; errors: FieldError[]; omittedErrors: number };

export const DEFAULT_MAX_FIELD_ERRORS = 20;

export class FieldErrorCollector {
  readonly errors: FieldError[] = [];
  omitted = 0;

  constructor(private readonly maxErrors = DEFAULT_MAX_FIELD_ERRORS) {}

  add(path: string, code: string, message: string): void {
    if (this.errors.length >= this.maxErrors) {
      this.omitted++;
      return;
    }
    this.errors.push({ path: path || "$", code, message: message.slice(0, 300) });
  }

  get failed(): boolean {
    return this.errors.length > 0 || this.omitted > 0;
  }

  result<T>(value: T): FieldValidation<T> {
    return this.failed
      ? { ok: false, errors: this.errors, omittedErrors: this.omitted }
      : { ok: true, value };
  }
}

export function joinPath(base: string, key: string | number): string {
  if (typeof key === "number") return `${base}[${key}]`;
  return base ? `${base}.${key}` : key;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Reject keys outside `allowed`; returns false when the value is not an object. */
export function checkObject(
  value: unknown,
  path: string,
  allowed: readonly string[],
  errors: FieldErrorCollector,
): value is Record<string, unknown> {
  if (!isPlainRecord(value)) {
    errors.add(path, "type", "Expected an object");
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      errors.add(joinPath(path, key), "unknown_field", "Unknown field is not permitted");
    }
  }
  return true;
}

export function checkString(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  options: { min?: number; max: number; pattern?: RegExp; optional?: boolean },
): value is string {
  if (value === undefined && options.optional) return true;
  if (typeof value !== "string") {
    errors.add(path, "type", "Expected a string");
    return false;
  }
  const min = options.min ?? 0;
  if (value.length < min) {
    errors.add(path, min === 1 ? "empty" : "too_short", `Must contain at least ${min} characters`);
    return false;
  }
  if (value.length > options.max) {
    errors.add(path, "too_long", `Must contain at most ${options.max} characters`);
    return false;
  }
  if (options.pattern && !options.pattern.test(value)) {
    errors.add(path, "pattern", "Contains unsupported characters");
    return false;
  }
  return true;
}

export function checkFiniteNumber(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  options: { maxAbs?: number; min?: number; max?: number; integer?: boolean } = {},
): value is number {
  if (typeof value !== "number") {
    errors.add(path, "type", "Expected a number");
    return false;
  }
  if (!Number.isFinite(value)) {
    errors.add(path, "not_finite", "Must be a finite number");
    return false;
  }
  if (options.integer && !Number.isSafeInteger(value)) {
    errors.add(path, "not_integer", "Must be a safe integer");
    return false;
  }
  if (options.maxAbs !== undefined && Math.abs(value) > options.maxAbs) {
    errors.add(path, "out_of_range", `Absolute value must not exceed ${options.maxAbs}`);
    return false;
  }
  if (options.min !== undefined && value < options.min) {
    errors.add(path, "out_of_range", `Must be at least ${options.min}`);
    return false;
  }
  if (options.max !== undefined && value > options.max) {
    errors.add(path, "out_of_range", `Must be at most ${options.max}`);
    return false;
  }
  return true;
}

export function checkArray(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  options: { min?: number; max: number },
): value is unknown[] {
  if (!Array.isArray(value)) {
    errors.add(path, "type", "Expected an array");
    return false;
  }
  if (value.length < (options.min ?? 0)) {
    errors.add(path, "too_few", `Must contain at least ${options.min} entries`);
    return false;
  }
  if (value.length > options.max) {
    errors.add(path, "too_many", `Must contain at most ${options.max} entries`);
    return false;
  }
  return true;
}

export function checkEnum<T extends string>(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  allowed: readonly T[],
): value is T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    errors.add(path, "enum", `Expected one of: ${allowed.join(", ")}`);
    return false;
  }
  return true;
}

/** Measure nesting without recursion so a hostile document cannot overflow the stack. */
export function jsonDepthExceeds(value: unknown, maxDepth: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length > 0) {
    const [current, depth] = stack.pop()!;
    if (typeof current !== "object" || current === null) continue;
    if (depth > maxDepth) return true;
    const children = Array.isArray(current) ? current : Object.values(current);
    for (const child of children) stack.push([child, depth + 1]);
  }
  return false;
}
