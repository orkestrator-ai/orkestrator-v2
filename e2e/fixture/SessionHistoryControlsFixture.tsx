import { useState } from "react";
import { useMessageRewind } from "../../apps/web/src/components/native-agent/MessageRewindAction";
import { SessionBranchPicker } from "../../apps/web/src/components/native-agent/SessionBranchPicker";
import type { NativeMessage } from "../../apps/web/src/lib/chat/native-message-types";

const prompt: NativeMessage = {
  id: "prompt",
  role: "user",
  content: "Try another approach",
  turnId: "turn",
  parts: [{ type: "text", content: "Try another approach" }],
  createdAt: "2026-11-09T12:00:00Z",
};

export function SessionHistoryControlsFixture() {
  const [draft, setDraft] = useState("");
  const [rewound, setRewound] = useState(false);
  const [switched, setSwitched] = useState(false);
  const fail = new URLSearchParams(location.search).has("fail");
  const rewind = useMessageRewind({
    platform: "pi",
    agentLabel: "Pi",
    enabled: true,
    messages: [prompt],
    responseInProgress: false,
    disabled: false,
    performAction: async () => {
      if (fail) throw new Error("Rewind unavailable");
      setRewound(true);
      return { outcome: "applied" };
    },
    composerHasDraft: () => draft.length > 0,
    restoreDraft: (value) => setDraft(value.text),
  });
  return (
    <main className="p-6 space-y-4">
      <p>{prompt.content}</p>
      {rewind.renderRewindAction(prompt.id)}
      {rewind.dialog}
      <textarea
        aria-label="Draft"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <output>{rewound ? "Rewound" : "Original"}</output>
      <SessionBranchPicker
        agentLabel="Pi"
        disabled={false}
        listBranches={async () => {
          if (fail) throw new Error("Branches unavailable");
          return {
            activeEntryId: switched ? "old" : "current",
            truncated: false,
            branches: switched
              ? []
              : [
                  {
                    entryId: "old",
                    prompt: "Earlier approach",
                    entries: 2,
                    updatedAt: "2026-11-09T12:00:00Z",
                  },
                ],
          };
        }}
        switchBranch={async () => {
          setSwitched(true);
        }}
      />
    </main>
  );
}
