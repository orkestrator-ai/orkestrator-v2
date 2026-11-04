import { useState } from "react";
import { WorkflowSnapshotGraph } from "../../apps/web/src/components/chat/rich/WorkflowSnapshotCardGraph";
import { OptionCards } from "../../apps/web/src/components/settings/agent/InheritedValue";
import { AgentRadioGroup } from "../../apps/web/src/components/agents/AgentRadioGroup";
import { Button } from "../../apps/web/src/components/ui/button";

export function FocusVisibilityFixture() {
  const [selected, setSelected] = useState<string | null>("selected");
  return (
    <main className="min-h-screen bg-background p-6 text-foreground space-y-6">
      <h1>Keyboard focus visibility</h1>
      <WorkflowSnapshotGraph
        label="Workflow focus"
        nodes={["selected", "unselected"].map((id) => ({
          id,
          label: id,
          role: "agent",
          status: "pending",
          links: [],
        }))}
        edges={[]}
        selectedId={selected}
        onSelect={setSelected}
      />
      <OptionCards
        ariaLabel="Options"
        value="selected"
        onChange={() => {}}
        options={[{ value: "selected", label: "Selected option" }]}
      />
      <AgentRadioGroup label="Agent" value="claude" onChange={() => {}} />
      <Button aria-invalid="true" variant="outline">
        Invalid control
      </Button>
      <Button>Solid fill</Button>
      <button className="rounded-full bg-blue-600 px-3 py-2 text-white focus-hairline focus-hairline-outset">
        Annotation fill
      </button>
    </main>
  );
}
