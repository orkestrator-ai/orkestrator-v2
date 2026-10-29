import { useId, useState } from "react";
import {
  GRAPH_TEMPLATE_BOUNDS,
  graphUtf8Bytes,
  isGraphKey,
} from "@orkestrator/protocol/graphs/grammar";
import {
  checkGraphSystemParams,
  GRAPH_SYSTEM_ACTION_SPECS,
  type GraphSystemParamIssue,
  type GraphSystemParamSpec,
} from "@orkestrator/protocol/graphs/system-actions";
import type {
  GraphSystemAction,
  GraphSystemNode,
  GraphSystemParamValue,
} from "@orkestrator/protocol/graphs/template";
import { cn } from "@/lib/utils";
import {
  graphSystemParamBoundsHint,
  graphSystemParamDefaultLabel,
} from "./graph-designer-system-actions";
import { useGraphNodeEdit } from "./graph-editor-context";
import {
  CommitField,
  EntryCard,
  FIELD_CLASS,
  FormSection,
  JsonField,
  RemoveButton,
  SelectField,
} from "./graph-form-controls";

/**
 * A system node's parameters (items 207, 212): one typed field per parameter
 * the action's spec lists (a yes/no or option select, a whole number within
 * its range, a branch, id or free text), each with its default, bounds and
 * description. The messages are `checkGraphSystemParams`'s, the very ones the
 * compiler reports as `system-param-invalid`: a field refuses a value of the
 * wrong type, range or format, and the form shows what the stored parameters
 * break (required, conflicting or unknown keys). Clearing a field drops the
 * key, so the action's default applies. The JSON fallback edits the whole
 * object within the template's bounds (101).
 */

const B = GRAPH_TEMPLATE_BOUNDS;

/** Free text that may be longer than this edits in a text area. */
const SHORT_TEXT_CHARS = 200;

function fitsTemplate(text: string): boolean {
  return graphUtf8Bytes(text) <= B.maxSystemParamStringBytes;
}

/** Why `value` is not a params object the template accepts, or null. */
export function graphSystemParamsProblem(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "Params are an object of key → value";
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > B.maxSystemParams) return `At most ${B.maxSystemParams} params`;
  const scalar = (entry: unknown) =>
    entry === null ||
    typeof entry === "boolean" ||
    (typeof entry === "number" && Number.isFinite(entry)) ||
    (typeof entry === "string" && fitsTemplate(entry));
  for (const [key, entry] of entries) {
    if (!isGraphKey(key)) {
      return `${key} is not an identifier (letters, digits, _; starting lower-case)`;
    }
    if (Array.isArray(entry)) {
      if (entry.length > B.maxSystemParamListItems) {
        return `${key} lists at most ${B.maxSystemParamListItems} values`;
      }
      if (!entry.every(scalar)) return `${key} lists only text, numbers, yes/no or null`;
    } else if (!scalar(entry)) {
      return `${key} must be text (at most ${B.maxSystemParamStringBytes} bytes), a number, yes/no, null or a list`;
    }
  }
  return null;
}

/**
 * What is wrong with one value of one parameter on its own (its type, range
 * or format), in the compiler's words; null when nothing is.
 */
export function graphSystemParamValueIssue(
  action: GraphSystemAction,
  key: string,
  value: GraphSystemParamValue,
): GraphSystemParamIssue | null {
  return (
    checkGraphSystemParams(action, { [key]: value }).find(
      (issue) =>
        issue.param === key &&
        (issue.code === "type" || issue.code === "range" || issue.code === "format"),
    ) ?? null
  );
}

