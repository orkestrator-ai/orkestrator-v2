import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AlertCircle, AlertTriangle, Info } from "lucide-react";
import {
  GRAPH_BUILT_IN_PROMPT_IDS,
  GRAPH_PROMPT_INPUT_CEILING_BYTES,
  estimateGraphNodePromptSize,
  graphBuiltInPrompt,
  graphNodePromptPreviewValues,
  graphPromptScope,
  renderGraphNodePrompt,
  type GraphPromptDiagnostic,
  type GraphPromptValues,
} from "@orkestrator/protocol/graphs/prompts";
import { GRAPH_TEMPLATE_BOUNDS } from "@orkestrator/protocol/graphs/grammar";
import type { GraphAgentNode } from "@orkestrator/protocol/graphs/template";
import { cn } from "@/lib/utils";
import { useGraphNodeCapabilities } from "./GraphEnforcementMatrix";
import {
  applyGraphPromptCompletion,
  filterGraphPromptSuggestions,
  graphPromptCompletionAt,
  graphPromptContextFor,
  graphPromptVariableSuggestions,
  type GraphPromptCompletion,
} from "./graph-designer-prompt";
import { useGraphEditor, useGraphNodeEdit } from "./graph-editor-context";
import { CheckboxField, FIELD_CLASS, FormSection, SelectField } from "./graph-form-controls";

/**
 * The prompt editor of an agent node (report §7.3, D13): a built-in prompt or
 * the user's logic-less template, with `{{` autocompletion of the variables
 * the node can read (input ports and their schema fields, parameters, the
 * run, the lens and branch of a replicated node, the ticket), a live preview
 * of the whole prompt including the locked system contract (rendered by
 * 105's `renderGraphNodePrompt`, the function the executor uses, so the
 * preview is what the agent gets), its size against the ceiling, and the
 * lints inline. The preview uses each input type's `example`, or a fixture
 * the user pastes.
 */

const KIB = 1024;
/** The preview shows at most this much of the prompt; its size is still exact. */
const PREVIEW_DISPLAY_CHARS = 64 * KIB;

const SEVERITY_ICON = { error: AlertCircle, warning: AlertTriangle, info: Info } as const;
const SEVERITY_TONE = {
  error: "text-failure",
  warning: "text-amber-300",
  info: "text-sky-300",
} as const;

function formatBytes(bytes: number): string {
  return bytes >= KIB ? `${(bytes / KIB).toFixed(bytes >= 10 * KIB ? 0 : 1)} KiB` : `${bytes} B`;
}

/** Line and column (1-based) of a UTF-16 offset. */
function position(text: string, offset: number): string {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  return `${line}:${offset - before.lastIndexOf("\n")}`;
}

/**
 * A pasted fixture: a JSON object whose keys are input port names (each the
 * port's value), plus optional `params` and, when no port has that name,
 * `ticket` (the run's ticket).
 */
function parseFixture(
  text: string,
  ports: ReadonlySet<string>,
): { values: Partial<GraphPromptValues>; error: string | null } {
  if (!text.trim()) return { values: {}, error: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { values: {}, error: error instanceof Error ? error.message : "Not JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { values: {}, error: "The fixture is a JSON object keyed by input port name" };
  }
  const inputs: Record<string, unknown> = {};
  const values: Partial<GraphPromptValues> = { inputs };
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (ports.has(key)) inputs[key] = value;
    else if (key === "params" && value && typeof value === "object") {
      values.params = value as Record<string, unknown>;
    } else if (key === "ticket") values.ticket = value;
    else return { values: {}, error: `${key} is not an input of this node` };
  }
  return { values, error: null };
}

