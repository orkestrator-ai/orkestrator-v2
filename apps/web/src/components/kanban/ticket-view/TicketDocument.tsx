import { useRef, type ReactNode, type RefObject } from "react";

import {
  useKeepActiveEntryInView,
  useKeyInformationSectionNav,
} from "@/components/build-pipeline/key-information-section-nav";
import { cn } from "@/lib/utils";

/** One section of a ticket view tab: an index entry and its place in the column. */
export interface TicketDocumentSection {
  key: string;
  title: string;
  /** Beside the heading: a tally, a count. */
  meta?: ReactNode;
  /** Kept from the tile layout, so `ticket-tile-<key>` still names a section. */
  testId?: string;
  body: ReactNode;
}

/**
 * The layout the full-tab Notes page uses, for a ticket: a narrow index down
 * the left whose links jump to each section, and every section in one wide
 * column on the right, never side by side. The index shows once the view is
 * wide enough for both (`@3xl`); narrower, the column alone scrolls.
 */
export function TicketDocument({
  sections,
  scrollRef,
  label,
}: {
  sections: readonly TicketDocumentSection[];
  scrollRef: RefObject<HTMLDivElement | null>;
  /** The index's accessible name. */
  label: string;
}) {
  const navRef = useRef<HTMLUListElement>(null);
  const { activeKey, jumpTo, sectionId } = useKeyInformationSectionNav(
    scrollRef,
    sections.map((section) => section.key),
  );
  useKeepActiveEntryInView(navRef, activeKey);
  return (
    <div className="mx-auto flex w-full max-w-7xl gap-10 px-4 py-6 @3xl:px-8">
      <nav aria-label={label} className="sticky top-6 hidden w-44 shrink-0 self-start @3xl:block">
        <div className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          On this ticket
        </div>
        <ul
          ref={navRef}
          className="flex max-h-[calc(100vh-14rem)] flex-col gap-0.5 overflow-y-auto border-l border-border/60"
        >
          {sections.map((section) => (
            <li key={section.key}>
              <a
                href={`#${sectionId(section.key)}`}
                aria-current={section.key === activeKey ? "location" : undefined}
                className={cn(
                  "-ml-px block truncate border-l py-1 pl-3 text-xs transition-colors focus-hairline",
                  section.key === activeKey
                    ? "border-foreground font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:border-foreground/40 hover:text-foreground",
                )}
                onClick={(event) => {
                  // The column scrolls, not the page: a hash change would move the dialog.
                  event.preventDefault();
                  jumpTo(section.key);
                }}
              >
                {section.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col gap-8" data-testid="ticket-document-column">
        {sections.map((section) => (
          <section
            key={section.key}
            id={sectionId(section.key)}
            aria-label={section.title}
            data-testid={section.testId}
            className="min-w-0 scroll-mt-4"
          >
            <div className="mb-3 flex items-baseline gap-2 border-b border-border/50 pb-1.5">
              <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {section.title}
              </h2>
              {section.meta ? (
                <span className="text-xs text-muted-foreground/80">{section.meta}</span>
              ) : null}
            </div>
            {section.body}
          </section>
        ))}
      </div>
    </div>
  );
}
