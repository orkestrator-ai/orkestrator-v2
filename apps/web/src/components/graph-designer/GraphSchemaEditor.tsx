import { useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { GraphJsonSchema } from "@orkestrator/protocol/graphs/artifact-type-def";
import { isGraphKey } from "@orkestrator/protocol/graphs/grammar";
import {
  GRAPH_SCHEMA_SOURCES_KEYWORD,
  GRAPH_SCHEMA_SUBSET_BOUNDS,
  validateGraphSchemaSubset,
} from "@orkestrator/protocol/graphs/schema-subset";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { uniqueGraphKey } from "./graph-designer-edits";
import {
  AddButton,
  CheckboxField,
  CommitField,
  JsonField,
  NumberField,
  RemoveButton,
  SelectField,
  TextField,
} from "./graph-form-controls";

/**
 * A form editor for a custom type's schema, limited to the portable subset
 * of item 102 (`schema-subset.ts`): the root is an object; every object
 * lists all its properties in `required` and has `additionalProperties:
 * false`, so the form keeps both in step; an optional value is a nullable
 * one (`anyOf` with `{ "type": "null" }`). Annotations (`description`, the
 * `x-orkestrator-sources` provenance mark) sit on the property itself, never
 * inside the `anyOf`. Anything the form cannot express is edited as JSON,
 * and the subset checker's verdict is shown live either way.
 */

const FIELD_TYPES = ["string", "number", "integer", "boolean", "null", "object", "array"] as const;
type FieldType = (typeof FIELD_TYPES)[number];

const ANNOTATIONS = ["description", "title", GRAPH_SCHEMA_SOURCES_KEYWORD] as const;

function isRecord(value: unknown): value is GraphJsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A property schema as the form sees it: the value's own schema, nullability and annotations. */
interface FieldParts {
  inner: GraphJsonSchema;
  nullable: boolean;
  annotations: GraphJsonSchema;
}

function splitField(schema: GraphJsonSchema): FieldParts {
  const annotations: GraphJsonSchema = {};
  const rest: GraphJsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if ((ANNOTATIONS as readonly string[]).includes(key)) annotations[key] = value;
    else rest[key] = value;
  }
  if (Array.isArray(rest.anyOf)) {
    const branches = rest.anyOf.filter(isRecord);
    const others = branches.filter((branch) => branch.type !== "null");
    if (others.length === 1 && others.length < branches.length) {
      return { inner: others[0]!, nullable: true, annotations };
    }
  }
  return { inner: rest, nullable: false, annotations };
}

function joinField({ inner, nullable, annotations }: FieldParts): GraphJsonSchema {
  const clean: GraphJsonSchema = {};
  for (const [key, value] of Object.entries(annotations)) {
    if (value !== undefined && value !== "") clean[key] = value;
  }
  return nullable && inner.type !== "null"
    ? { ...clean, anyOf: [inner, { type: "null" }] }
    : { ...inner, ...clean };
}

function freshInner(type: FieldType): GraphJsonSchema {
  switch (type) {
    case "object":
      return {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      };
    case "array":
      return { type: "array", items: { type: "string" } };
    default:
      return { type };
  }
}

function fieldType(inner: GraphJsonSchema): FieldType | "other" {
  return (FIELD_TYPES as readonly unknown[]).includes(inner.type)
    ? (inner.type as FieldType)
    : "other";
}

function isStringList(inner: GraphJsonSchema): boolean {
  return (
    inner.type === "array" &&
    isRecord(inner.items) &&
    splitField(inner.items).inner.type === "string"
  );
}

/** Properties in order; `required` always lists every one (the subset demands it). */
function withProperties(
  object: GraphJsonSchema,
  entries: Array<[string, GraphJsonSchema]>,
): GraphJsonSchema {
  return {
    ...object,
    type: "object",
    properties: Object.fromEntries(entries),
    required: entries.map(([name]) => name),
    additionalProperties: false,
  };
}

function propertyEntries(object: GraphJsonSchema): Array<[string, GraphJsonSchema]> {
  const properties = isRecord(object.properties) ? object.properties : {};
  return Object.entries(properties).map(([name, value]) => [name, isRecord(value) ? value : {}]);
}

function enumText(inner: GraphJsonSchema): string {
  return Array.isArray(inner.enum) ? inner.enum.map(String).join(", ") : "";
}

function parseEnum(text: string, type: FieldType): Array<string | number> | null | string {
  const parts = text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  if (type === "string") return parts;
  const numbers = parts.map(Number);
  if (numbers.some((value) => !Number.isFinite(value))) return "Enter numbers separated by commas";
  if (type === "integer" && numbers.some((value) => !Number.isInteger(value))) {
    return "Enter whole numbers separated by commas";
  }
  return numbers;
}

