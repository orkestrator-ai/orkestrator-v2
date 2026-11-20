/**
 * The shared form vocabulary (feature 2): one field registry and one
 * validator used by app-owned forms, plan/criterion editors and authored
 * widget outputs (feature 12). The renderer validates to guide; the backend
 * runs the same `readFormValues` to decide.
 *
 * Deliberately not JSON Schema. Supported: text, multiline text, numbers with
 * units, booleans, enumerations, multi-selects, dates with explicit timezone
 * semantics, workspace file references, repeatable scalar lists, nested groups
 * (depth ≤ 3) and repeatable groups (≤ 100 items), with declarative
 * visibility rules. Secret fields are refused: an app-owned follow-up has no
 * live secret path, so a form must not pretend to collect one.
 *
 * `null`, `""`, `0`, `false` and an absent key are distinct values and survive
 * every round trip. A value for a field hidden by its rule is refused, so a
 * hidden value can never travel unnoticed.
 *
 * Browser-safe.
 */
import {
  arr,
  bool,
  capacity,
  fail,
  id,
  isRecord,
  num,
  obj,
  oneOf,
  optBool,
  optNum,
  optStr,
  str,
  uniqueIds,
} from "./validate.js";

export const FORM_LIMITS = {
  fields: 64,
  depth: 3,
  repeatItems: 100,
  options: 100,
  textChars: 20_000,
  labelChars: 200,
  descriptionChars: 2_000,
} as const;

