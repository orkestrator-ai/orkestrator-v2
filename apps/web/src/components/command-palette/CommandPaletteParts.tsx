import { useId, useMemo } from "react";
import {
  ArrowRight,
  Copy,
  History,
  Play,
  RotateCw,
  Settings2,
  ShieldAlert,
  Square,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { MachineBadge } from "@/components/federation/MachineDot";
import { appShortcutKeys, detectShortcutPlatform } from "@/lib/keyboard-shortcuts";
import {
  describeTarget,
  describeTargetMachine,
  type CommandAvailability,
  type CommandDescriptor,
  type CommandTarget,
  type PaletteContext,
  type PaletteMachine,
} from "@/lib/command-palette/model";
import type { CommandResult } from "@/lib/command-palette/search";
import type { HistoryResult } from "@/lib/command-palette/history";
import type { PaletteProviderStatus } from "@/lib/command-palette/providers";
import { cn } from "@/lib/utils";

export function paletteOptionId(rowId: string): string {
  return `project-search-option-${rowId}`;
}

const ROW_CLASS = "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors";

function rowStateClass(isActive: boolean, available = true): string {
  return cn(
    isActive ? "bg-zinc-800 text-foreground" : "text-zinc-200 hover:bg-zinc-800/70",
    !available && "text-zinc-400",
  );
}

function CommandIcon({ command }: { command: CommandDescriptor }) {
  const className = "h-4 w-4 shrink-0 text-zinc-400";
  switch (command.id) {
    case "environment.start":
      return <Play className={className} aria-hidden="true" />;
    case "environment.stop":
      return <Square className={className} aria-hidden="true" />;
    case "environment.restart":
      return <RotateCw className={className} aria-hidden="true" />;
    case "environment.copy-id":
      return <Copy className={className} aria-hidden="true" />;
  }
  if (command.group === "settings") return <Settings2 className={className} aria-hidden="true" />;
  if (command.effect === "mutation") return <Zap className={className} aria-hidden="true" />;
  return <ArrowRight className={className} aria-hidden="true" />;
}

function MachineLabel({ machine }: { machine: PaletteMachine }) {
  return (
    <span
      className="flex max-w-36 shrink-0 items-center gap-1.5"
      data-testid="command-palette-machine"
    >
      <MachineBadge colorToken={machine.colorToken} machineName={machine.name} />
      {machine.availability !== "live" ? (
        <span className="shrink-0 rounded-md border border-amber-400/30 px-1 py-px text-[11px] font-medium text-amber-400/90">
          {machine.availability}
        </span>
      ) : null}
    </span>
  );
}

/** The accessible name of a command row: what it does, to what, where. */
export function commandAccessibleLabel(
  command: CommandDescriptor,
  target: CommandTarget,
  multiMachine: boolean,
): string {
  const what = describeTarget(target);
  const where = describeTargetMachine(target, multiMachine);
  return [command.label, what ? `for ${what}` : null, `on ${where}`].filter(Boolean).join(", ");
}

function unavailableText(availability: CommandAvailability): string | null {
  if (availability.available) return null;
  return availability.nextStep
    ? `${availability.reason} · ${availability.nextStep.label}`
    : availability.reason;
}

export function CommandRow({
  result,
  context,
  isActive,
  onHighlight,
  onSelect,
  rowRef,
}: {
  result: CommandResult;
  context: PaletteContext;
  isActive: boolean;
  onHighlight: () => void;
  onSelect: (result: CommandResult) => void;
  rowRef?: (node: HTMLButtonElement | null) => void;
}) {
  const { command, target, availability } = result;
  const reasonId = useId();
  const reason = unavailableText(availability);
  const shortcut = useMemo(
    () => (command.shortcut ? appShortcutKeys(command.shortcut, detectShortcutPlatform()) : null),
    [command.shortcut],
  );
  const targetText = describeTarget(target);
  return (
    <button
      ref={rowRef}
      type="button"
      id={paletteOptionId(result.rowId)}
      role="option"
      tabIndex={-1}
      data-testid={`command-palette-item-${command.id}`}
      data-available={availability.available ? "true" : "false"}
      aria-selected={isActive}
      aria-disabled={availability.available ? undefined : true}
      aria-label={commandAccessibleLabel(command, target, context.multiMachine)}
      aria-describedby={reason ? reasonId : undefined}
      onMouseEnter={onHighlight}
      onClick={() => onSelect(result)}
      className={cn(ROW_CLASS, rowStateClass(isActive, availability.available))}
    >
      <CommandIcon command={command} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">{command.label}</span>
        {reason ? (
          <span id={reasonId} className="truncate text-[11px] text-amber-400/90">
            {reason}
          </span>
        ) : null}
      </span>
      {targetText ? (
        <span
          className="hidden max-w-48 shrink truncate rounded-md bg-zinc-800/80 px-1.5 py-0.5 text-[11px] text-zinc-400 sm:inline"
          data-testid="command-palette-target"
        >
          {targetText}
        </span>
      ) : null}
      {target.machine && context.multiMachine ? <MachineLabel machine={target.machine} /> : null}
      {command.confirm && availability.available ? (
        <span className="shrink-0 text-[11px] text-zinc-500">asks first</span>
      ) : null}
      {shortcut ? (
        <kbd
          aria-hidden="true"
          className="hidden shrink-0 rounded-[5px] border border-border/70 bg-zinc-900 px-1.5 py-px font-sans text-[11px] text-zinc-400 sm:inline"
        >
          {shortcut.join("")}
        </kbd>
      ) : null}
    </button>
  );
}

export function HistoryRow({
  result,
  multiMachine,
  isActive,
  onHighlight,
  onSelect,
  rowRef,
}: {
  result: HistoryResult;
  multiMachine: boolean;
  isActive: boolean;
  onHighlight: () => void;
  onSelect: (result: HistoryResult) => void;
  rowRef?: (node: HTMLButtonElement | null) => void;
}) {
  const where = result.machine ? ` on ${result.machine.name}` : "";
  return (
    <button
      ref={rowRef}
      type="button"
      id={paletteOptionId(result.rowId)}
      role="option"
      tabIndex={-1}
      data-testid={`command-palette-history-${result.tabId}`}
      aria-selected={isActive}
      aria-label={`${result.title}, ${result.kind} tab in ${result.environmentName}${where}`}
      onMouseEnter={onHighlight}
      onClick={() => onSelect(result)}
      className={cn(ROW_CLASS, rowStateClass(isActive))}
    >
      <History className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-sm">{result.title}</span>
      <span className="hidden shrink-0 text-[11px] text-zinc-500 sm:inline">{result.kind}</span>
      <span className="max-w-40 shrink truncate rounded-md bg-zinc-800/80 px-1.5 py-0.5 text-[11px] text-zinc-400">
        {result.environmentName}
      </span>
      {result.machine && multiMachine ? <MachineLabel machine={result.machine} /> : null}
    </button>
  );
}

export function PaletteGroupHeading({
  children,
  status,
}: {
  children: string;
  status?: PaletteProviderStatus;
}) {
  return (
    <h3 className="flex items-center gap-2 px-3 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
      {children}
      {status === "loading" ? (
        <span className="font-normal normal-case tracking-normal" role="status">
          searching…
        </span>
      ) : status === "partial" ? (
        <span className="font-normal normal-case tracking-normal text-amber-400/90">
          more not shown
        </span>
      ) : null}
    </h3>
  );
}

/**
 * Where the palette's commands act: the machine, project and environment it
 * was opened over, frozen until the user chooses otherwise.
 */
export function PaletteContextBar({
  context,
  shownName,
  onRefresh,
}: {
  context: PaletteContext;
  /** What the window shows now, when it is no longer the palette's context. */
  shownName: string | null;
  onRefresh: () => void;
}) {
  const parts = [
    context.project?.name,
    context.environment?.name ??
      (context.environmentMissing
        ? "environment no longer exists"
        : context.targetUnknown
          ? "not yet loaded"
          : null),
  ].filter((part): part is string => Boolean(part));
  const machineName = context.machine?.name ?? "This machine";
  return (
    <div
      data-testid="command-palette-context"
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/70 px-4 py-1.5 text-[11px] text-zinc-400"
    >
      <span className="sr-only">Commands act on:</span>
      {context.machine ? <MachineLabel machine={context.machine} /> : null}
      <span className="min-w-0 truncate" data-testid="command-palette-context-path">
        {[context.machine ? null : machineName, ...parts].filter(Boolean).join(" › ") ||
          "No project selected"}
      </span>
      {!context.selectionCurrent ? (
        <span className="flex items-center gap-1.5 text-amber-400/90" role="status">
          <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="truncate">
            The window now shows {shownName ?? "something else"}; commands still act on this.
          </span>
          <button
            type="button"
            className="rounded px-1 text-zinc-200 underline-offset-2 hover:underline focus-hairline"
            onClick={onRefresh}
          >
            Use what is shown
          </button>
        </span>
      ) : null}
    </div>
  );
}

/**
 * The confirmation for a command that asks first. It names the frozen
 * target, re-checks it when confirmed, and never retries on its own.
 */
export function CommandConfirmPanel({
  command,
  target,
  availability,
  multiMachine,
  onBack,
  onConfirm,
}: {
  command: CommandDescriptor;
  target: CommandTarget;
  /** The command's availability for the frozen target, read now. */
  availability: CommandAvailability;
  multiMachine: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const confirm = command.confirm;
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      data-testid="command-palette-confirm"
      className="space-y-3 px-4 py-4"
    >
      <h3 id={titleId} className="text-sm font-medium text-foreground">
        {confirm?.title ?? command.label}
      </h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        {target.environment ? (
          <>
            <dt className="text-zinc-500">Environment</dt>
            <dd
              className="min-w-0 truncate text-zinc-200"
              data-testid="command-palette-confirm-environment"
            >
              {target.environment.name}
            </dd>
          </>
        ) : null}
        {target.project ? (
          <>
            <dt className="text-zinc-500">Project</dt>
            <dd className="min-w-0 truncate text-zinc-200">{target.project.name}</dd>
          </>
        ) : null}
        <dt className="text-zinc-500">Machine</dt>
        <dd
          className="min-w-0 truncate text-zinc-200"
          data-testid="command-palette-confirm-machine"
        >
          {describeTargetMachine(target, multiMachine)}
        </dd>
      </dl>
      {!availability.available ? (
        <p
          role="alert"
          className="text-xs text-amber-400/90"
          data-testid="command-palette-confirm-blocked"
        >
          {availability.reason}. Nothing was run.
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          Back
        </Button>
        <Button
          type="button"
          size="sm"
          autoFocus
          disabled={!availability.available}
          onClick={onConfirm}
          data-testid="command-palette-confirm-run"
        >
          {confirm?.verb ?? "Run"}
        </Button>
      </div>
    </div>
  );
}
