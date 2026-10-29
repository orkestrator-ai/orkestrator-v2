import { useId, useMemo, useState } from "react";
import { Braces, ListTree } from "lucide-react";
import {
  GRAPH_PREDICATE_COMPARISONS,
  GRAPH_PREDICATE_EQUALITY_OPS,
  GRAPH_PREDICATE_OPS,
  GRAPH_PREDICATE_ORDER_OPS,
  typeCheckGraphPredicate,
  validateGraphPredicate,
  type GraphLeafPredicate,
  type GraphPredicate,
  type GraphPredicateComparison,
  type GraphPredicateOp,
  type GraphPredicateScalar,
  type GraphPredicateScope,
} from "@orkestrator/protocol/graphs/predicates";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AddButton, FIELD_CLASS, JsonField, RemoveButton } from "./graph-form-controls";
import { graphPredicatePathSuggestions } from "./graph-designer-scopes";

/**
 * The predicate builder (item 212, report §4.4, item 104): a node's `when`, a
 * gate branch, a loop's `until`. Leaf rows pick a path (autocompleted from the
 * scope's schemas), an operator and a value of the operator's shape;
 * `all`/`any`/`not` rows group them. Anything the form does not cover can be
 * written as JSON. Type problems (a path the producer's schema lacks, an
 * operator that does not fit the field) show live under the editor; the
 * compiler reports the same ones.
 */

/** Predicates nest at most 8 levels (grammar `maxPredicateDepth`); groups stop one short. */
const MAX_GROUP_DEPTH = 7;

const OP_LABELS: Readonly<Record<GraphPredicateOp, string>> = {
  eq: "equals",
  neq: "does not equal",
  lt: "<",
  lte: "≤",
  gt: ">",
  gte: "≥",
  in: "is one of",
  exists: "exists",
  empty: "is empty",
  nonEmpty: "is not empty",
  count: "count",
};

type Combinator = "all" | "any" | "not";

function combinatorOf(predicate: GraphPredicate): Combinator | null {
  if ("all" in predicate) return "all";
  if ("any" in predicate) return "any";
  if ("not" in predicate) return "not";
  return null;
}

function childrenOf(predicate: GraphPredicate): GraphPredicate[] {
  if ("all" in predicate) return predicate.all;
  if ("any" in predicate) return predicate.any;
  if ("not" in predicate) return [predicate.not];
  return [];
}

function withChildren(
  kind: Combinator,
  children: GraphPredicate[],
  fallback: GraphPredicate,
): GraphPredicate {
  if (kind === "not") return { not: children[0] ?? fallback };
  return kind === "all" ? { all: children } : { any: children };
}

/** Scalar text: `true`, `false`, `null` and numbers parse as such; quotes force a string. */
export function parseGraphPredicateScalar(text: string): GraphPredicateScalar {
  const trimmed = text.trim();
  if (trimmed.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Not closed yet: keep the raw text.
    }
    return text;
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (trimmed !== "" && Number.isFinite(Number(trimmed))) return Number(trimmed);
  return text;
}

export function formatGraphPredicateScalar(value: GraphPredicateScalar): string {
  if (typeof value !== "string") return String(value);
  return parseGraphPredicateScalar(value) === value ? value : JSON.stringify(value);
}

function parseList(text: string): GraphPredicateScalar[] | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) return null;
      return parsed.every(
        (entry) => entry === null || ["string", "number", "boolean"].includes(typeof entry),
      )
        ? (parsed as GraphPredicateScalar[])
        : null;
    } catch {
      return null;
    }
  }
  if (trimmed === "") return [];
  return trimmed.split(",").map((part) => parseGraphPredicateScalar(part.trim()));
}

function formatList(values: GraphPredicateScalar[]): string {
  return values.map(formatGraphPredicateScalar).join(", ");
}

