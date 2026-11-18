import { useState } from "react";
import { WorkflowSnapshotGraph } from "../../apps/web/src/components/chat/rich/WorkflowSnapshotCardGraph";
import { ApprovalCard } from "../../apps/web/src/components/claude/ClaudeTmuxChatTab.parts";
import { OptionCards } from "../../apps/web/src/components/settings/agent/InheritedValue";
import { Button } from "../../apps/web/src/components/ui/button";
import { Checkbox } from "../../apps/web/src/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../../apps/web/src/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../apps/web/src/components/ui/dropdown-menu";
import { Input } from "../../apps/web/src/components/ui/input";

function MenuIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor">
      <circle cx="8" cy="8" r="4" />
    </svg>
  );
}

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
      <div role="radiogroup" aria-label="Agent" className="relative w-48">
        {/* The peer-radio card pattern (BuildLaunchDialog): the label draws the hairline. */}
        <input
          id="focus-agent-claude"
          type="radio"
          name="focus-agent"
          defaultChecked
          className="peer sr-only"
        />
        <label
          htmlFor="focus-agent-claude"
          className="flex cursor-pointer flex-col rounded-lg border px-3 py-2.5 focus-hairline-peer"
        >
          Claude
        </label>
      </div>
      <Button aria-invalid="true" variant="outline">
        Invalid control
      </Button>
      <Button>Solid fill</Button>
      <button className="rounded-full bg-blue-600 px-3 py-2 text-white focus-hairline focus-hairline-outset">
        Annotation fill
      </button>
      <div className="flex gap-4">
        <Checkbox aria-label="Unchecked" checked={false} />
        <Checkbox aria-label="Checked" checked />
        <Checkbox aria-label="Mixed" checked="indeterminate" />
      </div>
      <Input aria-label="Selection sample" defaultValue="Selected text" />
      <ApprovalCard
        approval={{ eventId: "approval-focus", toolName: "Read", toolInput: {} }}
        onApprove={() => {}}
        onDeny={() => {}}
      />
      <div className="flex gap-2">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <Button variant="outline">Context actions</Button>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem>Rename</ContextMenuItem>
            <ContextMenuItem variant="destructive">
              <MenuIcon />
              Delete
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">Dropdown actions</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Rename</DropdownMenuItem>
            <DropdownMenuItem variant="destructive">
              <MenuIcon />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </main>
  );
}
