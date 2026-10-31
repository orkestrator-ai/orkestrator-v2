import { useState } from "react";
import { NativeResumeSessionDialog } from "../../apps/web/src/components/chat/NativeResumeSessionDialog";

export function NativeResumeSessionFixture() {
  const [selected, setSelected] = useState("");
  const [archiveCalls, setArchiveCalls] = useState<string[]>([]);
  return (
    <>
      <output data-testid="selected-session">{selected}</output>
      <output data-testid="archive-calls">{archiveCalls.join(",")}</output>
      <NativeResumeSessionDialog
        open
        onOpenChange={() => {}}
        agentLabel="Pi"
        fetchSessions={async () => [
          {
            id: "fork",
            title: "Compare implementations",
            parentId: "parent",
            branchLabel: "Alternative implementation",
            activityAt: "2026-10-27",
          },
          { id: "parent", title: "Original implementation", activityAt: "2026-10-26" },
          {
            id: "kept",
            title: "A finished conversation with a much longer title than the others have",
            activityAt: "2026-10-28",
            archived: true,
          },
        ]}
        onArchive={async (id, archived) => {
          setArchiveCalls((calls) => [...calls, `${archived ? "archive" : "restore"}:${id}`]);
        }}
        onResume={setSelected}
      />
    </>
  );
}
