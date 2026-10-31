/** The scalar subset the shared interaction card can collect faithfully.
 * Arrays, nested objects and combinators must be declined visibly rather than
 * presented as a string input. Unknown constraints fail closed too. */
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const ROOT_KEYS = new Set([
  "type",
  "properties",
  "required",
  "title",
  "description",
  "$schema",
  "additionalProperties",
]);
const FIELD_KEYS = new Set([
  "type",
  "title",
  "description",
  "default",
  "enum",
  "writeOnly",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
]);

export function isSupportedMcpForm(schema: unknown): schema is Record<string, unknown> {
  if (
    !record(schema) ||
    schema.type !== "object" ||
    Object.keys(schema).some((key) => !ROOT_KEYS.has(key))
  )
    return false;
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false)
    return false;
  const properties = schema.properties ?? {};
  if (!record(properties)) return false;
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) ||
      !schema.required.every((key) => typeof key === "string" && Object.hasOwn(properties, key)))
  )
    return false;
  return Object.values(properties).every((field) => {
    if (!record(field) || Object.keys(field).some((key) => !FIELD_KEYS.has(key))) return false;
    if (!["string", "number", "integer", "boolean"].includes(String(field.type))) return false;
    if (
      field.enum !== undefined &&
      (field.type !== "string" ||
        !Array.isArray(field.enum) ||
        field.enum.length === 0 ||
        !field.enum.every((item) => typeof item === "string"))
    )
      return false;
    for (const key of ["minLength", "maxLength", "minimum", "maximum"] as const) {
      if (field[key] === undefined) continue;
      if (typeof field[key] !== "number" || !Number.isFinite(field[key])) return false;
      if (
        key.endsWith("Length") &&
        (field.type !== "string" || !Number.isSafeInteger(field[key]) || field[key] < 0)
      )
        return false;
      if (!key.endsWith("Length") && field.type !== "number" && field.type !== "integer")
        return false;
    }
    return true;
  });
}

export function isValidMcpFormContent(schema: unknown, content: unknown): boolean {
  if (!isSupportedMcpForm(schema) || !record(content)) return false;
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  if ((schema.required as string[] | undefined)?.some((key) => !Object.hasOwn(content, key)))
    return false;
  return Object.entries(content).every(([key, value]) => {
    if (!Object.hasOwn(properties, key)) return false;
    const field = properties[key]!;
    if (
      field.type === "integer"
        ? typeof value !== "number" || !Number.isInteger(value)
        : typeof value !== field.type
    )
      return false;
    if (
      typeof value === "number" &&
      (!Number.isFinite(value) ||
        (typeof field.minimum === "number" && value < field.minimum) ||
        (typeof field.maximum === "number" && value > field.maximum))
    )
      return false;
    if (
      typeof value === "string" &&
      ((typeof field.minLength === "number" && Array.from(value).length < field.minLength) ||
        (typeof field.maxLength === "number" && Array.from(value).length > field.maxLength))
    )
      return false;
    return !Array.isArray(field.enum) || field.enum.includes(value);
  });
}
