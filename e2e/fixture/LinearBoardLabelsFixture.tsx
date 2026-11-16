import { LinearIssueBoard } from "../../apps/web/src/components/linear/LinearIssueBoard";
import type { LinearIssueListItem } from "../../apps/web/src/types/linear";

/** Real board and CSS, deterministic API-shaped label data, no Linear credentials. */
export function LinearBoardLabelsFixture() {
  const before = new URLSearchParams(location.search).has("before");
  const issue = (
    id: string,
    title: string,
    issueLabels?: LinearIssueListItem["issueLabels"],
  ): LinearIssueListItem => ({
    id,
    title,
    identifier: id,
    status: "Todo",
    updatedAt: "2026-11-16T00:00:00Z",
    issueLabels,
  });
  const labels = Array.from({ length: before ? 25 : 30 }, (_, n) => ({
    id: `l-${n}`,
    name: `Label ${n + 1}`,
    color: n % 2 ? "#4ea7fc" : "#eb5757",
  }));
  return (
    <main className="bg-background text-foreground p-4" style={{ maxWidth: 960 }}>
      <h1 className="mb-4 text-lg font-semibold">Linear board labels</h1>
      <LinearIssueBoard
        lanes={[
          {
            status: "Todo",
            type: "unstarted",
            issues: [
              issue("ENG-30", "Thirty labels", labels),
              issue("ENG-1", "Bug and frontend", [
                { name: "Bug", color: "#eb5757" },
                { name: "Frontend", color: "#4ea7fc" },
              ]),
              issue("ENG-2", "No labels", []),
              issue("ENG-3", "Older backend"),
              issue("ENG-4", "Invalid colour", [{ name: "Neutral", color: "invalid" }]),
            ],
          },
        ]}
        hidden={new Set()}
        onShowAll={() => undefined}
        onSelectIssue={() => undefined}
        pipelinePhase={() => undefined}
      />
    </main>
  );
}
