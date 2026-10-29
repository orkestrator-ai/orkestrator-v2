import { useMemo, useState } from "react";
import type { GraphJsonSchema } from "@orkestrator/protocol/graphs/artifact-type-def";
import {
  validateGraphArtifactValue,
  type GraphTypeDefinition,
} from "@orkestrator/protocol/graphs/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  CheckboxField,
  NumberField,
  SelectField,
  TextField,
} from "@/components/graph-designer/graph-form-controls";

/**
 * Edits an artifact value at a human node's `edit` form (item 208): through
 * the type's form when its schema is a flat object the form can express
 * (strings, enums, numbers, booleans and lists of strings, each optionally
 * nullable), or as JSON otherwise; JSON is always one click away. The value
 * is checked live with the same validator the backend runs when it stores
 * the edit (`validateGraphArtifactValue`: budgets, schema, domain checks), so
 * the person sees why an approval would be refused before sending it. The
 * backend checks again; this is guidance, never the authority.
 */

export interface GraphArtifactEditState {
  value: unknown;
  /** Why the value cannot be sent: a JSON syntax error or the type's issues. */
  problem: string | null;
}

type FieldKind =
  | { kind: "string"; multiline: boolean }
  | { kind: "enum"; options: string[] }
  | { kind: "number"; integer: boolean }
  | { kind: "boolean" }
  | { kind: "string-list" };

interface FormField {
  name: string;
  label: string;
  nullable: boolean;
  field: FieldKind;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value's own schema and whether it is nullable (`anyOf: [schema, {type: "null"}]`). */
function unwrapNullable(schema: GraphJsonSchema): { inner: GraphJsonSchema; nullable: boolean } {
  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf) && anyOf.length === 2) {
    const other = anyOf.find((entry) => !(isRecord(entry) && entry.type === "null"));
    if (
      other &&
      isRecord(other) &&
      anyOf.some((entry) => isRecord(entry) && entry.type === "null")
    ) {
      return { inner: other as GraphJsonSchema, nullable: true };
    }
  }
  return { inner: schema, nullable: false };
}

function fieldKind(schema: GraphJsonSchema): FieldKind | null {
  if (Array.isArray(schema.enum) && schema.enum.every((entry) => typeof entry === "string")) {
    return { kind: "enum", options: schema.enum as string[] };
  }
  switch (schema.type) {
    case "string":
      return {
        kind: "string",
        multiline: typeof schema.maxLength !== "number" || schema.maxLength > 200,
      };
    case "number":
    case "integer":
      return { kind: "number", integer: schema.type === "integer" };
    case "boolean":
      return { kind: "boolean" };
    case "array":
      return isRecord(schema.items) && (schema.items as GraphJsonSchema).type === "string"
        ? { kind: "string-list" }
        : null;
    default:
      return null;
  }
}

/** The form for a flat object schema, or null when the form cannot express it. */
export function graphArtifactFormFields(schema: GraphJsonSchema): FormField[] | null {
  if (schema.type !== "object" || !isRecord(schema.properties)) return null;
  const fields: FormField[] = [];
  for (const [name, property] of Object.entries(schema.properties)) {
    if (!isRecord(property)) return null;
    const { inner, nullable } = unwrapNullable(property as GraphJsonSchema);
    const field = fieldKind(inner);
    if (!field) return null;
    const title = (property as GraphJsonSchema).title;
    fields.push({ name, label: typeof title === "string" ? title : name, nullable, field });
  }
  return fields.length > 0 ? fields : null;
}

function issuesText(
  definition: GraphTypeDefinition,
  value: unknown,
  choices: readonly string[] | undefined,
): string | null {
  const issues = validateGraphArtifactValue(definition, value, choices ? { choices } : {});
  if (issues.length === 0) return null;
  return issues
    .slice(0, 5)
    .map((issue) => `${issue.path || "value"}: ${issue.message}`)
    .join("; ");
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "null";
}