/** A leaf with `op`, keeping the path and as much of the value as still fits. */
function changeOp(leaf: GraphLeafPredicate, op: GraphPredicateOp): GraphLeafPredicate {
  const path = leaf.path;
  const scalar: GraphPredicateScalar =
    "value" in leaf && !Array.isArray(leaf.value) ? (leaf.value as GraphPredicateScalar) : "";
  if ((GRAPH_PREDICATE_EQUALITY_OPS as readonly string[]).includes(op)) {
    return { path, op: op as "eq" | "neq", value: leaf.op === "count" ? leaf.value : scalar };
  }
  if ((GRAPH_PREDICATE_ORDER_OPS as readonly string[]).includes(op)) {
    return { path, op: op as "lt", value: typeof scalar === "number" ? scalar : 0 };
  }
  if (op === "in")
    return { path, op, value: leaf.op === "in" ? leaf.value : scalar === "" ? [] : [scalar] };
  if (op === "count")
    return { path, op, compare: "gte", value: typeof scalar === "number" ? scalar : 1 };
  return { path, op: op as "exists" };
}

/** Text typed into a value box, committed whenever it parses; resynced when the value changes elsewhere. */
function ValueInput<T>({
  label,
  value,
  format,
  parse,
  onCommit,
  placeholder,
}: {
  label: string;
  value: T;
  format: (value: T) => string;
  parse: (text: string) => T | null;
  onCommit: (value: T) => void;
  placeholder?: string;
}) {
  const key = JSON.stringify(value);
  const [text, setText] = useState(() => format(value));
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    setText(format(value));
  }
  return (
    <input
      aria-label={label}
      value={text}
      placeholder={placeholder}
      onChange={(event) => {
        setText(event.target.value);
        const parsed = parse(event.target.value);
        if (parsed === null) return;
        setLastKey(JSON.stringify(parsed));
        onCommit(parsed);
      }}
      className={cn(FIELD_CLASS, "font-mono text-[11px]")}
    />
  );
}

