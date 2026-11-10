/**
 * Renders a digest as Markdown for a person or a coordinator to read. Holds
 * only what the digest holds: signatures, numbers and ledger references.
 */
import type { DigestRecord, DigestSignal, Judgement } from "./ledger.js";

export const DEFAULT_TOP = 15;

function cell(value: unknown): string {
  return String(value ?? "").replace(/\|/g, "\\|");
}

function table(headers: string[], rows: unknown[][]): string[] {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ];
}

function measure(value: number | null, unit: string): string {
  return value === null ? "–" : `${value} ${unit}`.trim();
}

function trend(signal: DigestSignal): string {
  if (signal.trend === "new") return "new";
  const arrow = signal.trend === "up" ? "↑" : signal.trend === "down" ? "↓" : "→";
  return `${arrow} from ${signal.previousValue}`;
}

function evidence(signal: DigestSignal): string {
  const parts = Object.entries(signal.evidence).map(([key, value]) => `${key}=${value}`);
  const versions = Object.entries(signal.versions)
    .map(([version, slice]) =>
      slice.value !== undefined ? `${version}: ${slice.value}` : `${version}: ${slice.count}`,
    )
    .join(", ");
  return [
    `count ${signal.count}`,
    `${signal.activeDays} active day(s)`,
    signal.firstAt ? `first ${signal.firstAt}` : null,
    signal.lastAt ? `last ${signal.lastAt}` : null,
    versions ? `by version ${versions}` : null,
    ...parts,
  ]
    .filter(Boolean)
    .join("; ");
}

function judgementRows(judgements: readonly Judgement[]): unknown[][] {
  return judgements.map((judgement) => [
    judgement.verdict,
    `\`${judgement.signature}\``,
    judgement.status,
    judgement.ticket ?? "",
    judgement.pr ?? "",
    judgement.fixedIn ?? "",
    measure(judgement.baseline, judgement.unit),
    measure(judgement.current, judgement.unit),
    measure(judgement.postFixValue, judgement.unit),
    judgement.postFixHours ?? "–",
  ]);
}

export function renderDigest(digest: DigestRecord, top: number = DEFAULT_TOP): string {
  const lines: string[] = [];
  const { bundle, window } = digest;
  lines.push(`# Self-improvement digest ${digest.id}`, "");
  lines.push(
    `Bundle exported ${bundle.createdAt || "at an unknown time"} by app ${bundle.appVersion} on ${bundle.platform}/${bundle.arch}.`,
    `Window ${window.from ?? "?"} to ${window.to ?? "?"} (${window.days} days).`,
    `Essential log: ${bundle.essentialEntries} entries${bundle.essentialUnreadable ? ` (${bundle.essentialUnreadable} unreadable lines)` : ""}. Health rows: ${bundle.healthRows}. Database figures: ${bundle.hasDatabase ? "yes" : "no"}.`,
  );
  if (bundle.absent.length > 0) lines.push(`Not in the bundle: ${bundle.absent.join(", ")}.`);
  if (digest.previousDigestId) lines.push(`Trends compare with digest ${digest.previousDigestId}.`);
  else lines.push("No earlier digest: every signal is reported as new.");
  lines.push("");

  const attention = digest.judgements.filter((judgement) =>
    ["regressed", "unchanged", "partly-improved", "improved"].includes(judgement.verdict),
  );
  lines.push("## Ledger verdicts", "");
  if (digest.judgements.length === 0) {
    lines.push("The ledger is empty.", "");
  } else {
    if (attention.length > 0) {
      lines.push(
        `${attention.length} with a result. The run confirms \`improved\` and moves \`unchanged\` and \`regressed\` back to the backlog; \`partly-improved\` is your call. Status is as it was before the run.`,
        "",
      );
    }
    lines.push(
      ...table(
        [
          "Verdict",
          "Signature",
          "Status",
          "Ticket",
          "PR",
          "Fixed in",
          "Baseline",
          "Now (all versions)",
          "After fix",
          "Watched (h, or conversations)",
        ],
        judgementRows(digest.judgements),
      ),
      "",
    );
  }

  const untracked = digest.signals.filter((signal) => signal.ledger === null);
  const queue = untracked.slice(0, top);
  lines.push("## Triage queue", "");
  if (queue.length === 0) {
    lines.push("No untracked signals.", "");
  } else {
    lines.push(
      `The ${queue.length} highest-scoring signals with no ledger entry${untracked.length > queue.length ? ` (of ${untracked.length})` : ""}.`,
      "",
      ...table(
        ["#", "Score", "Category", "Signature", "Measure", "Trend", "Days", "Last seen"],
        queue.map((signal, index) => [
          index + 1,
          signal.score,
          signal.category,
          `\`${signal.signature}\``,
          measure(signal.measure.value, signal.measure.unit),
          trend(signal),
          signal.activeDays,
          signal.lastAt ?? "",
        ]),
      ),
      "",
    );
    for (const [index, signal] of queue.entries()) {
      lines.push(`${index + 1}. **${signal.title}** (${signal.source}): ${evidence(signal)}`);
    }
    lines.push("");
  }

  const tracked = digest.signals.filter(
    (signal) => signal.ledger !== null && signal.ledger.status !== "ignored",
  );
  if (tracked.length > 0) {
    lines.push("## Tracked signals in this bundle", "");
    lines.push(
      ...table(
        ["Signature", "Status", "Ticket", "Measure", "Trend"],
        tracked.map((signal) => [
          `\`${signal.signature}\``,
          signal.ledger!.status,
          signal.ledger!.ticket ?? "",
          measure(signal.measure.value, signal.measure.unit),
          trend(signal),
        ]),
      ),
      "",
    );
  }

  if (digest.gone.length > 0) {
    lines.push("## Gone since the previous digest", "");
    for (const gone of digest.gone)
      lines.push(`- \`${gone.signature}\` (was ${gone.previousValue}): ${gone.title}`);
    lines.push("");
  }

  lines.push("## Hours observed by app version", "");
  const sources = Object.entries(digest.observedHours);
  const versions = [...new Set(sources.flatMap(([, hours]) => Object.keys(hours)))].sort();
  if (versions.length === 0) {
    lines.push("None.", "");
  } else {
    lines.push(
      ...table(
        [
          "Version",
          ...sources.map(([source]) =>
            source === "insights" ? "insights (conversations read)" : source,
          ),
        ],
        versions.map((version) => [version, ...sources.map(([, hours]) => hours[version] ?? 0)]),
      ),
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}
