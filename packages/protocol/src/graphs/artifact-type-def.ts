/**
 * Custom artifact types declared inside a graph template (report §5.3).
 *
 * This is the shape a template carries in `types`, and its guard. Beyond
 * keeping every part bounded, the guard checks what one type can know about
 * itself: the name is not a built-in type's, the schema sits inside the
 * cross-provider subset (`schema-subset.ts`), `items`, `sharedFields` and
 * summary fields name fields the schema has (`items` a list), and the example
 * fits the budgets and the schema. Built-in types live in code (`types.ts`)
 * and are not declared here, which is why there is no `validator` field: only
 * built-in types may name a domain validator.
 *
 * Storage: a `value` type's payload is the JSON value, at most `maxBytes`. A
 * `reference` type's value is the descriptor of a sealed file (as
 * `review-package@2` is a `ReviewPackageReference`): the schema validates the
 * descriptor, which stays within the value cap, and `maxBytes` bounds the file.
 */
import {
  FieldErrorCollector,
  checkEnum,
  checkObject,
  isPlainRecord,
  joinPath,
} from "../field-validation.js";
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
import {
  type GraphSchemaSubsetInfo,
  checkGraphSchemaSubset,
  graphSchemaAtPath,
  validateGraphSchemaValue,
} from "./schema-subset.js";
import { graphBudgetIssues, isGraphBuiltInTypeName } from "./types.js";

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
  schema: GraphJsonSchema | undefined,
): void {
  if (!checkGraphList(value, path, errors, { min: 1, max, optional: true })) return;
  const scope = new GraphNameScope(errors, "field path");
  (value as unknown[]).forEach((entry, index) => {
    const entryPath = joinPath(path, index);
    if (!checkGraphFieldPath(entry, entryPath, errors) || !scope.add(entry, entryPath)) return;
    if (schema && !graphSchemaAtPath(schema, entry)) {
      errors.add(entryPath, "unknown_path", "The schema has no such field");
    }
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
  const namePath = joinPath(path, "name");
  if (checkGraphId(value.name, namePath, errors) && isGraphBuiltInTypeName(value.name)) {
    errors.add(
      namePath,
      "built_in_type",
      `"${value.name}" is a built-in type; choose another name`,
    );
  }
  checkGraphInteger(value.version, joinPath(path, "version"), errors, 1, B.maxTypeVersion);
  checkGraphText(value.label, joinPath(path, "label"), errors, {
    maxBytes: B.maxLabelBytes,
    optional: true,
  });
  checkGraphDescription(value.description, joinPath(path, "description"), errors);
  const schemaPath = joinPath(path, "schema");
  let subset: GraphSchemaSubsetInfo | undefined;
  if (
    checkBoundedJson(value.schema, schemaPath, errors, {
      maxBytes: B.maxTypeSchemaBytes,
      maxDepth: B.maxTypeSchemaDepth,
      requireObject: true,
    })
  ) {
    subset = checkGraphSchemaSubset(value.schema, schemaPath, errors);
  }
  // Field references and the example are checked only against a valid schema.
  const schema = subset ? (value.schema as GraphJsonSchema) : undefined;

  const storagePath = joinPath(path, "storage");
  const storage =
    checkPresent(value.storage, storagePath, errors) &&
    checkEnum(value.storage, storagePath, errors, ARTIFACT_STORAGE_CLASSES)
      ? value.storage
      : undefined;

  const budgetsPath = joinPath(path, "budgets");
  const errorsBeforeBudgets = errors.errors.length + errors.omitted;
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
  const validBudgets =
    isPlainRecord(value.budgets) && errors.errors.length + errors.omitted === errorsBeforeBudgets
      ? (value.budgets as unknown as ArtifactTypeBudgets)
      : undefined;

  if (value.items !== undefined) {
    const itemsPath = joinPath(path, "items");
    if (checkObject(value.items, itemsPath, ["path", "idPrefix"], errors)) {
      const listPath = joinPath(itemsPath, "path");
      if (checkGraphFieldPath(value.items.path, listPath, errors) && schema) {
        const list = graphSchemaAtPath(schema, value.items.path);
        if (!list) {
          errors.add(listPath, "unknown_path", "The schema has no such field");
        } else if (list.schema.type !== "array" || list.nullable) {
          errors.add(listPath, "not_a_list", "items must name a list field that is never null");
        }
      }
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

  checkPathList(
    value.sharedFields,
    joinPath(path, "sharedFields"),
    errors,
    B.maxTypeSharedFields,
    schema,
  );

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
        schema,
      );
    }
  }

  if (value.example !== undefined) {
    const examplePath = joinPath(path, "example");
    if (
      checkBoundedJson(value.example, examplePath, errors, {
        maxBytes: B.maxTypeExampleBytes,
        maxDepth: B.maxTypeSchemaDepth,
      }) &&
      schema &&
      validBudgets
    ) {
      const issues = graphBudgetIssues(
        validBudgets,
        value.example,
        value.storage === "reference" ? "reference" : "value",
      );
      for (const entry of issues.length > 0
        ? issues
        : validateGraphSchemaValue(schema, value.example)) {
        // Issue paths start at `$`, the example itself.
        errors.add(
          `${examplePath}${entry.path.slice(1)}`,
          entry.code,
          `The example does not fit: ${entry.message}`,
        );
      }
    }
  }
}