function SchemaField({
  schema,
  onChange,
  path,
  objectDepth,
  allowNullable = true,
}: {
  schema: GraphJsonSchema;
  onChange: (next: GraphJsonSchema) => void;
  path: string;
  /** Objects already enclosing this field. */
  objectDepth: number;
  allowNullable?: boolean;
}) {
  const parts = splitField(schema);
  const { inner, nullable, annotations } = parts;
  const type = fieldType(inner);
  const set = (patch: Partial<FieldParts>) => onChange(joinField({ ...parts, ...patch }));
  const setInner = (patch: GraphJsonSchema) => {
    const next = { ...inner, ...patch };
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete next[key];
    set({ inner: next });
  };
  const tooDeep = objectDepth >= GRAPH_SCHEMA_SUBSET_BOUNDS.maxObjectDepth;
  return (
    <div className="flex flex-col gap-1.5" data-graph-schema-type={type}>
      <div className="grid grid-cols-2 gap-2">
        <SelectField
          label="Type"
          value={type === "other" ? String(inner.type ?? "") : type}
          options={FIELD_TYPES.map((value) => ({
            value,
            label: value,
            disabled: value === "object" && tooDeep,
          }))}
          onChange={(value) => {
            const next = value as FieldType;
            const annotationsLeft = { ...annotations };
            // Provenance marks only arrays of strings.
            if (next !== "array") delete annotationsLeft[GRAPH_SCHEMA_SOURCES_KEYWORD];
            onChange(
              joinField({
                inner: freshInner(next),
                nullable: nullable && next !== "null",
                annotations: annotationsLeft,
              }),
            );
          }}
        />
        {allowNullable ? (
          <div className="flex items-end pb-1">
            <CheckboxField
              label="May be null"
              checked={nullable}
              disabled={type === "null"}
              onChange={(checked) => set({ nullable: checked })}
            />
          </div>
        ) : null}
      </div>
      <TextField
        label="Description"
        value={typeof annotations.description === "string" ? annotations.description : ""}
        onChange={(value) =>
          set({ annotations: { ...annotations, description: value || undefined } })
        }
      />
      {type === "string" || type === "number" || type === "integer" ? (
        <CommitField
          label="Allowed values (comma-separated, optional)"
          value={enumText(inner)}
          mono={false}
          validate={(text) => {
            const parsed = parseEnum(text, type);
            return typeof parsed === "string" ? parsed : null;
          }}
          onCommit={(text) => {
            const parsed = parseEnum(text, type);
            if (typeof parsed !== "string") setInner({ enum: parsed ?? undefined });
          }}
        />
      ) : null}
      {type === "number" || type === "integer" ? (
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="Minimum"
            value={typeof inner.minimum === "number" ? inner.minimum : undefined}
            integer={type === "integer"}
            optional
            onCommit={(value) => setInner({ minimum: value })}
          />
          <NumberField
            label="Maximum"
            value={typeof inner.maximum === "number" ? inner.maximum : undefined}
            integer={type === "integer"}
            optional
            onCommit={(value) => setInner({ maximum: value })}
          />
        </div>
      ) : null}
      {type === "array" ? (
        <>
          {isStringList(inner) ? (
            <CheckboxField
              label="Provenance field (cites source IDs)"
              checked={annotations[GRAPH_SCHEMA_SOURCES_KEYWORD] === true}
              hint="x-orkestrator-sources: each entry must be the ID of an item this node received."
              onChange={(checked) =>
                set({
                  annotations: {
                    ...annotations,
                    [GRAPH_SCHEMA_SOURCES_KEYWORD]: checked ? true : undefined,
                  },
                })
              }
            />
          ) : null}
          <div
            className="flex flex-col gap-1.5 border-l-2 border-border/60 pl-2"
            data-graph-schema-items={path}
          >
            <span className="text-[11px] font-medium text-muted-foreground">Each item</span>
            <SchemaField
              schema={isRecord(inner.items) ? inner.items : { type: "string" }}
              path={`${path}[]`}
              objectDepth={objectDepth}
              onChange={(items) => {
                const next: GraphJsonSchema = { ...inner, items };
                const nextParts = { ...parts, inner: next };
                // A list that is no longer of strings cannot stay a provenance field.
                if (!isStringList(next)) {
                  const left = { ...annotations };
                  delete left[GRAPH_SCHEMA_SOURCES_KEYWORD];
                  nextParts.annotations = left;
                }
                onChange(joinField(nextParts));
              }}
            />
          </div>
        </>
      ) : null}
      {type === "object" ? (
        <ObjectProperties
          object={inner}
          path={path}
          objectDepth={objectDepth + 1}
          onChange={(object) => set({ inner: object })}
        />
      ) : null}
    </div>
  );
}

