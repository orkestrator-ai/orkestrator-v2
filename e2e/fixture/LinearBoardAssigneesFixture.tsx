import { LinearIssueBoard } from "../../apps/web/src/components/linear/LinearIssueBoard";
import type { LinearIssueListItem } from "../../apps/web/src/types/linear";

/** A local stand-in for a Linear avatar image, so the fixture needs no network. */
const AVATAR = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6b7280"/><stop offset="1" stop-color="#111827"/></linearGradient></defs><rect width="40" height="40" fill="url(#g)"/><circle cx="20" cy="15" r="7" fill="#e5e7eb"/><path d="M6 40c2-9 8-13 14-13s12 4 14 13z" fill="#e5e7eb"/></svg>',
)}`;

/** Real board and CSS, deterministic API-shaped assignee data, no Linear credentials. */
export function LinearBoardAssigneesFixture() {
  const issue = (
    id: string,
    title: string,
    assignee: Pick<
      LinearIssueListItem,
      "assigneeName" | "assigneeAvatarUrl" | "assigneeAvatarColor"
    > = {},
    rest: Partial<LinearIssueListItem> = {},
  ): LinearIssueListItem => ({
    id,
    title,
    identifier: id,
    status: "In Progress",
    updatedAt: "2026-11-16T00:00:00Z",
    ...assignee,
    ...rest,
  });
  return (
    <main className="bg-background text-foreground p-4" style={{ maxWidth: 960 }}>
      <h1 className="mb-4 text-lg font-semibold">Linear board assignees</h1>
      <LinearIssueBoard
        lanes={[
          {
            status: "In Progress",
            type: "started",
            issues: [
              issue(
                "DND-17",
                "Book calls",
                { assigneeName: "Arkaydeus", assigneeAvatarUrl: AVATAR },
                { priorityLabel: "High", issueLabels: [{ name: "Research", color: "#4ea7fc" }] },
              ),
              issue("DND-13", "Conduct D&D expert interviews to validate product direction", {
                assigneeName: "Grace Hopper",
                assigneeAvatarColor: "#5e6ad2",
              }),
              issue("DND-12", "Broken avatar image", {
                assigneeName: "Ada Lovelace",
                assigneeAvatarUrl: "https://127.0.0.1:9/missing-avatar.png",
                assigneeAvatarColor: "#eb5757",
              }),
              issue("DND-11", "Older backend sends only the name", { assigneeName: "Linus" }),
              issue("DND-10", "Unassigned issue"),
            ],
          },
        ]}
        hidden={new Set()}
        onShowAll={() => undefined}
        onSelectIssue={() => undefined}
        pipelinePhase={(issueId) => (issueId === "DND-13" ? "Building" : undefined)}
      />
    </main>
  );
}
