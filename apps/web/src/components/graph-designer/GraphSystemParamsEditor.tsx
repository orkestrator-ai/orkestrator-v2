import { useId, useState } from "react";
import { graphUtf8Bytes, isGraphKey } from "@orkestrator/protocol/graphs/grammar";
import type {
  GraphScalarValue,
  GraphSystemNode,
  GraphSystemParamValue,
} from "@orkestrator/protocol/graphs/template";
import { cn } from "@/lib/utils";
import { uniqueGraphKey } from "./graph-designer-edits";
import {
  GRAPH_SYSTEM_ACTION_CATALOGUE,
  GRAPH_SYSTEM_PARAM_BOUNDS,
  graphSystemParamKind,
  type GraphSystemParamKind,
} from "./graph-designer-system-actions";
import { useGraphNodeEdit } from "./graph-editor-context";
import {
  AddButton,
  CommitField,
  EntryCard,
  FIELD_CLASS,
  FormSection,
  JsonField,
  NumberField,
  RemoveButton,
} from "./graph-form-controls";

/**
 * A system node's params (item 212). The template allows up to 16 keys
 * (identifiers), each a scalar or a list of scalars, with bounded strings and
 * lists; per-action rules belong to the action's executor (item 207). The
 * editor offers the fields the action catalogue knows, accepts any other key
 * within the bounds, and has a JSON fallback for the whole object.
 */

const KIND_LABELS: Readonly<Record<GraphSystemParamKind, string>> = {
  string: "Text",
  number: "Number",
  boolean: "Yes/no",
  "string-list": "List of text",
};

function convert(value: GraphSystemParamValue, kind: GraphSystemParamKind): GraphSystemParamValue {
  switch (kind) {
    case "string":
      return Array.isArray(value)
        ? value.map(String).join(", ")
        : value === null
          ? ""
          : String(value);
    case "number": {
      const number = Number(Array.isArray(value) ? value[0] : value);
      return Number.isFinite(number) ? number : 0;
    }
    case "boolean":
      return value === true || value === "true";
    case "string-list":
      return Array.isArray(value) ? value : value === null || value === "" ? [] : [String(value)];
  }
}

function fitsString(text: string): boolean {
  return graphUtf8Bytes(text) <= GRAPH_SYSTEM_PARAM_BOUNDS.maxStringBytes;
}

/** Why `value` is not a params object the template accepts, or null. */
export function graphSystemParamsProblem(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "Params are an object of key → value";
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > GRAPH_SYSTEM_PARAM_BOUNDS.maxParams) {
    return `At most ${GRAPH_SYSTEM_PARAM_BOUNDS.maxParams} params`;
  }
  const scalar = (entry: unknown) =>
    entry === null ||
    typeof entry === "boolean" ||
    (typeof entry === "number" && Number.isFinite(entry)) ||
    (typeof entry === "string" && fitsString(entry));
  for (const [key, entry] of entries) {
    if (!isGraphKey(key))
      return `${key} is not an identifier (letters, digits, _; starting lower-case)`;
    if (Array.isArray(entry)) {
      if (entry.length > GRAPH_SYSTEM_PARAM_BOUNDS.maxListItems) {
        return `${key} lists at most ${GRAPH_SYSTEM_PARAM_BOUNDS.maxListItems} values`;
      }
      if (!entry.every(scalar)) return `${key} lists only text, numbers, yes/no or null`;
    } else if (!scalar(entry)) {
      return `${key} must be text (at most ${GRAPH_SYSTEM_PARAM_BOUNDS.maxStringBytes} bytes), a number, yes/no, null or a list`;
    }
  }
  return null;
}

