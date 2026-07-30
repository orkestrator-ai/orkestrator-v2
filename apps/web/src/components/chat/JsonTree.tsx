/**
 * Renders a parsed JSON document as labelled fields and lists rather than as
 * source text. Every nested object and array is a fold-out, closed until asked
 * for, so a large payload occupies one row until the reader wants more.
 */

import { ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  describeJsonValue,
  humanizeJsonKey,
  isEmptyJsonContainer,
  jsonEntryLabel,
  MAX_JSON_RENDER_DEPTH,
  MAX_JSON_RENDER_ENTRIES,
} from "@/lib/chat/json-payload";
import { useMessagePartExpansion } from "@/lib/chat/message-part-expansion";
import { cn } from "@/lib/utils";

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === "object";
}

function ScalarValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground/70">—</span>;
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return (
      <span className="font-mono text-xs text-cyan-300/90">{String(value)}</span>
    );
  }
  const text = String(value);
  if (text.length === 0) {
    return <span className="text-muted-foreground/70">empty</span>;
  }
  return (
    <span className="whitespace-pre-wrap break-words text-foreground/90">
      {text}
    </span>
  );
}

/** An empty container is stated in place; there is nothing to fold out. */
function EmptyValue({ value }: { value: unknown }) {
  return (
    <span className="text-muted-foreground/70">
      {Array.isArray(value) ? "None" : "No fields"}
    </span>
  );
}

function TruncationNote({ hidden }: { hidden: number }) {
  return (
    <p className="pt-1 text-xs italic text-muted-foreground/70">
      {hidden} more not shown — open Raw JSON for the full payload.
    </p>
  );
}

function objectBranchExpansionKey(prefix: string, key: string): string {
  // JSON string escaping is total for JavaScript strings, including lone
  // surrogate code units that encodeURIComponent rejects. The typed array
  // segment also keeps object keys distinct from array indices and path slashes.
  return `${prefix}/${JSON.stringify(["key", key])}`;
}

function arrayBranchExpansionKey(prefix: string, index: number): string {
  return `${prefix}/${JSON.stringify(["index", index])}`;
}

function Branch({
  label,
  value,
  depth,
  expansionKey,
}: {
  label: string;
  value: unknown;
  depth: number;
  expansionKey: string;
}) {
  const [isOpen, setIsOpen] = useMessagePartExpansion(expansionKey);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-1.5 rounded-md py-1 text-left text-xs text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight
          className={cn(
            "size-3 shrink-0 transition-transform",
            isOpen && "rotate-90",
          )}
        />
        <span className="min-w-0 truncate font-medium text-foreground/85">
          {label}
        </span>
        <span className="shrink-0 text-muted-foreground/70">
          {describeJsonValue(value)}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-1.5 border-l border-border/40 pl-3">
          <JsonTree value={value} depth={depth} expansionKey={expansionKey} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ObjectFields({
  value,
  depth,
  expansionKey,
}: {
  value: Record<string, unknown>;
  depth: number;
  expansionKey: string;
}) {
  const entries = Object.entries(value);
  const shown = entries.slice(0, MAX_JSON_RENDER_ENTRIES);

  return (
    <>
      {/*
        Not a `<dl>`: a populated field is a disclosure whose own trigger names
        it, so it has no separate term element, and a `<dd>` without a `<dt>`
        would be invalid — as well as reading the label twice to a screen
        reader.
      */}
      <div className="space-y-1 text-sm">
        {shown.map(([key, child]) => {
          const label = humanizeJsonKey(key);
          if (isContainer(child) && !isEmptyJsonContainer(child)) {
            return (
              <Branch
                key={key}
                label={label}
                value={child}
                depth={depth}
                // Keyed by the document key rather than by position, so
                // re-rendering a payload whose fields moved keeps the reader's
                // open branches attached to the same data.
                expansionKey={objectBranchExpansionKey(expansionKey, key)}
              />
            );
          }
          return (
            <div key={key} className="flex flex-wrap gap-x-2 gap-y-0.5 py-0.5">
              <span className="shrink-0 text-xs font-medium text-muted-foreground">
                {label}
              </span>
              <span className="min-w-0 flex-1 text-sm">
                {isContainer(child)
                  ? <EmptyValue value={child} />
                  : <ScalarValue value={child} />}
              </span>
            </div>
          );
        })}
      </div>
      {entries.length > shown.length && (
        <TruncationNote hidden={entries.length - shown.length} />
      )}
    </>
  );
}

function ArrayItems({
  value,
  depth,
  expansionKey,
}: {
  value: unknown[];
  depth: number;
  expansionKey: string;
}) {
  const shown = value.slice(0, MAX_JSON_RENDER_ENTRIES);
  const allScalar = shown.every((item) => !isContainer(item));

  return (
    <>
      {allScalar ? (
        <ul className="space-y-1 text-sm">
          {shown.map((item, index) => (
            <li key={index} className="flex gap-2">
              <span className="mt-[0.55rem] size-1 shrink-0 rounded-full bg-muted-foreground/60" />
              <span className="min-w-0">
                <ScalarValue value={item} />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="space-y-0.5">
          {shown.map((item, index) => {
            if (!isContainer(item)) {
              return (
                <div key={index} className="py-0.5 pl-4 text-sm">
                  <ScalarValue value={item} />
                </div>
              );
            }
            if (isEmptyJsonContainer(item)) {
              return (
                <div key={index} className="py-0.5 pl-4 text-sm">
                  <EmptyValue value={item} />
                </div>
              );
            }
            const label = jsonEntryLabel(item);
            return (
              <Branch
                key={index}
                label={label ? `${index + 1}. ${label}` : `Item ${index + 1}`}
                value={item}
                depth={depth}
                expansionKey={arrayBranchExpansionKey(expansionKey, index)}
              />
            );
          })}
        </div>
      )}
      {value.length > shown.length && (
        <TruncationNote hidden={value.length - shown.length} />
      )}
    </>
  );
}

export function JsonTree({
  value,
  depth = 0,
  expansionKey,
}: {
  value: unknown;
  depth?: number;
  /** Prefix for the keys this subtree's disclosures persist their state under. */
  expansionKey: string;
}) {
  // Do not re-serialize the remaining value here. Pretty-print indentation can
  // expand a small, deeply nested document quadratically and exhaust the
  // renderer. The payload-level Raw JSON disclosure retains the exact bounded
  // source for readers who need the rest of the document.
  if (depth >= MAX_JSON_RENDER_DEPTH) {
    return (
      <p className="text-xs italic text-muted-foreground/70">
        Maximum nesting depth reached — open Raw JSON for the full payload.
      </p>
    );
  }
  if (Array.isArray(value)) {
    return (
      <ArrayItems value={value} depth={depth + 1} expansionKey={expansionKey} />
    );
  }
  if (isContainer(value)) {
    return (
      <ObjectFields
        value={value as Record<string, unknown>}
        depth={depth + 1}
        expansionKey={expansionKey}
      />
    );
  }
  return <ScalarValue value={value} />;
}
