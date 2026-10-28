import {
  acceptanceCriteriaTally,
  DELIVERY_POLICY_LABELS,
  TICKET_KIND_LABELS,
  TICKET_SECTION_DEFINITIONS,
  type AcceptanceCriterion,
  type TicketKind,
  type TicketSections,
} from "@orkestrator/protocol/ticket-sections";
import { MarkdownBody } from "@/components/pull-requests/pull-request-shared";
import { CRITERION_STATES } from "./criterion-status";
import { cn } from "@/lib/utils";

export function TicketKindBadge({ kind, className }: { kind: TicketKind; className?: string }) {
  return (
    <span
      data-testid="ticket-kind"
      className={cn(
        "rounded-full px-2 py-0.5 text-xs font-medium",
        kind === "work-brief" ? "bg-sky-500/15 text-sky-500" : "bg-muted text-muted-foreground",
        className,
      )}
    >
      {TICKET_KIND_LABELS[kind]}
    </span>
  );
}

function Tile({
  id,
  title,
  wide,
  aside,
  children,
}: {
  id: string;
  title: string;
  /** `full` spans the whole row; `double` two columns where there are three. */
  wide?: "full" | "double";
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      data-testid={`ticket-tile-${id}`}
      className={cn(
        "min-w-0 rounded-lg border border-border/60 bg-muted/10 p-3",
        wide === "full" && "@xl:col-span-2 @4xl:col-span-3",
        wide === "double" && "@xl:col-span-2",
      )}
    >
      <header className="mb-2 flex min-w-0 items-center justify-between gap-2">
        <h4 className="truncate text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {title}
        </h4>
        {aside}
      </header>
      {children}
    </section>
  );
}

function CriteriaTally({ items }: { items: readonly AcceptanceCriterion[] }) {
  const tally = acceptanceCriteriaTally(items);
  const parts = [
    `${tally.passed}/${items.length} passed`,
    tally.failed ? `${tally.failed} failed` : "",
    tally["not-checked"] ? `${tally["not-checked"]} not checked` : "",
  ].filter(Boolean);
  return (
    <span data-testid="ticket-criteria-tally" className="shrink-0 text-xs text-muted-foreground">
      {parts.join(" · ")}
    </span>
  );
}

export function AcceptanceCriteriaList({ items }: { items: readonly AcceptanceCriterion[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => {
        const state = item.check?.status ?? "unchecked";
        const { label, icon: Icon, className } = CRITERION_STATES[state];
        return (
          <li
            key={item.id}
            data-testid="ticket-criterion"
            data-criterion-id={item.id}
            data-status={state}
            className="flex min-w-0 gap-2"
          >
            <Icon className={cn("mt-0.5 size-4 shrink-0", className)} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <span className="sr-only">{label}: </span>
              <MarkdownBody body={item.text} className="[&_p]:my-0" />
              {item.check?.evidence ? (
                <p
                  data-testid="ticket-criterion-evidence"
                  className="mt-0.5 text-xs break-words text-muted-foreground"
                >
                  {item.check.source === "manual" ? "" : `${label}: `}
                  {item.check.evidence}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A ticket's sections as a responsive grid of tiles, in the schema's order.
 * It sizes to its container, not the window, so it stacks to one column in a
 * narrow inspector or on a phone. Empty sections are left out.
 */
export function TicketSectionsGrid({
  sections,
  className,
  empty,
}: {
  sections: TicketSections;
  className?: string;
  /** Shown when every section is empty. */
  empty?: React.ReactNode;
}) {
  const tiles: React.ReactNode[] = [];
  for (const definition of TICKET_SECTION_DEFINITIONS) {
    const { key, heading } = definition;
    if (key === "notes") {
      (sections.custom ?? []).forEach((custom, index) => {
        tiles.push(
          <Tile key={`custom-${index}`} id={`custom-${index}`} title={custom.title}>
            <MarkdownBody body={custom.body} />
          </Tile>,
        );
      });
    }
    if (key === "acceptanceCriteria") {
      const items = sections.acceptanceCriteria ?? [];
      if (items.length) {
        tiles.push(
          <Tile
            key={key}
            id={key}
            title={heading}
            wide="double"
            aside={<CriteriaTally items={items} />}
          >
            <AcceptanceCriteriaList items={items} />
          </Tile>,
        );
      }
      continue;
    }
    if (key === "checks") {
      if (sections.checks?.length) {
        tiles.push(
          <Tile key={key} id={key} title={heading}>
            <ul className="flex flex-col gap-1">
              {sections.checks.map((check, index) => (
                <li key={index} className="min-w-0 font-mono text-xs break-words">
                  {check}
                </li>
              ))}
            </ul>
          </Tile>,
        );
      }
      continue;
    }
    if (key === "delivery") {
      const delivery = sections.delivery;
      if (delivery?.policy || delivery?.note) {
        tiles.push(
          <Tile key={key} id={key} title={heading}>
            {delivery.policy ? (
              <p data-testid="ticket-delivery-policy" className="text-sm font-medium">
                {DELIVERY_POLICY_LABELS[delivery.policy]}
              </p>
            ) : null}
            {delivery.note ? (
              <MarkdownBody body={delivery.note} className={delivery.policy ? "mt-1" : ""} />
            ) : null}
          </Tile>,
        );
      }
      continue;
    }
    const text = sections[key];
    if (text?.trim()) {
      tiles.push(
        <Tile key={key} id={key} title={heading} wide={key === "summary" ? "full" : undefined}>
          <MarkdownBody body={text} />
        </Tile>,
      );
    }
  }
  if (tiles.length === 0) return <>{empty ?? null}</>;
  return (
    <div className={cn("@container min-w-0", className)}>
      <div
        data-testid="ticket-sections-grid"
        className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-3"
      >
        {tiles}
      </div>
    </div>
  );
}