function ObjectProperties({
  object,
  onChange,
  path,
  objectDepth,
}: {
  object: GraphJsonSchema;
  onChange: (next: GraphJsonSchema) => void;
  path: string;
  objectDepth: number;
}) {
  const entries = propertyEntries(object);
  const names = entries.map(([name]) => name);
  const replace = (next: Array<[string, GraphJsonSchema]>) =>
    onChange(withProperties(object, next));
  const atMost = entries.length >= GRAPH_SCHEMA_SUBSET_BOUNDS.maxPropertiesPerObject;
  return (
    <div className="flex flex-col gap-1.5" data-graph-schema-object={path || "$"}>
      {entries.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No fields yet.</p>
      ) : null}
      {entries.map(([name, child], index) => {
        const fieldPath = path ? `${path}.${name}` : name;
        return (
          <div
            key={name}
            data-graph-schema-field={fieldPath}
            className="flex flex-col gap-1.5 rounded-md border border-border/60 bg-flow-canvas/40 p-2"
          >
            <div className="flex items-end gap-1">
              <div className="min-w-0 flex-1">
                <CommitField
                  label="Field name"
                  value={name}
                  validate={(text) =>
                    !isGraphKey(text)
                      ? "Start with a lower-case letter; letters, digits and _ only"
                      : names.includes(text)
                        ? `${text} is already a field here`
                        : null
                  }
                  onCommit={(text) =>
                    replace(
                      entries.map((entry): [string, GraphJsonSchema] =>
                        entry[0] === name ? [text, entry[1]] : entry,
                      ),
                    )
                  }
                />
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label={`Move ${name} up`}
                disabled={index === 0}
                onClick={() => {
                  const next = [...entries];
                  [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                  replace(next);
                }}
              >
                <ArrowUp className="size-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label={`Move ${name} down`}
                disabled={index === entries.length - 1}
                onClick={() => {
                  const next = [...entries];
                  [next[index + 1], next[index]] = [next[index]!, next[index + 1]!];
                  replace(next);
                }}
              >
                <ArrowDown className="size-3" />
              </Button>
              <RemoveButton
                label={`Remove field ${name}`}
                onClick={() => replace(entries.filter((entry) => entry[0] !== name))}
              />
            </div>
            <SchemaField
              schema={child}
              path={fieldPath}
              objectDepth={objectDepth}
              onChange={(next) =>
                replace(
                  entries.map((entry): [string, GraphJsonSchema] =>
                    entry[0] === name ? [name, next] : entry,
                  ),
                )
              }
            />
          </div>
        );
      })}
      <div>
        <AddButton
          label={path ? `Add field to ${path}` : "Add field"}
          disabled={atMost}
          onClick={() =>
            replace([...entries, [uniqueGraphKey("field", names), { type: "string" }]])
          }
        />
      </div>
    </div>
  );
}

/** The subset checker's verdict on `schema`, with paths. */
export function GraphSchemaIssues({ schema }: { schema: unknown }) {
  const result = validateGraphSchemaSubset(schema);
  if (result.ok) {
    return (
      <p data-graph-schema-valid="" className="text-[11px] text-muted-foreground">
        The schema is inside the portable subset.
      </p>
    );
  }
  return (
    <ul role="alert" data-graph-schema-errors="" className="flex flex-col gap-0.5 text-[11px]">
      {result.errors.map((error, index) => (
        <li key={`${error.path}:${index}`}>
          <span className="font-mono text-muted-foreground">{error.path}</span>{" "}
          <span className="text-failure">{error.message}</span>
        </li>
      ))}
      {result.omittedErrors > 0 ? (
        <li className="text-muted-foreground">{result.omittedErrors} more not shown.</li>
      ) : null}
    </ul>
  );
}

export function GraphSchemaEditor({
  schema,
  onChange,
}: {
  schema: GraphJsonSchema;
  onChange: (next: GraphJsonSchema) => void;
}) {
  const [asJson, setAsJson] = useState(false);
  const rootIsObject = schema.type === "object" && isRecord(schema.properties);
  const json = asJson || !rootIsObject;
  return (
    <div className="flex flex-col gap-2" data-graph-schema-editor="">
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground">
          {json
            ? "Schema JSON"
            : "Fields (every field is required; tick “May be null” to make one optional)"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className={cn("ml-auto h-6 px-1.5 text-[11px]")}
          aria-pressed={json}
          disabled={!rootIsObject && !asJson}
          onClick={() => setAsJson((value) => !value)}
        >
          {json ? "Edit as form" : "Edit as JSON"}
        </Button>
      </div>
      {json ? (
        <JsonField
          label="Schema"
          value={schema}
          rows={10}
          validate={(value) => (isRecord(value) ? null : "A schema is a JSON object")}
          onCommit={(value) => onChange(value as GraphJsonSchema)}
        />
      ) : (
        <>
          <TextField
            label="Type description"
            value={typeof schema.description === "string" ? schema.description : ""}
            onChange={(value) => {
              const next = { ...schema };
              if (value) next.description = value;
              else delete next.description;
              onChange(next);
            }}
          />
          <ObjectProperties object={schema} path="" objectDepth={1} onChange={onChange} />
        </>
      )}
      <GraphSchemaIssues schema={schema} />
    </div>
  );
}