function ParamValue({
  name,
  value,
  options,
  onChange,
}: {
  name: string;
  value: GraphSystemParamValue;
  options?: readonly string[];
  onChange: (value: GraphSystemParamValue, coalesce: boolean) => void;
}) {
  const listId = useId();
  const kind = graphSystemParamKind(value);
  if (kind === "boolean") {
    return (
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          aria-label={`${name} value`}
          checked={value === true}
          onChange={(event) => onChange(event.target.checked, false)}
          className="size-3.5 accent-primary"
        />
        {value === true ? "Yes" : "No"}
      </label>
    );
  }
  if (kind === "number") {
    return (
      <NumberField
        label={`${name} value`}
        value={typeof value === "number" ? value : undefined}
        integer={false}
        onCommit={(next) => onChange(next ?? 0, false)}
      />
    );
  }
  if (kind === "string-list") {
    const items = (value as GraphScalarValue[]).map((item) => (item === null ? "" : String(item)));
    return (
      <textarea
        aria-label={`${name} values, one per line`}
        rows={Math.min(6, Math.max(2, items.length + 1))}
        value={items.join("\n")}
        onChange={(event) => {
          const lines = event.target.value
            .split("\n")
            .slice(0, GRAPH_SYSTEM_PARAM_BOUNDS.maxListItems);
          if (lines.every(fitsString)) onChange(lines, true);
        }}
        className={cn(FIELD_CLASS, "h-auto resize-y py-1 font-mono text-[11px] leading-4")}
      />
    );
  }
  return (
    <>
      <input
        aria-label={`${name} value`}
        value={value === null ? "" : String(value)}
        list={options ? listId : undefined}
        onChange={(event) => {
          if (fitsString(event.target.value)) onChange(event.target.value, true);
        }}
        className={cn(FIELD_CLASS, "font-mono text-[11px]")}
      />
      {options ? (
        <datalist id={listId}>
          {options.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      ) : null}
    </>
  );
}

export function GraphSystemParamsEditor({ node }: { node: GraphSystemNode }) {
  const editNode = useGraphNodeEdit(node.id);
  const [json, setJson] = useState(false);
  const params = node.params ?? {};
  const keys = Object.keys(params);
  const known = GRAPH_SYSTEM_ACTION_CATALOGUE[node.action].params;
  const full = keys.length >= GRAPH_SYSTEM_PARAM_BOUNDS.maxParams;

  const setParams = (
    label: string,
    next: Record<string, GraphSystemParamValue>,
    coalesce?: string,
  ) =>
    editNode<GraphSystemNode>(
      label,
      (current) => {
        const copy = { ...current };
        if (Object.keys(next).length === 0) delete copy.params;
        else copy.params = next;
        return copy;
      },
      coalesce,
    );

  const rename = (from: string, to: string) =>
    setParams(
      `Rename param ${from}`,
      Object.fromEntries(
        Object.entries(params).map(([key, value]) => [key === from ? to : key, value]),
      ),
    );

  return (
    <FormSection
      title="Params"
      actions={
        <button
          type="button"
          aria-pressed={json}
          onClick={() => setJson(!json)}
          className="rounded px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
        >
          {json ? "Form" : "JSON"}
        </button>
      }
    >
      {json ? (
        <JsonField
          label="Params (JSON)"
          value={params}
          validate={graphSystemParamsProblem}
          onCommit={(value) =>
            setParams("Edit params", value as Record<string, GraphSystemParamValue>)
          }
        />
      ) : (
        <div data-graph-system-params="" className="flex flex-col gap-1.5">
          {keys.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">No params.</p>
          ) : null}
          {keys.map((key) => {
            const value = params[key]!;
            const field = known.find((entry) => entry.key === key);
            return (
              <EntryCard key={key}>
                <div className="flex items-end gap-1">
                  <div className="min-w-0 flex-1">
                    <CommitField
                      label="Key"
                      value={key}
                      validate={(text) =>
                        !isGraphKey(text)
                          ? "An identifier: a lower-case letter, then letters, digits or _"
                          : text !== key && text in params
                            ? `${text} is already set`
                            : null
                      }
                      onCommit={(text) => rename(key, text)}
                    />
                  </div>
                  <select
                    aria-label={`${key} kind`}
                    value={graphSystemParamKind(value)}
                    onChange={(event) =>
                      setParams(`Change ${key} kind`, {
                        ...params,
                        [key]: convert(value, event.target.value as GraphSystemParamKind),
                      })
                    }
                    className={cn(FIELD_CLASS, "w-auto")}
                  >
                    {(Object.keys(KIND_LABELS) as GraphSystemParamKind[]).map((kind) => (
                      <option key={kind} value={kind}>
                        {KIND_LABELS[kind]}
                      </option>
                    ))}
                  </select>
                  <RemoveButton
                    label={`Remove param ${key}`}
                    onClick={() => {
                      const next = { ...params };
                      delete next[key];
                      setParams(`Remove param ${key}`, next);
                    }}
                  />
                </div>
                <ParamValue
                  name={key}
                  value={value}
                  {...(field?.options ? { options: field.options } : {})}
                  onChange={(next, coalesce) =>
                    setParams(
                      `Edit param ${key}`,
                      { ...params, [key]: next },
                      coalesce ? `param:${key}` : undefined,
                    )
                  }
                />
                {field ? (
                  <p className="text-[11px] text-muted-foreground">{field.description}</p>
                ) : null}
              </EntryCard>
            );
          })}
          <div className="flex flex-wrap items-center gap-1">
            {known
              .filter((field) => !(field.key in params))
              .map((field) => (
                <AddButton
                  key={field.key}
                  label={field.label}
                  disabled={full}
                  onClick={() =>
                    setParams(`Add param ${field.key}`, {
                      ...params,
                      [field.key]: convert(field.options?.[0] ?? "", field.kind),
                    })
                  }
                />
              ))}
            <AddButton
              label="Param"
              disabled={full}
              onClick={() =>
                setParams("Add param", { ...params, [uniqueGraphKey("param", keys)]: "" })
              }
            />
          </div>
        </div>
      )}
    </FormSection>
  );
}