export const FORM_FIELD_TYPES = [
  "text",
  "multiline",
  "number",
  "boolean",
  "enum",
  "multiselect",
  "date",
  "file",
  "list",
  "group",
  "repeat",
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export interface FormOption {
  id: string;
  label: string;
  description?: string;
}

/** `visibleWhen`: the field is shown only while the referenced sibling matches. */
export interface FormCondition {
  fieldId: string;
  equals?: string | number | boolean | null;
  in?: Array<string | number | boolean>;
  notEmpty?: boolean;
}

interface FieldBase {
  id: string;
  label: string;
  description?: string;
  required: boolean;
  /** `null` is an accepted value (distinct from omission). */
  nullable?: boolean;
  /** Agent-inferred values are shown as editable pre-fills. */
  inferred?: boolean;
  visibleWhen?: FormCondition;
}

export type FormField =
  | (FieldBase & { type: "text"; minLength?: number; maxLength?: number; pattern?: string; default?: string })
  | (FieldBase & { type: "multiline"; maxLength?: number; default?: string })
  | (FieldBase & {
      type: "number";
      unit?: string;
      integer?: boolean;
      minimum?: number;
      maximum?: number;
      step?: number;
      slider?: boolean;
      default?: number;
    })
  | (FieldBase & { type: "boolean"; default?: boolean })
  | (FieldBase & { type: "enum"; options: FormOption[]; default?: string })
  | (FieldBase & { type: "multiselect"; options: FormOption[]; minItems?: number; maxItems?: number; default?: string[] })
  | (FieldBase & {
      type: "date";
      /** instant: ISO-8601 with offset; local-date: YYYY-MM-DD; local-datetime: wall time plus IANA zone. */
      mode: "instant" | "local-date" | "local-datetime";
      default?: string | { dateTime: string; timeZone: string };
    })
  | (FieldBase & { type: "file"; multiple?: boolean; default?: string | string[] })
  | (FieldBase & {
      type: "list";
      itemType: "text" | "number";
      maxItems?: number;
      unit?: string;
      default?: Array<string | number>;
    })
  | (FieldBase & { type: "group"; fields: FormField[] })
  | (FieldBase & { type: "repeat"; fields: FormField[]; minItems?: number; maxItems?: number });

export interface FormSpec {
  fields: FormField[];
}

/** A repeat item keeps a stable id independent of its position. */
export interface FormRepeatItem {
  itemId: string;
  values: FormValues;
}

export type FormValue =
  | string
  | number
  | boolean
  | null
  | string[]
  | Array<string | number>
  | { dateTime: string; timeZone: string }
  | FormValues
  | FormRepeatItem[];

export type FormValues = { [fieldId: string]: FormValue };

const FIELD_KEYS = [
  "id",
  "type",
  "label",
  "description",
  "required",
  "nullable",
  "inferred",
  "visibleWhen",
  "minLength",
  "maxLength",
  "pattern",
  "default",
  "unit",
  "integer",
  "minimum",
  "maximum",
  "step",
  "slider",
  "options",
  "minItems",
  "maxItems",
  "mode",
  "multiple",
  "itemType",
  "fields",
  "secret",
];

function readOption(value: unknown, path: string): FormOption {
  const record = obj(value, path, ["id", "label", "description"]);
  const description = optStr(record.description, `${path}.description`, FORM_LIMITS.descriptionChars);
  return {
    id: id(record.id, `${path}.id`),
    label: str(record.label, `${path}.label`, FORM_LIMITS.labelChars, 1),
    ...(description === undefined ? {} : { description }),
  };
}

function readCondition(value: unknown, path: string): FormCondition {
  const record = obj(value, path, ["fieldId", "equals", "in", "notEmpty"]);
  const scalar = (item: unknown, itemPath: string) => {
    if (typeof item === "string" || typeof item === "boolean") return item;
    return num(item, itemPath);
  };
  const out: FormCondition = { fieldId: id(record.fieldId, `${path}.fieldId`) };
  const declared = ["equals", "in", "notEmpty"].filter((key) => record[key] !== undefined);
  if (declared.length !== 1) fail(path, "must declare exactly one of equals, in or notEmpty");
  if (record.equals !== undefined) out.equals = record.equals === null ? null : scalar(record.equals, `${path}.equals`);
  if (record.in !== undefined) out.in = arr(record.in, `${path}.in`, 50, scalar, 1);
  if (record.notEmpty !== undefined) out.notEmpty = bool(record.notEmpty, `${path}.notEmpty`);
  return out;
}

interface FieldCounter {
  count: number;
}

function readField(value: unknown, path: string, depth: number, counter: FieldCounter): FormField {
  const record = obj(value, path, FIELD_KEYS);
  counter.count += 1;
  if (counter.count > FORM_LIMITS.fields) capacity(path, `a form may declare at most ${FORM_LIMITS.fields} fields`);
  if (record.secret !== undefined) {
    fail(`${path}.secret`, "secret fields are not supported: an app-owned form has no live secret path");
  }
  const type = oneOf(record.type, `${path}.type`, FORM_FIELD_TYPES);
  const description = optStr(record.description, `${path}.description`, FORM_LIMITS.descriptionChars);
  const nullable = optBool(record.nullable, `${path}.nullable`);
  const inferred = optBool(record.inferred, `${path}.inferred`);
  const base: FieldBase = {
    id: id(record.id, `${path}.id`, 64),
    label: str(record.label, `${path}.label`, FORM_LIMITS.labelChars, 1),
    required: record.required === undefined ? false : bool(record.required, `${path}.required`),
    ...(description === undefined ? {} : { description }),
    ...(nullable === undefined ? {} : { nullable }),
    ...(inferred === undefined ? {} : { inferred }),
    ...(record.visibleWhen === undefined ? {} : { visibleWhen: readCondition(record.visibleWhen, `${path}.visibleWhen`) }),
  };
  const allowOnly = (keys: string[]) => {
    const common = ["id", "type", "label", "description", "required", "nullable", "inferred", "visibleWhen", "default"];
    for (const key of Object.keys(record)) {
      if (!common.includes(key) && !keys.includes(key)) fail(`${path}.${key}`, `is not supported on a ${type} field`);
    }
  };
  const options = () => {
    const list = arr(record.options, `${path}.options`, FORM_LIMITS.options, readOption, 1);
    uniqueIds(list, `${path}.options`, (option) => option.id);
    return list;
  };
  let field: FormField;
  switch (type) {
    case "text": {
      allowOnly(["minLength", "maxLength", "pattern"]);
      const minLength = optNum(record.minLength, `${path}.minLength`, { min: 0, integer: true });
      const maxLength = optNum(record.maxLength, `${path}.maxLength`, { min: 0, max: FORM_LIMITS.textChars, integer: true });
      const pattern = optStr(record.pattern, `${path}.pattern`, 500);
      if (pattern !== undefined) {
        try {
          new RegExp(pattern, "u");
        } catch {
          fail(`${path}.pattern`, "is not a valid regular expression");
        }
      }
      field = { ...base, type, ...(minLength === undefined ? {} : { minLength }), ...(maxLength === undefined ? {} : { maxLength }), ...(pattern === undefined ? {} : { pattern }) };
      break;
    }
    case "multiline": {
      allowOnly(["maxLength"]);
      const maxLength = optNum(record.maxLength, `${path}.maxLength`, { min: 0, max: FORM_LIMITS.textChars, integer: true });
      field = { ...base, type, ...(maxLength === undefined ? {} : { maxLength }) };
      break;
    }
    case "number": {
      allowOnly(["unit", "integer", "minimum", "maximum", "step", "slider"]);
      const unit = optStr(record.unit, `${path}.unit`, 40);
      const integer = optBool(record.integer, `${path}.integer`);
      const minimum = optNum(record.minimum, `${path}.minimum`);
      const maximum = optNum(record.maximum, `${path}.maximum`);
      const step = optNum(record.step, `${path}.step`, { min: Number.MIN_VALUE });
      const slider = optBool(record.slider, `${path}.slider`);
      if (minimum !== undefined && maximum !== undefined && maximum < minimum) fail(`${path}.maximum`, "must not be below minimum");
      if (slider && (minimum === undefined || maximum === undefined)) fail(`${path}.slider`, "a slider needs minimum and maximum");
      field = {
        ...base,
        type,
        ...(unit === undefined ? {} : { unit }),
        ...(integer === undefined ? {} : { integer }),
        ...(minimum === undefined ? {} : { minimum }),
        ...(maximum === undefined ? {} : { maximum }),
        ...(step === undefined ? {} : { step }),
        ...(slider === undefined ? {} : { slider }),
      };
      break;
    }
    case "boolean":
      allowOnly([]);
      field = { ...base, type };
      break;
    case "enum":
      allowOnly(["options"]);
      field = { ...base, type, options: options() };
      break;
    case "multiselect": {
      allowOnly(["options", "minItems", "maxItems"]);
      const minItems = optNum(record.minItems, `${path}.minItems`, { min: 0, integer: true });
      const maxItems = optNum(record.maxItems, `${path}.maxItems`, { min: 1, integer: true });
      field = { ...base, type, options: options(), ...(minItems === undefined ? {} : { minItems }), ...(maxItems === undefined ? {} : { maxItems }) };
      break;
    }
    case "date":
      allowOnly(["mode"]);
      field = { ...base, type, mode: oneOf(record.mode, `${path}.mode`, ["instant", "local-date", "local-datetime"] as const) };
      break;
    case "file": {
      allowOnly(["multiple"]);
      const multiple = optBool(record.multiple, `${path}.multiple`);
      field = { ...base, type, ...(multiple === undefined ? {} : { multiple }) };
      break;
    }
    case "list": {
      allowOnly(["itemType", "maxItems", "unit"]);
      const maxItems = optNum(record.maxItems, `${path}.maxItems`, { min: 1, max: FORM_LIMITS.repeatItems, integer: true });
      const unit = optStr(record.unit, `${path}.unit`, 40);
      field = {
        ...base,
        type,
        itemType: oneOf(record.itemType, `${path}.itemType`, ["text", "number"] as const),
        ...(maxItems === undefined ? {} : { maxItems }),
        ...(unit === undefined ? {} : { unit }),
      };
      break;
    }
    case "group":
    case "repeat": {
      allowOnly(type === "repeat" ? ["fields", "minItems", "maxItems"] : ["fields"]);
      if (depth + 1 > FORM_LIMITS.depth) capacity(path, `groups may nest at most ${FORM_LIMITS.depth} levels`);
      const fields = readFields(record.fields, `${path}.fields`, depth + 1, counter);
      if (type === "group") {
        field = { ...base, type, fields };
      } else {
        const minItems = optNum(record.minItems, `${path}.minItems`, { min: 0, max: FORM_LIMITS.repeatItems, integer: true });
        const maxItems = optNum(record.maxItems, `${path}.maxItems`, { min: 1, max: FORM_LIMITS.repeatItems, integer: true });
        field = { ...base, type, fields, ...(minItems === undefined ? {} : { minItems }), ...(maxItems === undefined ? {} : { maxItems }) };
      }
      break;
    }
  }
  if (record.default !== undefined) {
    if (type === "group" || type === "repeat") fail(`${path}.default`, "groups take defaults from their fields");
    readFieldValue(field, record.default, `${path}.default`);
    (field as { default?: unknown }).default = record.default;
  }
  return field;
}

function readFields(value: unknown, path: string, depth: number, counter: FieldCounter): FormField[] {
  const fields = arr(value, path, FORM_LIMITS.fields, (item, itemPath) => readField(item, itemPath, depth, counter), 1);
  uniqueIds(fields, path, (field) => field.id);
  for (const [index, field] of fields.entries()) {
    const condition = field.visibleWhen;
    if (!condition) continue;
    const target = fields.find((candidate) => candidate.id === condition.fieldId);
    if (!target || target.id === field.id) {
      fail(`${path}[${index}].visibleWhen.fieldId`, "must name a sibling field");
    }
    if (target.type === "group" || target.type === "repeat") {
      fail(`${path}[${index}].visibleWhen.fieldId`, "cannot depend on a group");
    }
  }
  return fields;
}

export function readFormSpec(value: unknown, path: string): FormSpec {
  const record = obj(value, path, ["fields"]);
  return { fields: readFields(record.fields, `${path}.fields`, 1, { count: 0 }) };
}

// ---------------------------------------------------------------------------
// Values

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/u;
const IANA_ZONE = /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)*$|^UTC$/u;