export function GraphPromptEditor({ node }: { node: GraphAgentNode }) {
  const { template, library, plan, ceiling } = useGraphEditor();
  const editNode = useGraphNodeEdit(node.id);
  const planNode = plan?.nodes.find((candidate) => candidate.id === node.id);
  const compiled = useGraphNodeCapabilities(node, planNode, ceiling);
  const context = useMemo(
    () => graphPromptContextFor(template, library, node, plan),
    [template, library, node, plan],
  );
  const scope = useMemo(() => graphPromptScope(context), [context]);
  const suggestions = useMemo(() => graphPromptVariableSuggestions(scope), [scope]);

  const [fixtureText, setFixtureText] = useState("");
  const [useFixture, setUseFixture] = useState(false);
  const fixture = useMemo(
    () => parseFixture(fixtureText, new Set(scope.ports.keys())),
    [fixtureText, scope],
  );

  const render = useMemo(() => {
    if (!compiled) return null;
    const examples = graphNodePromptPreviewValues(context);
    const extra = useFixture ? fixture.values : {};
    const values: GraphPromptValues = {
      ...examples,
      ...extra,
      inputs: { ...examples.inputs, ...extra.inputs },
      params: {
        ...Object.fromEntries(
          template.parameters
            .filter((parameter) => parameter.default !== undefined)
            .map((parameter) => [parameter.key, parameter.default]),
        ),
        ...extra.params,
      },
    };
    return renderGraphNodePrompt({ ...context, compiled, values, preview: true });
  }, [compiled, context, fixture, useFixture, template.parameters]);

  const size = useMemo(
    () => (compiled ? estimateGraphNodePromptSize({ ...context, compiled }) : null),
    [compiled, context],
  );

  const isBuiltIn = "builtIn" in node.prompt;
  const text = "template" in node.prompt ? node.prompt.template : "";
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [completion, setCompletion] = useState<GraphPromptCompletion | null>(null);
  const [active, setActive] = useState(0);
  const matches = completion ? filterGraphPromptSuggestions(suggestions, completion) : [];

  const setTemplate = (next: string) =>
    editNode<GraphAgentNode>(
      "Edit prompt",
      (current) => ({ ...current, prompt: { template: next } }),
      "prompt",
    );

  const refreshCompletion = (value: string, caret: number) => {
    setCompletion(graphPromptCompletionAt(value, caret));
    setActive(0);
  };

  const accept = (index: number) => {
    const area = textareaRef.current;
    const chosen = matches[index];
    if (!area || !completion || !chosen) return;
    const next = applyGraphPromptCompletion(text, area.selectionStart, completion, chosen);
    setTemplate(next.text);
    setCompletion(null);
    requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(next.caret, next.caret);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!completion || matches.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => (index + 1) % matches.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (index - 1 + matches.length) % matches.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      accept(active);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setCompletion(null);
    }
  };

  const showDiagnostic = (diagnostic: GraphPromptDiagnostic) => {
    const area = textareaRef.current;
    if (!area || diagnostic.offset === undefined) return;
    area.focus();
    area.setSelectionRange(diagnostic.offset, diagnostic.offset + (diagnostic.length ?? 0));
  };

  const ceilingBytes = GRAPH_PROMPT_INPUT_CEILING_BYTES;
  const inputBytes = size?.inputNominalBytes ?? 0;
  const over = inputBytes > ceilingBytes;

  return (
    <div className="flex flex-col gap-3" data-graph-prompt-editor="">
      <FormSection title="Prompt">
        <SelectField
          label="Prompt source"
          value={isBuiltIn ? `builtin:${(node.prompt as { builtIn: string }).builtIn}` : "template"}
          hint={
            isBuiltIn
              ? graphBuiltInPrompt((node.prompt as { builtIn: string }).builtIn)?.description
              : "Your template: logic-less, {{variables}}, {{#list}}…{{/list}} and {{> input.<port>}}."
          }
          options={[
            { value: "template", label: "Your template" },
            ...GRAPH_BUILT_IN_PROMPT_IDS.map((id) => ({
              value: `builtin:${id}`,
              label: `Built-in: ${graphBuiltInPrompt(id)?.label ?? id}`,
            })),
          ]}
          onChange={(value) =>
            editNode<GraphAgentNode>("Change prompt", (current) => ({
              ...current,
              prompt: value.startsWith("builtin:")
                ? { builtIn: value.slice("builtin:".length) }
                : { template: "template" in current.prompt ? current.prompt.template : "" },
            }))
          }
        />
        {!isBuiltIn ? (
          <div className="relative flex flex-col gap-1">
            <label htmlFor={`${listId}-text`} className="text-[11px] text-muted-foreground">
              Template ({formatBytes(new TextEncoder().encode(text).length)} of{" "}
              {formatBytes(GRAPH_TEMPLATE_BOUNDS.maxPromptTemplateBytes)})
            </label>
            <textarea
              id={`${listId}-text`}
              ref={textareaRef}
              value={text}
              rows={8}
              spellCheck={false}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={matches.length > 0}
              aria-controls={listId}
              aria-activedescendant={matches.length > 0 ? `${listId}-${active}` : undefined}
              onChange={(event) => {
                setTemplate(event.target.value);
                refreshCompletion(event.target.value, event.target.selectionStart);
              }}
              onKeyDown={onKeyDown}
              onKeyUp={(event) => {
                if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                  refreshCompletion(event.currentTarget.value, event.currentTarget.selectionStart);
                }
              }}
              onClick={(event) =>
                refreshCompletion(event.currentTarget.value, event.currentTarget.selectionStart)
              }
              onBlur={() => setTimeout(() => setCompletion(null), 150)}
              className={cn(FIELD_CLASS, "h-auto resize-y py-1 font-mono text-[11px] leading-4")}
            />
            {matches.length > 0 ? (
              <ul
                id={listId}
                role="listbox"
                aria-label="Variables"
                data-graph-prompt-suggestions=""
                className="z-10 max-h-48 overflow-y-auto rounded-md border border-border bg-popover py-1 text-[11px] shadow-md"
              >
                {matches.map((suggestion, index) => (
                  <li
                    key={suggestion.insert}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={index === active}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      accept(index);
                    }}
                    className={cn(
                      "flex cursor-pointer items-baseline gap-2 px-2 py-0.5",
                      index === active && "bg-accent",
                    )}
                  >
                    <span className="font-mono text-foreground">{suggestion.label}</span>
                    <span className="truncate text-muted-foreground">{suggestion.detail}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="text-[11px] text-muted-foreground">
              Type <span className="font-mono">{"{{"}</span> for the variables this node can read.
            </p>
          </div>
        ) : null}
      </FormSection>

      <FormSection title="Lints">
        {render && render.diagnostics.length > 0 ? (
          <ul className="flex flex-col gap-1" data-graph-prompt-lints="">
            {render.diagnostics.map((diagnostic, index) => {
              const Icon = SEVERITY_ICON[diagnostic.severity];
              return (
                <li
                  key={`${diagnostic.code}:${index}`}
                  data-graph-prompt-lint={diagnostic.code}
                  className="flex items-start gap-1.5 text-[11px]"
                >
                  <Icon
                    aria-hidden
                    className={cn("mt-0.5 size-3 shrink-0", SEVERITY_TONE[diagnostic.severity])}
                  />
                  <span className="min-w-0 flex-1">
                    {diagnostic.message}
                    {diagnostic.offset !== undefined && !isBuiltIn ? (
                      <button
                        type="button"
                        className="ml-1 font-mono text-primary hover:underline"
                        onClick={() => showDiagnostic(diagnostic)}
                      >
                        {position(text, diagnostic.offset)}
                      </button>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-[11px] text-muted-foreground">No lints.</p>
        )}
      </FormSection>

      <FormSection title="Size">
        {size ? (
          <div className="flex flex-col gap-1" data-graph-prompt-size={over ? "over" : "ok"}>
            <div className="h-1.5 w-full overflow-hidden rounded bg-border/60" aria-hidden>
              <div
                className={cn("h-full", over ? "bg-failure" : "bg-emerald-400/80")}
                style={{ width: `${Math.min(100, (inputBytes / ceilingBytes) * 100)}%` }}
              />
            </div>
            <p className={cn("text-[11px]", over ? "text-failure" : "text-muted-foreground")}>
              Rendered inputs up to {formatBytes(inputBytes)} of the {formatBytes(ceilingBytes)}{" "}
              ceiling
              {over ? ": render large inputs as file, summary or on demand." : "."} Whole prompt up
              to {formatBytes(size.nominalBytes)}
              {size.bounded ? "" : " (an input has no size bound)"}; the system contract is{" "}
              {formatBytes(size.systemBytes)}.
            </p>
          </div>
        ) : null}
      </FormSection>

      <FormSection title="Preview">
        <CheckboxField
          label="Use a pasted fixture instead of the types' examples"
          checked={useFixture}
          onChange={setUseFixture}
        />
        {useFixture ? (
          <div className="flex flex-col gap-1">
            <label htmlFor={`${listId}-fixture`} className="text-[11px] text-muted-foreground">
              Fixture (JSON keyed by input port; optional params and ticket)
            </label>
            <textarea
              id={`${listId}-fixture`}
              value={fixtureText}
              rows={4}
              spellCheck={false}
              onChange={(event) => setFixtureText(event.target.value)}
              aria-invalid={fixture.error ? true : undefined}
              className={cn(FIELD_CLASS, "h-auto resize-y py-1 font-mono text-[11px] leading-4")}
            />
            {fixture.error ? <p className="text-[11px] text-failure">{fixture.error}</p> : null}
          </div>
        ) : null}
        {render ? (
          <div className="flex flex-col gap-1" data-graph-prompt-preview="">
            <p className="text-[11px] text-muted-foreground">
              {formatBytes(render.bytes)} as rendered with these values.
            </p>
            <pre className="max-h-72 overflow-auto rounded-md bg-flow-canvas p-2 font-mono text-[11px] whitespace-pre-wrap text-foreground/90">
              {render.user.slice(0, PREVIEW_DISPLAY_CHARS)}
            </pre>
            <p className="text-[11px] font-medium text-muted-foreground">
              Locked system contract (added by Orkestrator)
            </p>
            <pre
              data-graph-prompt-contract=""
              className="max-h-56 overflow-auto rounded-md border border-dashed border-border bg-flow-canvas/60 p-2 font-mono text-[11px] whitespace-pre-wrap text-muted-foreground"
            >
              {render.system.slice(0, PREVIEW_DISPLAY_CHARS)}
            </pre>
          </div>
        ) : (
          <p className="text-[11px] text-failure">
            The capability spec is not valid, so the system contract cannot be shown.
          </p>
        )}
      </FormSection>
    </div>
  );
}
