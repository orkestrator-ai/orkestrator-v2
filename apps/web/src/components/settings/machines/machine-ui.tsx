import { useState, type ReactNode } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { machineDotClass, machineOutlineClass } from "@/lib/federation/machine-colors";
import { cn } from "@/lib/utils";

/**
 * The machine's colour, filled while it is connected and as an outline
 * while it is not. The status is also in the accessible label and the row
 * text, so colour and fill are never the only signal.
 */
export function MachineStatusDot({
  colorToken,
  connected,
  label,
  decorative = false,
  className,
}: {
  colorToken: string | undefined;
  connected: boolean;
  /** For example "Build box: Connected". */
  label: string;
  /** The surrounding text already says the name and status. */
  decorative?: boolean;
  className?: string;
}) {
  return (
    <span
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
      title={label}
      data-testid="machine-status-dot"
      data-connected={connected ? "true" : "false"}
      data-machine-color={colorToken ?? "neutral"}
      className={cn(
        "inline-block size-2.5 shrink-0 rounded-full",
        "forced-colors:border forced-colors:border-[CanvasText]",
        connected
          ? cn(machineDotClass(colorToken), "ring-2 ring-white/10")
          : cn("border-[1.5px] bg-transparent", machineOutlineClass(colorToken)),
        className,
      )}
    />
  );
}

export function formatMachineTime(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    date,
  );
}

export function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

export function FormError({ message }: { message: string }) {
  return (
    <div
      className="rounded-md border border-red-500/25 bg-red-500/[0.07] px-3 py-2 text-sm text-red-300"
      role="alert"
    >
      {message}
    </div>
  );
}

/** A gateway token field that can be revealed while it is typed; saved tokens are never shown. */
export function TokenInput({
  id,
  value,
  onChange,
  disabled,
  required = false,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        type={visible ? "text" : "password"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
        spellCheck={false}
        className="pr-10 font-mono text-xs"
        disabled={disabled}
        required={required}
        placeholder={placeholder}
      />
      <button
        type="button"
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-zinc-500 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange-500/60"
        onClick={() => setVisible((current) => !current)}
        aria-label={visible ? "Hide gateway token" : "Show gateway token"}
        disabled={disabled}
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

/** A titled block inside the machine dialogs. */
export function MachineSection({
  title,
  description,
  action,
  children,
  testId,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="space-y-3" {...(testId ? { "data-testid": testId } : {})}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-medium text-zinc-100">{title}</h4>
          {description ? (
            <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">{description}</p>
          ) : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