/** Whether a scalar condition holds against sibling values. */
export function conditionHolds(condition: FormCondition, siblings: FormValues): boolean {
  const value = siblings[condition.fieldId];
  if (condition.notEmpty !== undefined) {
    const empty = value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
    return condition.notEmpty ? !empty : empty;
  }
  if (condition.in !== undefined) {
    return (typeof value === "string" || typeof value === "number" || typeof value === "boolean") && condition.in.includes(value);
  }
  return value === condition.equals || (value === undefined && condition.equals === null && false);
}

export function isFieldVisible(field: FormField, siblings: FormValues): boolean {
  return !field.visibleWhen || conditionHolds(field.visibleWhen, siblings);
}

function readFieldValue(field: FormField, value: unknown, path: string): FormValue {
  if (value === null) {
    if (!field.nullable) fail(path, "must not be null");
    return null;
  }
  switch (field.type) {
    case "text": {
      const text = str(value, path, field.maxLength ?? FORM_LIMITS.textChars);
      if (field.minLength !== undefined && Array.from(text).length < field.minLength) fail(path, `must be at least ${field.minLength} characters`);
      if (field.pattern !== undefined && text !== "" && !new RegExp(field.pattern, "u").test(text)) fail(path, "does not match the required format");
      return text;
    }
    case "multiline":
      return str(value, path, field.maxLength ?? FORM_LIMITS.textChars);
    case "number": {
      const number = num(value, path, {
        ...(field.minimum === undefined ? {} : { min: field.minimum }),
        ...(field.maximum === undefined ? {} : { max: field.maximum }),
        ...(field.integer ? { integer: true } : {}),
      });
      if (field.step !== undefined) {
        const origin = field.minimum ?? 0;
        const steps = (number - origin) / field.step;
        if (Math.abs(steps - Math.round(steps)) > 1e-9) fail(path, `must be a multiple of ${field.step} from ${origin}`);
      }
      return number;
    }
    case "boolean":
      return bool(value, path);
    case "enum": {
      const choice = str(value, path, 200);
      if (!field.options.some((option) => option.id === choice)) fail(path, "is not one of the offered options");
      return choice;
    }
    case "multiselect": {
      const choices = arr(value, path, field.options.length, (item, itemPath) => {
        const choice = str(item, itemPath, 200);
        if (!field.options.some((option) => option.id === choice)) fail(itemPath, "is not one of the offered options");
        return choice;
      });
      if (new Set(choices).size !== choices.length) fail(path, "must not repeat a choice");
      if (field.minItems !== undefined && choices.length < field.minItems) fail(path, `needs at least ${field.minItems} choices`);
      if (field.maxItems !== undefined && choices.length > field.maxItems) fail(path, `allows at most ${field.maxItems} choices`);
      return choices;
    }
    case "date": {
      if (field.mode === "local-datetime") {
        const record = obj(value, path, ["dateTime", "timeZone"]);
        const dateTime = str(record.dateTime, `${path}.dateTime`, 40);
        const timeZone = str(record.timeZone, `${path}.timeZone`, 64);
        if (!LOCAL_DATETIME.test(dateTime)) fail(`${path}.dateTime`, "must be YYYY-MM-DDTHH:MM[:SS] wall time");
        if (!IANA_ZONE.test(timeZone)) fail(`${path}.timeZone`, "must be an IANA time zone");
        return { dateTime, timeZone };
      }
      const text = str(value, path, 40);
      if (field.mode === "local-date" ? !LOCAL_DATE.test(text) : !INSTANT.test(text)) {
        fail(path, field.mode === "local-date" ? "must be YYYY-MM-DD" : "must be an ISO-8601 instant with an offset");
      }
      if (Number.isNaN(Date.parse(field.mode === "local-date" ? `${text}T00:00:00Z` : text))) fail(path, "is not a real date");
      return text;
    }
    case "file": {
      const readPath = (item: unknown, itemPath: string) => {
        const text = str(item, itemPath, 1_024, 1);
        if (/(^|\/)\.\.(\/|$)/u.test(text) || text.includes("\0")) fail(itemPath, "must be a workspace-relative path");
        return text;
      };
      return field.multiple ? arr(value, path, 100, readPath) : readPath(value, path);
    }
    case "list":
      return arr(value, path, field.maxItems ?? FORM_LIMITS.repeatItems, (item, itemPath) =>
        field.itemType === "number" ? num(item, itemPath) : str(item, itemPath, FORM_LIMITS.textChars),
      );
    case "group":
      return readValues(field.fields, value, path);
    case "repeat": {
      const items = arr(value, path, field.maxItems ?? FORM_LIMITS.repeatItems, (item, itemPath) => {
        const record = obj(item, itemPath, ["itemId", "values"]);
        return { itemId: id(record.itemId, `${itemPath}.itemId`), values: readValues(field.fields, record.values, `${itemPath}.values`) };
      });
      uniqueIds(items, path, (item) => item.itemId);
      if (field.minItems !== undefined && items.length < field.minItems) fail(path, `needs at least ${field.minItems} items`);
      return items;
    }
  }
}