export function GraphArtifactValueEditor({
  definition,
  initial,
  choices,
  disabled = false,
  onChange,
}: {
  definition: GraphTypeDefinition;
  initial: unknown;
  /** `decision@1`: the producing port's choices. */
  choices?: readonly string[];
  disabled?: boolean;
  onChange: (state: GraphArtifactEditState) => void;
}) {
  const fields = useMemo(() => graphArtifactFormFields(definition.schema), [definition.schema]);
  const formable = fields !== null && isRecord(initial);
  const [mode, setMode] = useState<"form" | "json">(formable ? "form" : "json");
  const [value, setValue] = useState<unknown>(initial);
  const [json, setJson] = useState(() => pretty(initial));
  const [problem, setProblem] = useState<string | null>(null);

  const publish = (next: unknown, syntax: string | null) => {
    const found = syntax ?? issuesText(definition, next, choices);
    setProblem(found);
    onChange({ value: next, problem: found });
  };

  const setField = (name: string, next: unknown) => {
    const updated = { ...(isRecord(value) ? value : {}), [name]: next };
    setValue(updated);
    setJson(pretty(updated));
    publish(updated, null);
  };

  const onJson = (text: string) => {
    setJson(text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      publish(value, `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    setValue(parsed);
    publish(parsed, null);
  };

  const record = isRecord(value) ? value : {};
  return (
    <div className="flex min-w-0 flex-col gap-2" data-graph-edit-form={definition.ref}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          Edit <span className="font-mono">{definition.ref}</span>
        </span>
        {formable ? (
          <div className="flex gap-1" role="group" aria-label="Edit as">
            <Button
              type="button"
              size="sm"
              variant={mode === "form" ? "default" : "outline"}
              className="h-6 px-2 text-xs"
              aria-pressed={mode === "form"}
              disabled={disabled || !isRecord(value)}
              onClick={() => setMode("form")}
            >
              Form
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === "json" ? "default" : "outline"}
              className="h-6 px-2 text-xs"
              aria-pressed={mode === "json"}
              disabled={disabled}
              onClick={() => setMode("json")}
            >
              JSON
            </Button>
          </div>
        ) : null}
      </div>
      {mode === "form" && fields && isRecord(value) ? (
        <div className="flex flex-col gap-2">
          {fields.map(({ name, label, nullable, field }) => {
            const current = record[name];
            switch (field.kind) {
              case "string":
                return (
                  <TextField
                    key={name}
                    label={label}
                    value={typeof current === "string" ? current : ""}
                    multiline={field.multiline}
                    disabled={disabled}
                    onChange={(text) => setField(name, nullable && text === "" ? null : text)}
                  />
                );
              case "enum":
                return (
                  <SelectField
                    key={name}
                    label={label}
                    value={typeof current === "string" ? current : ""}
                    options={field.options.map((option) => ({ value: option, label: option }))}
                    disabled={disabled}
                    onChange={(next) => setField(name, next)}
                  />
                );
              case "number":
                return (
                  <NumberField
                    key={name}
                    label={label}
                    value={typeof current === "number" ? current : undefined}
                    integer={field.integer}
                    optional={nullable}
                    disabled={disabled}
                    onCommit={(next) => setField(name, next ?? null)}
                  />
                );
              case "boolean":
                return (
                  <CheckboxField
                    key={name}
                    label={label}
                    checked={current === true}
                    disabled={disabled}
                    onChange={(checked) => setField(name, checked)}
                  />
                );
              case "string-list":
                return (
                  <TextField
                    key={name}
                    label={`${label} (one per line)`}
                    value={Array.isArray(current) ? current.map(String).join("\n") : ""}
                    multiline
                    disabled={disabled}
                    onChange={(text) =>
                      setField(
                        name,
                        text === "" && nullable
                          ? null
                          : text
                              .split("\n")
                              .map((line) => line.trim())
                              .filter(Boolean),
                      )
                    }
                  />
                );
            }
          })}
        </div>
      ) : (
        <Textarea
          value={json}
          onChange={(event) => onJson(event.target.value)}
          rows={10}
          disabled={disabled}
          spellCheck={false}
          aria-label={`${definition.ref} as JSON`}
          className="min-h-0 resize-y font-mono text-xs"
        />
      )}
      {problem ? (
        <p role="alert" className="text-xs break-words text-failure" data-graph-edit-problem="">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
