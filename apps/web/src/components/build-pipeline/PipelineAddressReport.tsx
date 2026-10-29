import type { PipelineFixResult } from "@orkestrator/protocol/build-pipeline-address-report";
import { cn } from "@/lib/utils";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function omittedNote(count: number | undefined): string | null {
  return count ? `and ${count} more` : null;
}

/**
 * The typed report an Address session submitted, as Verify read it: the
 * session's bounded `fixResult`. Collapsed to one summary line; the lists open
 * on demand. Shown only for Address sessions that have one.
 */
export function PipelineAddressReport({ result }: { result: PipelineFixResult }) {
  const failed = result.commandsRun.filter((command) => command.result === "failed").length;
  const facts = [
    result.complete ? "complete" : "incomplete",
    plural(result.filesChanged.length + (result.omitted?.filesChanged ?? 0), "file"),
    `${plural(result.commandsRun.length + (result.omitted?.commandsRun ?? 0), "check")}${failed > 0 ? ` (${failed} failed)` : ""}`,
  ];
  const sections: Array<{ label: string; entries: string[]; omitted?: number; mono?: boolean }> = [
    {
      label: "Files changed",
      entries: result.filesChanged,
      omitted: result.omitted?.filesChanged,
      mono: true,
    },
    { label: "Notes", entries: result.notes, omitted: result.omitted?.notes },
    { label: "Limitations", entries: result.limitations, omitted: result.omitted?.limitations },
  ];
  return (
    <details
      data-testid="pipeline-address-report"
      className="rounded-md border border-border/45 bg-background/30 px-3 py-2 text-foreground"
    >
      <summary className="cursor-pointer select-none text-xs">
        <span className="font-medium">Address report</span>
        <span className="text-muted-foreground"> · {facts.join(" · ")}</span>
      </summary>
      <div className="mt-2 flex flex-col gap-2 text-xs leading-relaxed">
        <p className="break-words whitespace-pre-wrap">{result.summary}</p>
        {result.commandsRun.length > 0 ? (
          <section aria-label="Checks run">
            <p className="text-muted-foreground">Checks run</p>
            <ul className="mt-1 space-y-1">
              {result.commandsRun.map((command, index) => (
                <li key={index} className="min-w-0">
                  <span
                    className={cn(
                      "mr-1.5 font-medium",
                      command.result === "failed" ? "text-failure" : "text-muted-foreground",
                    )}
                  >
                    {command.result}
                  </span>
                  <code className="break-all">{command.command}</code>
                  <span className="text-muted-foreground"> · {command.summary}</span>
                </li>
              ))}
              {omittedNote(result.omitted?.commandsRun) ? (
                <li className="text-muted-foreground">
                  {omittedNote(result.omitted?.commandsRun)}
                </li>
              ) : null}
            </ul>
          </section>
        ) : null}
        {sections
          .filter((section) => section.entries.length > 0)
          .map((section) => (
            <section key={section.label} aria-label={section.label}>
              <p className="text-muted-foreground">{section.label}</p>
              <ul className={cn("mt-1 space-y-1", section.mono && "font-mono")}>
                {section.entries.map((entry, index) => (
                  <li key={index} className="break-words">
                    {entry}
                  </li>
                ))}
                {omittedNote(section.omitted) ? (
                  <li className="text-muted-foreground">{omittedNote(section.omitted)}</li>
                ) : null}
              </ul>
            </section>
          ))}
        <p className="text-muted-foreground">
          The Address stage&apos;s own claims; Verify checks them against the diff.
        </p>
      </div>
    </details>
  );
}
