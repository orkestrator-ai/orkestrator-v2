/**
 * Custom artifact types declared inside a graph template (report §5.3).
 *
 * This is the *structural* shape a template carries in `types`. The template
 * guard keeps every part bounded; item 102 (type library) refines it: the
 * schema must sit inside the cross-provider subset (`schema-subset.ts`), the
 * example must satisfy the schema, and names must not shadow built-in types.
 * Built-in types live in code and are not declared here, which is why there is
 * no `validator` field: only built-in types may name a domain validator.
 */
import { FieldErrorCollector, checkEnum, checkObject, joinPath } from "../field-validation.js";
import {
  GRAPH_TEMPLATE_BOUNDS as B,
  GraphNameScope,
  checkBoundedJson,
  checkGraphDescription,
  checkGraphFieldPath,
  checkGraphId,
  checkGraphInteger,
  checkGraphList,
  checkGraphText,
  checkPresent,
} from "./grammar.js";

export const ARTIFACT_STORAGE_CLASSES = ["value", "reference"] as const;
export type ArtifactStorageClass = (typeof ARTIFACT_STORAGE_CLASSES)[number];

/**
 * A JSON schema in the subset `validateWorkflowJsonSchema` supports. Kept as a
 * bounded JSON object here; 102's `schema-subset.ts` owns the keyword rules.
 */
export type GraphJsonSchema = Record<string, unknown>;

export interface ArtifactTypeBudgets {
  /** Payload bytes: at most 384 KiB for value types, 32 MiB for reference types. */
  maxBytes: number;
  maxStringBytes?: number;
  maxItems?: number;
}

export interface ArtifactTypeItems {
  /** The list field whose elements carry stable source IDs (report §5.9). */
  path: string;
  /** Prefix for generated item IDs: `finding` gives `reviewer-2/finding-3`. */
  idPrefix: string;
}

export interface ArtifactTypeRender {
  /** Logic-less markdown template (item 105) for UI and `markdown` renders. */
  markdown?: string;
  /** Field paths shown on node faces and in `summary` renders. */
  summary?: string[];
}

export interface ArtifactTypeDef {
  /** Kebab-case name; referenced as `name@version`. */
  name: string;
  /** Major version; a breaking change is a new version (report §5.12). */
  version: number;
  label?: string;
  description?: string;
  schema: GraphJsonSchema;
  storage: ArtifactStorageClass;
  budgets: ArtifactTypeBudgets;
  items?: ArtifactTypeItems;
  /** Fields hoisted into a `shared` block when every source agrees (report §5.9). */
  sharedFields?: string[];
  render?: ArtifactTypeRender;
  /** A sample payload for prompt previews and mock runs. */
  example?: unknown;
}

const TYPE_FIELDS = [
  "name",
  "version",
  "label",
  "description",
  "schema",
  "storage",
  "budgets",
  "items",
  "sharedFields",
  "render",
  "example",
] as const;

function checkPathList(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  max: number,
): void {
  if (!checkGraphList(value, path, errors, { min: 1, max, optional: true })) return;
  const scope = new GraphNameScope(errors, "field path");
  (value as unknown[]).forEach((entry, index) => {
    const entryPath = joinPath(path, index);
    if (checkGraphFieldPath(entry, entryPath, errors)) scope.add(entry, entryPath);
  });
}

/** Structural guard for one custom type at `path`, adding errors to `errors`. */
export function checkArtifactTypeDef(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
): void {
  if (!checkPresent(value, path, errors)) return;
  if (!checkObject(value, path, TYPE_FIELDS, errors)) return;
  checkGraphId(value.name, joinPath(path, "name"), errors);
  checkGraphInteger(value.version, joinPath(path, "version"), errors, 1, B.maxTypeVersion);
  checkGraphText(value.label, joinPath(path, "label"), errors, {
    maxBytes: B.maxLabelBytes,
    optional: true,
  });
  checkGraphDescription(value.description, joinPath(path, "description"), errors);
  checkBoundedJson(value.schema, joinPath(path, "schema"), errors, {
    maxBytes: B.maxTypeSchemaBytes,
    maxDepth: B.maxTypeSchemaDepth,
    requireObject: true,
  });

  const storagePath = joinPath(path, "storage");
  const storage =
    checkPresent(value.storage, storagePath, errors) &&
    checkEnum(value.storage, storagePath, errors, ARTIFACT_STORAGE_CLASSES)
      ? value.storage
      : undefined;

  const budgetsPath = joinPath(path, "budgets");
  if (
    checkPresent(value.budgets, budgetsPath, errors) &&
    checkObject(value.budgets, budgetsPath, ["maxBytes", "maxStringBytes", "maxItems"], errors)
  ) {
    const ceiling = storage === "reference" ? B.maxReferenceArtifactBytes : B.maxValueArtifactBytes;
    const budgets = value.budgets;
    if (
      checkGraphInteger(budgets.maxBytes, joinPath(budgetsPath, "maxBytes"), errors, 1, ceiling)
    ) {
      checkGraphInteger(
        budgets.maxStringBytes,
        joinPath(budgetsPath, "maxStringBytes"),
        errors,
        1,
        budgets.maxBytes,
        true,
      );
    }
    checkGraphInteger(
      budgets.maxItems,
      joinPath(budgetsPath, "maxItems"),
      errors,
      1,
      B.maxArtifactItems,
      true,
    );
  }

  if (value.items !== undefined) {
    const itemsPath = joinPath(path, "items");
    if (checkObject(value.items, itemsPath, ["path", "idPrefix"], errors)) {
      checkGraphFieldPath(value.items.path, joinPath(itemsPath, "path"), errors);
      const prefixPath = joinPath(itemsPath, "idPrefix");
      if (checkGraphId(value.items.idPrefix, prefixPath, errors)) {
        if ((value.items.idPrefix as string).length > B.maxItemIdPrefixChars) {
          errors.add(
            prefixPath,
            "too_long",
            `Must contain at most ${B.maxItemIdPrefixChars} characters`,
          );
        }
      }
    }
  }

  checkPathList(value.sharedFields, joinPath(path, "sharedFields"), errors, B.maxTypeSharedFields);

  if (value.render !== undefined) {
    const renderPath = joinPath(path, "render");
    if (checkObject(value.render, renderPath, ["markdown", "summary"], errors)) {
      checkGraphText(value.render.markdown, joinPath(renderPath, "markdown"), errors, {
        maxBytes: B.maxTypeMarkdownBytes,
        multiline: true,
        optional: true,
      });
      checkPathList(
        value.render.summary,
        joinPath(renderPath, "summary"),
        errors,
        B.maxTypeSummaryFields,
      );
    }
  }

  if (value.example !== undefined) {
    checkBoundedJson(value.example, joinPath(path, "example"), errors, {
      maxBytes: B.maxTypeExampleBytes,
      maxDepth: B.maxTypeSchemaDepth,
    });
  }
}