function readValues(fields: readonly FormField[], value: unknown, path: string): FormValues {
  if (!isRecord(value)) fail(path, "must be an object of field values");
  for (const key of Object.keys(value)) {
    if (!fields.some((field) => field.id === key)) fail(`${path}.${key}`, "is not a field of this form");
  }
  const out: FormValues = {};
  // Scalars first so visibility conditions read validated sibling values.
  for (const field of fields) {
    if (Object.hasOwn(value, field.id)) out[field.id] = readFieldValue(field, value[field.id], `${path}.${field.id}`);
  }
  for (const field of fields) {
    const visible = isFieldVisible(field, out);
    const present = Object.hasOwn(out, field.id);
    if (!visible && present) fail(`${path}.${field.id}`, "is hidden by its condition and must be omitted");
    if (visible && field.required && !present) fail(`${path}.${field.id}`, "is required");
  }
  return out;
}

/** Validates submitted values against a spec; the backend's authority. */
export function readFormValues(spec: FormSpec, value: unknown, path: string): FormValues {
  return readValues(spec.fields, value, path);
}

/** Initial values: defaults only, never invented values. */
export function initialFormValues(fields: readonly FormField[]): FormValues {
  const out: FormValues = {};
  for (const field of fields) {
    if (field.type === "group") {
      out[field.id] = initialFormValues(field.fields);
    } else if (field.type === "repeat") {
      out[field.id] = [];
    } else if ((field as { default?: FormValue }).default !== undefined) {
      out[field.id] = (field as { default?: FormValue }).default as FormValue;
    }
  }
  return out;
}