/** A stored value as a field shows it. */
function displayText(value: GraphSystemParamValue | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

type ParamChange = (value: GraphSystemParamValue | undefined, coalesce?: boolean) => void;

/** Free text, committed as typed while it stays within the template's bound. */
function ParamTextField({
  label,
  value,
  multiline,
  hint,
  onChange,
}: {
  label: string;
  value: string;
  multiline: boolean;
  hint: string;
  onChange: (text: string) => void;
}) {
  const id = useId();
  const [text, setText] = useState(value);
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    // Changed elsewhere (undo, the JSON view): show the stored value.
    setLastValue(value);
    setText(value);
  }
  const tooLong = !fitsTemplate(text);
  const change = (next: string) => {
    setText(next);
    if (fitsTemplate(next)) {
      setLastValue(next);
      onChange(next);
    }
  };
  const props = {
    id,
    value: text,
    "aria-invalid": tooLong ? true : undefined,
    onChange: (event: { target: { value: string } }) => change(event.target.value),
  };
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-[11px] text-muted-foreground">
        {label}
      </label>
      {multiline ? (
        <textarea
          {...props}
          rows={3}
          className={cn(FIELD_CLASS, "h-auto resize-y py-1 leading-4")}
        />
      ) : (
        <input {...props} className={FIELD_CLASS} />
      )}
      {tooLong ? (
        <p className="text-[11px] text-failure" role="alert">
          A template parameter holds at most {B.maxSystemParamStringBytes} bytes; this is not saved.
        </p>
      ) : (
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

function ParamControl({
  action,
  name,
  spec,
  value,
  hint,
  onChange,
}: {
  action: GraphSystemAction;
  name: string;
  spec: GraphSystemParamSpec;
  value: GraphSystemParamValue | undefined;
  hint: string;
  onChange: ParamChange;
}) {
  const unset = { value: "", label: graphSystemParamDefaultLabel(spec) };
  switch (spec.type) {
    case "boolean":
      return (
        <SelectField
          label={name}
          value={typeof value === "boolean" ? String(value) : displayText(value)}
          options={[unset, { value: "true", label: "Yes" }, { value: "false", label: "No" }]}
          hint={hint}
          onChange={(next) => onChange(next === "" ? undefined : next === "true")}
        />
      );
    case "enum":
      return (
        <SelectField
          label={name}
          value={displayText(value)}
          options={[unset, ...spec.options.map((option) => ({ value: option, label: option }))]}
          hint={hint}
          onChange={(next) => onChange(next === "" ? undefined : next)}
        />
      );
    case "integer":
      return (
        <CommitField
          label={name}
          value={displayText(value)}
          placeholder={spec.default === undefined ? undefined : String(spec.default)}
          hint={hint}
          validate={(text) => {
            if (text.trim() === "") return null;
            const number = Number(text);
            const candidate = Number.isFinite(number) ? number : text;
            return graphSystemParamValueIssue(action, name, candidate)?.message ?? null;
          }}
          onCommit={(text) => onChange(text.trim() === "" ? undefined : Number(text))}
        />
      );
    case "string":
      if (spec.format === "text") {
        return (
          <ParamTextField
            label={name}
            value={displayText(value)}
            multiline={spec.maxChars > SHORT_TEXT_CHARS}
            hint={hint}
            onChange={(text) => onChange(text === "" ? undefined : text, true)}
          />
        );
      }
      return (
        <CommitField
          label={name}
          value={displayText(value)}
          hint={hint}
          validate={(text) =>
            text === "" ? null : (graphSystemParamValueIssue(action, name, text)?.message ?? null)
          }
          onCommit={(text) => onChange(text === "" ? undefined : text)}
        />
      );
  }
}

function IssueList({ issues }: { issues: readonly GraphSystemParamIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5">
      {issues.map((issue, index) => (
        <li key={index} data-graph-param-issue={issue.code} className="text-[11px] text-failure">
          {issue.message}
        </li>
      ))}
    </ul>
  );
}

export function GraphSystemParamsEditor({ node }: { node: GraphSystemNode }) {
  const editNode = useGraphNodeEdit(node.id);
  const [json, setJson] = useState(false);
  const spec = GRAPH_SYSTEM_ACTION_SPECS[node.action];
  const params = node.params ?? {};
  const issues = checkGraphSystemParams(node.action, params);
  const issuesOf = (key: string) => issues.filter((issue) => issue.param === key);
  const specKeys = Object.keys(spec.params);
  const extraKeys = Object.keys(params).filter((key) => !(key in spec.params));

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
  const setParam = (key: string, value: GraphSystemParamValue | undefined, coalesce?: boolean) => {
    const next = { ...params };
    if (value === undefined) delete next[key];
    else next[key] = value;
    setParams(
      value === undefined ? `Clear param ${key}` : `Edit param ${key}`,
      next,
      coalesce ? `param:${key}` : undefined,
    );
  };

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
        <div className="flex flex-col gap-1.5">
          <JsonField
            label="Params (JSON)"
            value={params}
            validate={graphSystemParamsProblem}
            onCommit={(value) =>
              setParams("Edit params", value as Record<string, GraphSystemParamValue>)
            }
          />
          <div data-graph-system-param-issues="">
            <IssueList issues={issues} />
          </div>
        </div>
      ) : (
        <div data-graph-system-params="" className="flex flex-col gap-2">
          {specKeys.length === 0 && extraKeys.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">{spec.label} takes no params.</p>
          ) : null}
          <div data-graph-system-param-issues="">
            <IssueList issues={issues.filter((issue) => issue.param === undefined)} />
          </div>
          {specKeys.map((key) => {
            const paramSpec = spec.params[key]!;
            const bounds = graphSystemParamBoundsHint(paramSpec);
            return (
              <div key={key} data-graph-system-param={key} className="flex flex-col gap-0.5">
                <ParamControl
                  action={node.action}
                  name={key}
                  spec={paramSpec}
                  value={params[key]}
                  hint={bounds ? `${paramSpec.description} (${bounds})` : paramSpec.description}
                  onChange={(value, coalesce) => setParam(key, value, coalesce)}
                />
                <IssueList issues={issuesOf(key)} />
              </div>
            );
          })}
          {extraKeys.map((key) => (
            <EntryCard key={key}>
              <div data-graph-system-param={key} className="flex items-start gap-1">
                <div className="min-w-0 flex-1">
                  <code className="font-mono text-[11px] text-foreground">{key}</code>
                  <span className="ml-1.5 font-mono text-[11px] break-all text-muted-foreground">
                    {JSON.stringify(params[key])}
                  </span>
                  <IssueList issues={issuesOf(key)} />
                </div>
                <RemoveButton
                  label={`Remove param ${key}`}
                  onClick={() => setParam(key, undefined)}
                />
              </div>
            </EntryCard>
          ))}
        </div>
      )}
    </FormSection>
  );
}
