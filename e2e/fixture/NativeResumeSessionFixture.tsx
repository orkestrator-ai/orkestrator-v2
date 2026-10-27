import { useState } from "react";
import { NativeResumeSessionDialog } from "../../apps/web/src/components/chat/NativeResumeSessionDialog";

export function NativeResumeSessionFixture() {
  const [selected, setSelected] = useState("");
  return (
    <>
      <output data-testid="selected-session">{selected}</output>
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
        ]}
        onResume={setSelected}
      />
    </>
  );
}
