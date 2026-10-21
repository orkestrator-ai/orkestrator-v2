import type { ReactNode } from "react";
import { AlarmClock, CircleCheck, CircleDashed, CircleStop, Clock, Repeat } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  formatWakeupDelay,
  type ScheduleWakeupCall,
  type ScheduleWakeupResult,
} from "@/lib/schedule-wakeup-tool";

function Chip({
  icon,
  children,
  title,
  className,
}: {
  icon: ReactNode;
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-foreground/90",
        className,
      )}
      title={title}
    >
      {icon}
      {children}
    </span>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
        {label}
      </div>
      {children}
    </div>
  );
}

function formatExtraValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Expanded body of a `ScheduleWakeup` row: when the loop wakes, why, and what
 * it will do then, in place of the raw arguments.
 */
export function ScheduleWakeupToolDetails({
  call,
  result,
  succeeded,
}: {
  call: ScheduleWakeupCall;
  result: ScheduleWakeupResult | null;
  succeeded: boolean;
}) {
  // The runtime clamps the requested delay, so the result's figure is the one
  // that will actually elapse; the request stays in the tooltip.
  const requested =
    call.delaySeconds !== undefined ? `Requested ${call.delaySeconds} seconds` : undefined;
  const delaySeconds = (succeeded ? result?.inSeconds : undefined) ?? call.delaySeconds;

  return (
    <div
      className="space-y-2.5 border-b border-border/30 px-3 py-2.5"
      data-testid="schedule-wakeup-tool"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {call.stop ? (
          <Chip icon={<CircleStop className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />}>
            {succeeded ? "Loop stopped" : "Stop requested"}
          </Chip>
        ) : (
          delaySeconds !== undefined && (
            <Chip
              icon={<AlarmClock className="h-3.5 w-3.5 text-primary" aria-hidden />}
              title={requested}
            >
              {succeeded ? "Wakes in" : "Requested"}{" "}
              <span className="font-medium tabular-nums">{formatWakeupDelay(delaySeconds)}</span>
            </Chip>
          )
        )}
        {succeeded && !call.stop && result && (
          <Chip icon={<Clock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />}>
            at <span className="font-medium tabular-nums">{result.scheduledFor}</span>
          </Chip>
        )}
        {call.noop === true && (
          <Chip
            icon={<CircleDashed className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />}
            title="Nothing changed this tick"
            className="text-muted-foreground"
          >
            No change
          </Chip>
        )}
        {call.noop === false && (
          <Chip
            icon={<CircleCheck className="h-3.5 w-3.5 text-success" aria-hidden />}
            title="Something changed this tick"
          >
            Progress
          </Chip>
        )}
      </div>

      {call.reason && (
        <Field label="Reason">
          <p className="text-sm leading-relaxed text-foreground whitespace-pre-wrap break-words">
            {call.reason}
          </p>
        </Field>
      )}

      {call.prompt && (
        <Field label="On wake">
          {call.autonomous ? (
            <div
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
              title={call.prompt}
            >
              <Repeat className="h-3.5 w-3.5 shrink-0" aria-hidden />
              Continue the autonomous loop
            </div>
          ) : (
            <p className="rounded-md bg-muted/50 px-2 py-1.5 text-xs leading-relaxed text-foreground/90 whitespace-pre-wrap break-words">
              {call.prompt}
            </p>
          )}
        </Field>
      )}

      {call.extra.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {call.extra.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="font-mono text-muted-foreground">{key}</dt>
              <dd className="min-w-0 font-mono text-foreground/80 whitespace-pre-wrap break-all">
                {formatExtraValue(value)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