function LeafRow({
  leaf,
  onChange,
  suggestionsId,
}: {
  leaf: GraphLeafPredicate;
  onChange: (next: GraphLeafPredicate) => void;
  suggestionsId: string;
}) {
  return (
    <div data-graph-predicate-leaf="" className="flex min-w-0 flex-wrap items-center gap-1">
      <input
        aria-label="Path"
        value={leaf.path}
        list={suggestionsId}
        placeholder="report.issues"
        onChange={(event) => onChange({ ...leaf, path: event.target.value })}
        className={cn(FIELD_CLASS, "w-auto min-w-28 flex-1 font-mono text-[11px]")}
      />
      <select
        aria-label="Operator"
        value={leaf.op}
        onChange={(event) => onChange(changeOp(leaf, event.target.value as GraphPredicateOp))}
        className={cn(FIELD_CLASS, "w-auto")}
      >
        {GRAPH_PREDICATE_OPS.map((op) => (
          <option key={op} value={op}>
            {OP_LABELS[op]}
          </option>
        ))}
      </select>
      {leaf.op === "eq" || leaf.op === "neq" ? (
        <div className="min-w-20 flex-1">
          <ValueInput
            label="Value"
            value={leaf.value}
            format={formatGraphPredicateScalar}
            parse={parseGraphPredicateScalar}
            onCommit={(value) => onChange({ ...leaf, value })}
            placeholder="true, 3, text"
          />
        </div>
      ) : null}
      {(GRAPH_PREDICATE_ORDER_OPS as readonly string[]).includes(leaf.op) ? (
        <div className="min-w-16 flex-1">
          <ValueInput
            label="Value"
            value={(leaf as { value: number }).value}
            format={String}
            parse={(text) =>
              text.trim() !== "" && Number.isFinite(Number(text)) ? Number(text) : null
            }
            onCommit={(value) => onChange({ ...leaf, value } as GraphLeafPredicate)}
          />
        </div>
      ) : null}
      {leaf.op === "in" ? (
        <div className="min-w-24 flex-1">
          <ValueInput
            label="Values"
            value={leaf.value}
            format={formatList}
            parse={parseList}
            onCommit={(value) => onChange({ ...leaf, value })}
            placeholder="a, b, c"
          />
        </div>
      ) : null}
      {leaf.op === "count" ? (
        <>
          <select
            aria-label="Comparison"
            value={leaf.compare}
            onChange={(event) =>
              onChange({ ...leaf, compare: event.target.value as GraphPredicateComparison })
            }
            className={cn(FIELD_CLASS, "w-auto")}
          >
            {GRAPH_PREDICATE_COMPARISONS.map((op) => (
              <option key={op} value={op}>
                {OP_LABELS[op]}
              </option>
            ))}
          </select>
          <div className="w-16">
            <ValueInput
              label="Count"
              value={leaf.value}
              format={String}
              parse={(text) =>
                text.trim() !== "" && Number.isFinite(Number(text)) ? Number(text) : null
              }
              onCommit={(value) => onChange({ ...leaf, value })}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}

function PredicateNode({
  value,
  onChange,
  onRemove,
  depth,
  suggestionsId,
  newLeaf,
}: {
  value: GraphPredicate;
  onChange: (next: GraphPredicate) => void;
  onRemove?: () => void;
  depth: number;
  suggestionsId: string;
  newLeaf: () => GraphLeafPredicate;
}) {
  const kind = combinatorOf(value);
  const canGroup = depth < MAX_GROUP_DEPTH;
  if (kind === null) {
    const leaf = value as GraphLeafPredicate;
    return (
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1">
          <LeafRow leaf={leaf} onChange={onChange} suggestionsId={suggestionsId} />
        </div>
        {canGroup ? (
          <select
            aria-label="Wrap in a group"
            value=""
            onChange={(event) => {
              const wrap = event.target.value as Combinator;
              if (wrap) onChange(withChildren(wrap, [leaf], leaf));
            }}
            className={cn(FIELD_CLASS, "w-auto text-muted-foreground")}
          >
            <option value="">Group…</option>
            <option value="all">All of</option>
            <option value="any">Any of</option>
            <option value="not">Not</option>
          </select>
        ) : null}
        {onRemove ? <RemoveButton label="Remove this condition" onClick={onRemove} /> : null}
      </div>
    );
  }
  const children = childrenOf(value);
  const replace = (index: number, next: GraphPredicate) =>
    onChange(
      withChildren(
        kind,
        children.map((child, at) => (at === index ? next : child)),
        next,
      ),
    );
  const remove = (index: number) => {
    const rest = children.filter((_, at) => at !== index);
    // An emptied group collapses to its parent's removal, or to a single condition.
    if (rest.length === 0) {
      if (onRemove) onRemove();
      else onChange(newLeaf());
      return;
    }
    onChange(withChildren(kind, rest, rest[0]!));
  };
  return (
    <div
      data-graph-predicate-group={kind}
      className="flex flex-col gap-1 rounded-md border border-border/60 border-l-2 border-l-indigo-400/50 p-1.5"
    >
      <div className="flex items-center gap-1">
        <select
          aria-label="Group kind"
          value={kind}
          onChange={(event) =>
            onChange(
              withChildren(event.target.value as Combinator, children, children[0] ?? newLeaf()),
            )
          }
          className={cn(FIELD_CLASS, "w-auto")}
        >
          <option value="all">All of</option>
          <option value="any">Any of</option>
          <option value="not">Not</option>
        </select>
        {children.length === 1 && kind !== "not" ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[11px]"
            onClick={() => onChange(children[0]!)}
          >
            Ungroup
          </Button>
        ) : null}
        <div className="ml-auto flex items-center">
          {kind !== "not" ? (
            <>
              <AddButton
                label="Condition"
                onClick={() => onChange(withChildren(kind, [...children, newLeaf()], newLeaf()))}
              />
              {canGroup ? (
                <AddButton
                  label="Group"
                  onClick={() =>
                    onChange(withChildren(kind, [...children, { all: [newLeaf()] }], newLeaf()))
                  }
                />
              ) : null}
            </>
          ) : null}
          {onRemove ? <RemoveButton label="Remove this group" onClick={onRemove} /> : null}
        </div>
      </div>
      {children.map((child, index) => (
        <PredicateNode
          key={index}
          value={child}
          depth={depth + 1}
          suggestionsId={suggestionsId}
          newLeaf={newLeaf}
          onChange={(next) => replace(index, next)}
          {...(kind === "not" ? {} : { onRemove: () => remove(index) })}
        />
      ))}
    </div>
  );
}

export function GraphPredicateEditor({
  label,
  value,
  onChange,
  scope,
  optional = false,
}: {
  label: string;
  value: GraphPredicate | undefined;
  onChange: (next: GraphPredicate | undefined) => void;
  scope: GraphPredicateScope;
  /** Undefined means "always" (a node's `when`); the user can add and remove it. */
  optional?: boolean;
}) {
  const suggestionsId = useId();
  const [json, setJson] = useState(false);
  const suggestions = useMemo(() => graphPredicatePathSuggestions(scope), [scope]);
  const newLeaf = (): GraphLeafPredicate => ({
    path: suggestions[0]?.path ?? "run.iteration",
    op: "exists",
  });
  const problems = useMemo(() => {
    if (value === undefined) return [];
    const result = typeCheckGraphPredicate(value, scope);
    return result.ok ? [] : result.errors.slice(0, 8);
  }, [value, scope]);

  return (
    <div
      data-graph-predicate-editor=""
      className="flex min-w-0 flex-col gap-1.5"
      aria-label={label}
      role="group"
    >
      <div className="flex items-center gap-1">
        <span className="text-[11px] text-muted-foreground">{label}</span>
        <div className="ml-auto flex items-center gap-0.5">
          {value !== undefined ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11px]"
              aria-pressed={json}
              onClick={() => setJson(!json)}
            >
              {json ? <ListTree className="size-3" /> : <Braces className="size-3" />}
              {json ? "Form" : "JSON"}
            </Button>
          ) : null}
          {optional && value !== undefined ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-failure"
              onClick={() => onChange(undefined)}
            >
              Remove condition
            </Button>
          ) : null}
        </div>
      </div>
      <datalist id={suggestionsId}>
        {suggestions.map((suggestion) => (
          <option key={suggestion.path} value={suggestion.path}>
            {suggestion.type}
          </option>
        ))}
      </datalist>
      {value === undefined ? (
        optional ? (
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">Always.</span>
            <AddButton label="Add condition" onClick={() => onChange(newLeaf())} />
          </div>
        ) : (
          <AddButton label="Add condition" onClick={() => onChange(newLeaf())} />
        )
      ) : json ? (
        <JsonField
          label={`${label} (JSON)`}
          value={value}
          rows={6}
          validate={(parsed) => {
            const result = validateGraphPredicate(parsed);
            return result.ok
              ? null
              : result.errors.map((error) => `${error.path || "$"}: ${error.message}`).join("; ");
          }}
          onCommit={(parsed) => onChange(parsed as GraphPredicate)}
        />
      ) : (
        <PredicateNode
          value={value}
          onChange={onChange}
          depth={1}
          suggestionsId={suggestionsId}
          newLeaf={newLeaf}
          {...(optional ? { onRemove: () => onChange(undefined) } : {})}
        />
      )}
      {problems.length > 0 ? (
        <ul
          data-graph-predicate-problems=""
          className="flex flex-col gap-0.5 text-[11px] text-amber-300"
        >
          {problems.map((problem, index) => (
            <li key={`${problem.path}:${index}`}>
              {problem.path ? (
                <span className="font-mono text-muted-foreground">{problem.path} </span>
              ) : null}
              {problem.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
