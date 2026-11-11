import {
  acceptanceCriteriaTally,
  criterionCheckBasis,
  DELIVERY_POLICY_LABELS,
  TICKET_KIND_LABELS,
  TICKET_SECTION_DEFINITIONS,
  type AcceptanceCriterion,
  type AcceptanceCriterionCheck,
  type DeliveryPolicy,
  type TicketKind,
  type TicketSections,
} from "@orkestrator/protocol/ticket-sections";
import { MarkdownBody } from "@/components/pull-requests/pull-request-shared";
import { CRITERION_STATES } from "./criterion-status";
import { DeliveryPolicySelect } from "./DeliveryPolicySelect";
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

/**
 * Which code a Verify check judged: its commit, whether the worktree also had
 * uncommitted changes, and whether the branch has moved since. A check stored
 * before commits were recorded says so rather than reading as current.
 */
function CriterionCommit({
  check,
  environmentHead,
}: {
  check: AcceptanceCriterionCheck | undefined;
  environmentHead?: string;
}) {
  const basis = criterionCheckBasis(check, environmentHead);
  if (!basis) return null;
  return (
    <p
      data-testid="ticket-criterion-commit"
      data-moved={basis.moved ? "true" : undefined}
      className="mt-0.5 text-xs break-words text-muted-foreground"
    >
      {basis.commit ? (
        <>
          Judged on{" "}
          <code className="font-mono" title={basis.commit}>
            {basis.commit.slice(0, 7)}
          </code>
          {basis.uncommittedChanges ? " with uncommitted changes" : ""}
          {basis.moved ? (
            <span className="text-amber-600 dark:text-amber-400">; the branch has moved since</span>
          ) : null}
        </>
      ) : (
        "Commit not recorded"
      )}
    </p>
  );
}

export function AcceptanceCriteriaList({
  items,
  environmentHead,
}: {
  items: readonly AcceptanceCriterion[];
  /** The build environment's HEAD now, so a check on older code says so. */
  environmentHead?: string;
}) {
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
              <CriterionCommit check={item.check} environmentHead={environmentHead} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** What `deliveryControl` makes of the Delivery section; see {@link TicketSectionsGrid}. */
export interface TicketDeliveryControl {
  onChange: (policy: DeliveryPolicy) => void;
  disabled?: boolean;
  /** The change came too late for a build that has already decided. */
  tooLateNote?: string;
}

/** One non-empty section of a ticket, ready to render as a tile or a flow section. */
export interface TicketSectionEntry {
  key: string;
  title: string;
  /** `full` spans the whole grid row; `double` two columns where there are three. */
  wide?: "full" | "double";
  aside?: React.ReactNode;
  body: React.ReactNode;
}

/**
 * A ticket's non-empty sections in the schema's order. The grid lays them out
 * as tiles; the ticket view (`TicketDocument`) as one indexed column.
 */
export function ticketSectionEntries({
  sections,
  deliveryControl,
  environmentHead,
}: {
  sections: TicketSections;
  deliveryControl?: TicketDeliveryControl;
  environmentHead?: string;
}): TicketSectionEntry[] {
  const entries: TicketSectionEntry[] = [];
  for (const definition of TICKET_SECTION_DEFINITIONS) {
    const { key, heading } = definition;
    if (key === "notes") {
      (sections.custom ?? []).forEach((custom, index) => {
        entries.push({
          key: `custom-${index}`,
          title: custom.title,
          body: <MarkdownBody body={custom.body} />,
        });
      });
    }
    if (key === "acceptanceCriteria") {
      const items = sections.acceptanceCriteria ?? [];
      if (items.length) {
        entries.push({
          key,
          title: heading,
          wide: "double",
          aside: <CriteriaTally items={items} />,
          body: <AcceptanceCriteriaList items={items} environmentHead={environmentHead} />,
        });
      }
      continue;
    }
    if (key === "checks") {
      if (sections.checks?.length) {
        entries.push({
          key,
          title: heading,
          body: (
            <ul className="flex flex-col gap-1">
              {sections.checks.map((check, index) => (
                <li key={index} className="min-w-0 font-mono text-xs break-words">
                  {check}
                </li>
              ))}
            </ul>
          ),
        });
      }
      continue;
    }
    if (key === "delivery") {
      const delivery = sections.delivery;
      if (deliveryControl || delivery?.policy || delivery?.note) {
        entries.push({
          key,
          title: heading,
          body: (
            <>
              {deliveryControl ? (
                <DeliveryPolicySelect
                  value={delivery?.policy}
                  onChange={deliveryControl.onChange}
                  disabled={deliveryControl.disabled}
                />
              ) : delivery?.policy ? (
                <p data-testid="ticket-delivery-policy" className="text-sm font-medium">
                  {DELIVERY_POLICY_LABELS[delivery.policy]}
                </p>
              ) : null}
              {delivery?.note ? (
                <MarkdownBody
                  body={delivery.note}
                  className={deliveryControl || delivery.policy ? "mt-1" : ""}
                />
              ) : null}
              {deliveryControl?.tooLateNote ? (
                <p
                  role="status"
                  data-testid="ticket-delivery-too-late"
                  className="mt-2 text-xs text-amber-500"
                >
                  {deliveryControl.tooLateNote}
                </p>
              ) : null}
            </>
          ),
        });
      }
      continue;
    }
    const text = sections[key];
    if (text?.trim()) {
      entries.push({
        key,
        title: heading,
        wide: key === "summary" ? "full" : undefined,
        body: <MarkdownBody body={text} />,
      });
    }
  }
  return entries;
}

/**
 * A ticket's sections as a responsive grid of tiles, in the schema's order.
 * It sizes to its container, not the window, so it stacks to one column in a
 * narrow inspector or on a phone. Empty sections are left out. The pipeline's
 * Ticket node reads it; the ticket view lays the same entries out as one
 * column (`TicketDocument`).
 */
export function TicketSectionsGrid({
  sections,
  className,
  empty,
  deliveryControl,
  environmentHead,
}: {
  sections: TicketSections;
  className?: string;
  /** The build environment's HEAD now, when known; see {@link AcceptanceCriteriaList}. */
  environmentHead?: string;
  /** Shown when every section is empty. */
  empty?: React.ReactNode;
  /**
   * Makes the Delivery tile a dropdown that is always shown, for a ticket that
   * can still be edited. Absent, as for a pipeline's snapshot, it only reads.
   */
  deliveryControl?: TicketDeliveryControl;
}) {
  const entries = ticketSectionEntries({ sections, deliveryControl, environmentHead });
  if (entries.length === 0) return <>{empty ?? null}</>;
  const onlyTheDeliveryControl =
    deliveryControl &&
    entries.length === 1 &&
    !sections.delivery?.policy &&
    !sections.delivery?.note;
  return (
    <div className={cn("@container min-w-0", onlyTheDeliveryControl && "space-y-3", className)}>
      {onlyTheDeliveryControl ? empty : null}
      <div
        data-testid="ticket-sections-grid"
        className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-3"
      >
        {entries.map((entry) => (
          <Tile
            key={entry.key}
            id={entry.key}
            title={entry.title}
            wide={entry.wide}
            aside={entry.aside}
          >
            {entry.body}
          </Tile>
        ))}
      </div>
    </div>
  );
}