/** Removes values for fields hidden by their conditions; reports what was removed. */
export function pruneHiddenValues(
  fields: readonly FormField[],
  values: FormValues,
  prefix = "",
): { values: FormValues; removed: string[] } {
  const out: FormValues = {};
  const removed: string[] = [];
  for (const field of fields) {
    if (!Object.hasOwn(values, field.id)) continue;
    const label = prefix ? `${prefix} › ${field.label}` : field.label;
    if (!isFieldVisible(field, values)) {
      removed.push(label);
      continue;
    }
    const current = values[field.id] as FormValue;
    if (field.type === "group" && isRecord(current)) {
      const nested = pruneHiddenValues(field.fields, current as FormValues, label);
      out[field.id] = nested.values;
      removed.push(...nested.removed);
    } else if (field.type === "repeat" && Array.isArray(current)) {
      out[field.id] = (current as FormRepeatItem[]).map((item, index) => {
        const nested = pruneHiddenValues(field.fields, item.values, `${label} #${index + 1}`);
        removed.push(...nested.removed);
        return { itemId: item.itemId, values: nested.values };
      });
    } else {
      out[field.id] = current;
    }
  }
  return { values: out, removed };
}

/** Readable `label: value` lines for an agent-facing summary. */
export function summarizeFormValues(fields: readonly FormField[], values: FormValues, indent = ""): string[] {
  const lines: string[] = [];
  for (const field of fields) {
    if (!Object.hasOwn(values, field.id)) continue;
    const value = values[field.id];
    if (field.type === "group" && isRecord(value)) {
      lines.push(`${indent}- ${field.label} (${field.id}):`);
      lines.push(...summarizeFormValues(field.fields, value as FormValues, `${indent}  `));
    } else if (field.type === "repeat" && Array.isArray(value)) {
      lines.push(`${indent}- ${field.label} (${field.id}): ${value.length} item(s)`);
      (value as FormRepeatItem[]).forEach((item, index) => {
        lines.push(`${indent}  - #${index + 1} (${item.itemId}):`);
        lines.push(...summarizeFormValues(field.fields, item.values, `${indent}    `));
      });
    } else {
      const unit = field.type === "number" || field.type === "list" ? field.unit : undefined;
      const shown = field.type === "enum" || field.type === "multiselect"
        ? labelChoices(field.options, value)
        : JSON.stringify(value);
      lines.push(`${indent}- ${field.label} (${field.id}): ${shown}${unit ? ` ${unit}` : ""}`);
    }
  }
  return lines;
}

function labelChoices(options: readonly FormOption[], value: unknown): string {
  const label = (choice: unknown) => {
    const option = options.find((candidate) => candidate.id === choice);
    return option ? `${option.label} [${option.id}]` : JSON.stringify(choice);
  };
  return Array.isArray(value) ? value.map(label).join(", ") || "(none)" : value === null ? "null" : label(value);
}


/** A fresh, stable identity for a new repeat item (independent of its position). */
export function newRepeatItemId(): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().slice(0, 12) : Math.random().toString(36).slice(2, 14);
  return `item-${random}`;
}

/**
 * The first validation problem keyed by field path (`group.field`,
 * `items[0].values.path`), for showing beside the field. Empty when valid.
 */
export function formErrors(spec: FormSpec, values: unknown): Record<string, string> {
  try {
    readFormValues(spec, values, "$");
    return {};
  } catch (error) {
    if (error instanceof Error && "path" in error && typeof (error as { path: unknown }).path === "string") {
      const path = (error as { path: string }).path;
      const key = path.replace(/^\$\.?/u, "");
      return { [key || "$"]: error.message.replace(`${path}: `, "") };
    }
    throw error;
  }
}
