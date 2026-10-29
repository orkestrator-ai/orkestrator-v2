import type {
  GraphLaunchInputOption,
  GraphLaunchOptions,
} from "@orkestrator/protocol/graphs/launch";
import type { GraphParameter } from "@orkestrator/protocol/graphs/template";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  graphLaunchInputAutoFilled,
  graphLaunchInputProblem,
  graphLaunchParamProblem,
  type GraphLaunchDraft,
  type GraphLaunchEnvironmentKey,
} from "./graph-launch-model";

const SELECT_CLASS =
  "h-8 w-full min-w-0 rounded-md border border-zinc-700/80 bg-zinc-900 px-2 text-xs text-zinc-200";

function FieldError({ id, text }: { id: string; text: string | null }) {
  if (!text) return null;
  return (
    <p id={id} className="text-[11px] leading-snug text-red-400">
      {text}
    </p>
  );
}

/** One launch parameter: a toggle, a number, a select or text (item 214). */
export function GraphLaunchParamField({
  parameter,
  value,
  onChange,
}: {
  parameter: GraphParameter;
  value: string | boolean | undefined;
  onChange: (value: string | boolean) => void;
}) {
  const id = `graph-launch-param-${parameter.key}`;
  const label = parameter.label ?? parameter.key;
  const problem = graphLaunchParamProblem(parameter, value);
  const errorId = `${id}-error`;
  if (parameter.type === "boolean") {
    return (
      <div className="flex items-start gap-2">
        <Checkbox
          id={id}
          checked={value === true}
          onCheckedChange={(checked) => onChange(checked === true)}
        />
        <div className="min-w-0">
          <label htmlFor={id} className="text-xs font-medium text-foreground">
            {label}
          </label>
          {parameter.description && (
            <p className="text-[11px] leading-snug text-muted-foreground">
              {parameter.description}
            </p>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-xs font-medium text-foreground">
        {label}
      </label>
      {parameter.type === "enum" ? (
        <select
          id={id}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
          className={SELECT_CLASS}
        >
          {parameter.default === undefined && <option value="">Choose…</option>}
          {parameter.options.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>
      ) : (
        <Input
          id={id}
          type={parameter.type === "string" ? "text" : "number"}
          value={typeof value === "string" ? value : ""}
          {...(parameter.type !== "string" && parameter.min !== undefined
            ? { min: parameter.min }
            : {})}
          {...(parameter.type !== "string" && parameter.max !== undefined
            ? { max: parameter.max }
            : {})}
          {...(parameter.type === "integer" ? { step: 1 } : {})}
          placeholder={parameter.default !== undefined ? String(parameter.default) : undefined}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? errorId : undefined}
          className="h-8 text-xs"
        />
      )}
      {parameter.description && (
        <p className="text-[11px] leading-snug text-muted-foreground">{parameter.description}</p>
      )}
      <FieldError id={errorId} text={problem} />
    </div>
  );
}

/** One run input: a ticket picker for the ticket input, JSON otherwise (item 214). */
export function GraphLaunchInputField({
  input,
  draft,
  ticketInput,
  tickets,
  onText,
  onTicket,
}: {
  input: GraphLaunchInputOption;
  draft: GraphLaunchDraft;
  ticketInput: string | null;
  tickets: ReadonlyArray<{ id: string; title: string }>;
  onText: (text: string) => void;
  onTicket: (taskId: string | null) => void;
}) {
  const id = `graph-launch-input-${input.name}`;
  const label = input.label ?? input.name;
  const problem = graphLaunchInputProblem(input, draft, ticketInput);
  const errorId = `${id}-error`;
  const autoFilled = graphLaunchInputAutoFilled(input, draft);
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-xs font-medium text-foreground">
        {label}
        <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">{input.type}</span>
        {!input.required && (
          <span className="ml-1.5 text-[10px] text-muted-foreground">optional</span>
        )}
      </label>
      {input.description && (
        <p className="text-[11px] leading-snug text-muted-foreground">{input.description}</p>
      )}
      {input.name === ticketInput ? (
        <select
          id={id}
          value={draft.ticketTaskId ?? ""}
          onChange={(event) => onTicket(event.target.value || null)}
          className={SELECT_CLASS}
        >
          <option value="">Choose a ticket…</option>
          {tickets.map((ticket) => (
            <option key={ticket.id} value={ticket.id}>
              {ticket.title}
            </option>
          ))}
        </select>
      ) : !input.launchable ? (
        <p id={id} className="text-[11px] leading-snug text-muted-foreground">
          A file artifact; a launch cannot give one yet.
        </p>
      ) : (
        <>
          <Textarea
            id={id}
            value={draft.inputs[input.name] ?? ""}
            onChange={(event) => onText(event.target.value)}
            placeholder={autoFilled ? "Filled from the run's environment" : "JSON value"}
            rows={3}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? errorId : undefined}
            className="max-h-48 font-mono text-xs"
          />
          {input.autoFill === "environment-head" && (
            <p className="text-[11px] leading-snug text-muted-foreground">
              {draft.environment === "existing"
                ? "Filled from the environment's current commit; JSON here overrides it."
                : "Filled from the new environment's commit once it exists; JSON here overrides it."}
            </p>
          )}
        </>
      )}
      <FieldError id={errorId} text={problem} />
    </div>
  );
}

const ENVIRONMENT_CHOICES: ReadonlyArray<{ key: GraphLaunchEnvironmentKey; label: string }> = [
  { key: "new-worktree", label: "New worktree" },
  { key: "new-container", label: "New container" },
  { key: "existing", label: "Existing environment" },
];

/** Where the run works (D7): a new worktree or container, or an existing environment. */
export function GraphLaunchEnvironmentField({
  options,
  draft,
  environments,
  onChange,
}: {
  options: GraphLaunchOptions;
  draft: GraphLaunchDraft;
  environments: ReadonlyArray<{ id: string; name: string }>;
  onChange: (environment: GraphLaunchEnvironmentKey, environmentId: string | null) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-xs font-semibold text-foreground">Environment</legend>
      <div role="radiogroup" aria-label="Environment" className="flex flex-wrap gap-1.5">
        {ENVIRONMENT_CHOICES.map((choice) => {
          const checked = draft.environment === choice.key;
          return (
            <button
              key={choice.key}
              type="button"
              role="radio"
              aria-checked={checked}
              onClick={() => onChange(choice.key, draft.environmentId)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-xs",
                checked
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {choice.label}
              {options.environment.create && choice.key === `new-${options.environment.create}`
                ? " (template default)"
                : ""}
            </button>
          );
        })}
      </div>
      {draft.environment === "existing" && (
        <select
          aria-label="Existing environment"
          value={draft.environmentId ?? ""}
          onChange={(event) => onChange("existing", event.target.value || null)}
          className={SELECT_CLASS}
        >
          <option value="">Choose an environment…</option>
          {environments.map((environment) => (
            <option key={environment.id} value={environment.id}>
              {environment.name}
            </option>
          ))}
        </select>
      )}
      <p className="text-[11px] leading-snug text-muted-foreground">
        One environment per run. A new one is created and started before the first step.
      </p>
    </fieldset>
  );
}
