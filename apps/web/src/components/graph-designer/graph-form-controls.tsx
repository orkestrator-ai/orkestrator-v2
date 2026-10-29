import { useId, useState, type ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Small, dense form controls for the editable inspector (item 212). Native
 * inputs and selects keep the forms keyboard- and screen-reader-friendly and
 * testable. Free text commits as it is typed (the store coalesces the
 * keystrokes into one undo step); identifiers and numbers commit on blur or
 * Enter, after validation, so a half-typed id never renames references.
 */

export const FIELD_CLASS =
  "h-7 w-full min-w-0 rounded-md border border-border/70 bg-input-surface px-2 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 aria-invalid:border-destructive disabled:opacity-50";

export function FormSection({
  title,
  actions,
  children,
  className,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-2", className)} aria-label={title}>
      <header className="flex items-center gap-2">
        <h4 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          {title}
        </h4>
        {actions ? <div className="ml-auto flex items-center gap-1">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  children,
  inline = false,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  inline?: boolean;
}) {
  return (
    <div className={cn("flex min-w-0 gap-1", inline ? "items-center" : "flex-col")}>
      <label htmlFor={id} className="text-[11px] text-muted-foreground">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-[11px] text-failure" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-[11px] text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Free text, committed as typed. */
export function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  mono = false,
  multiline = false,
  rows = 3,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: ReactNode;
  mono?: boolean;
  multiline?: boolean;
  rows?: number;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <Field id={id} label={label} hint={hint}>
      {multiline ? (
        <textarea
          id={id}
          value={value}
          rows={rows}
          placeholder={placeholder}
          disabled={disabled}
          spellCheck={!mono}
          onChange={(event) => onChange(event.target.value)}
          className={cn(
            FIELD_CLASS,
            "h-auto resize-y py-1 leading-4",
            mono && "font-mono text-[11px]",
          )}
        />
      ) : (
        <input
          id={id}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className={cn(FIELD_CLASS, mono && "font-mono text-[11px]")}
        />
      )}
    </Field>
  );
}

/**
 * Text committed on blur or Enter when `validate` accepts it (an id, a key,
 * a number). Escape restores the stored value.
 */
export function CommitField({
  label,
  value,
  onCommit,
  validate,
  hint,
  mono = true,
  placeholder,
  disabled,
}: {
  label: string;
  value: string;
  onCommit: (value: string) => void;
  validate?: (value: string) => string | null;
  hint?: ReactNode;
  mono?: boolean;
  placeholder?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    // Changed elsewhere (undo, a rename): show the stored value.
    setLastValue(value);
    setText(value);
    setError(null);
  }
  const commit = () => {
    if (text === value) {
      setError(null);
      return;
    }
    const problem = validate?.(text) ?? null;
    setError(problem);
    if (!problem) onCommit(text);
  };
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <input
        id={id}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            setText(value);
            setError(null);
          }
        }}
        className={cn(FIELD_CLASS, mono && "font-mono text-[11px]")}
      />
    </Field>
  );
}

/** A number committed on blur or Enter; empty means "not set" when `optional`. */
export function NumberField({
  label,
  value,
  onCommit,
  min,
  max,
  integer = true,
  optional = false,
  hint,
  disabled,
}: {
  label: string;
  value: number | undefined;
  onCommit: (value: number | undefined) => void;
  min?: number;
  max?: number;
  integer?: boolean;
  optional?: boolean;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <CommitField
      label={label}
      value={value === undefined ? "" : String(value)}
      hint={hint}
      disabled={disabled}
      validate={(text) => {
        if (text.trim() === "") return optional ? null : "Enter a number";
        const number = Number(text);
        if (!Number.isFinite(number)) return "Enter a number";
        if (integer && !Number.isInteger(number)) return "Enter a whole number";
        if (min !== undefined && number < min) return `At least ${min}`;
        if (max !== undefined && number > max) return `At most ${max}`;
        return null;
      }}
      onCommit={(text) => onCommit(text.trim() === "" ? undefined : Number(text))}
    />
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export function SelectField({
  label,
  value,
  options,
  onChange,
  hint,
  disabled,
}: {
  label: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  const known = options.some((option) => option.value === value);
  return (
    <Field id={id} label={label} hint={hint}>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={FIELD_CLASS}
      >
        {known ? null : <option value={value}>{value || "—"}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function CheckboxField({
  label,
  checked,
  onChange,
  hint,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          className="size-3.5 accent-primary"
        />
        <label htmlFor={id} className="text-xs text-foreground">
          {label}
        </label>
      </div>
      {hint ? <p className="pl-5.5 text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/**
 * JSON for a part the forms do not cover (or as a fallback). The text is the
 * user's until it parses and `validate` accepts it; then it commits.
 */
export function JsonField({
  label,
  value,
  onCommit,
  validate,
  rows = 6,
  hint,
}: {
  label: string;
  value: unknown;
  onCommit: (value: unknown) => void;
  validate?: (value: unknown) => string | null;
  rows?: number;
  hint?: ReactNode;
}) {
  const id = useId();
  const canonical = value === undefined ? "" : JSON.stringify(value, null, 2);
  const [text, setText] = useState(canonical);
  const [error, setError] = useState<string | null>(null);
  const [lastCanonical, setLastCanonical] = useState(canonical);
  if (canonical !== lastCanonical) {
    // The value changed elsewhere (undo, another form): show it.
    setLastCanonical(canonical);
    setText(canonical);
    setError(null);
  }
  const change = (next: string) => {
    setText(next);
    let parsed: unknown;
    try {
      parsed = JSON.parse(next);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Not JSON");
      return;
    }
    const issue = validate?.(parsed) ?? null;
    setError(issue);
    if (!issue) {
      setLastCanonical(JSON.stringify(parsed, null, 2));
      onCommit(parsed);
    }
  };
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <textarea
        id={id}
        value={text}
        rows={rows}
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        onChange={(event) => change(event.target.value)}
        className={cn(FIELD_CLASS, "h-auto resize-y py-1 font-mono text-[11px] leading-4")}
      />
    </Field>
  );
}

export function AddButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-6 px-1.5 text-[11px]"
      onClick={onClick}
      disabled={disabled}
    >
      <Plus className="size-3" />
      {label}
    </Button>
  );
}

export function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-6 w-6 shrink-0 text-muted-foreground hover:text-failure"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Trash2 className="size-3" />
    </Button>
  );
}

/** A compact tab strip for an editor's sections. */
export function EditorTabs<T extends string>({
  label,
  tabs,
  value,
  onChange,
}: {
  label: string;
  tabs: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex flex-wrap gap-1 border-b border-border/60 pb-1"
    >
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={tab.value === value}
          onClick={() => onChange(tab.value)}
          className={cn(
            "rounded px-2 py-0.5 text-[11px] font-medium",
            tab.value === value
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** A bordered card for one list entry (a port, a lens, a branch). */
export function EntryCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-md border border-border/60 bg-flow-canvas/40 p-2",
        className,
      )}
    >
      {children}
    </div>
  );
}
