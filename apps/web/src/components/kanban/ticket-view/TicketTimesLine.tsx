import { useMinuteClock } from "@/hooks/useMinuteClock";
import type { KanbanTask } from "@/stores/kanbanStore";

import { ticketTimes, type TicketTime } from "./ticket-times";

function TimeText({ time, testId }: { time: TicketTime; testId: string }) {
  return (
    <time data-testid={testId} dateTime={time.dateTime} title={time.title}>
      {time.text}
    </time>
  );
}

/**
 * "Created 3h ago · Updated 5m ago" in the ticket view's header, each with
 * its exact local time as a tooltip. "Updated" is left out while it says the
 * same as "Created"; a change in the first minute is in Created's tooltip.
 */
export function TicketTimesLine({
  task,
  className,
}: {
  task: Pick<KanbanTask, "createdAt" | "updatedAt">;
  className?: string;
}) {
  const now = useMinuteClock();
  const { created, updated } = ticketTimes(task, now);
  if (!created && !updated) return null;
  return (
    <span data-testid="ticket-times" className={className}>
      {created ? <TimeText time={created} testId="ticket-created-at" /> : null}
      {created && updated ? (
        <span aria-hidden="true" className="px-1.5">
          ·
        </span>
      ) : null}
      {updated ? <TimeText time={updated} testId="ticket-updated-at" /> : null}
    </span>
  );
}
