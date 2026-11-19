import { useState } from "react";

import type { CapabilityOperationSnapshot } from "@orkestrator/protocol/capability-resources";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { capabilitiesApi } from "@/lib/backend/capabilities";

import { SettingsPageLayout } from "../SettingsPageLayout";
import { SkillsSettings } from "../SkillsSettings";
import { AddCapabilityDialog } from "./AddCapabilityDialog";
import { ChangePreview } from "./ChangePreview";
import { describeError } from "./capability-format";
import { ActivityView, MachinesView, SetupsView, UpdatesView } from "./FleetViews";
import { LibraryView } from "./LibraryView";
import { PackageDetail } from "./PackageDetail";
import { useCapabilityResource } from "./useCapabilityResource";

export type CapabilitiesTab =
  "library" | "setups" | "machines" | "updates" | "activity" | "installed";

const TABS: Array<{ id: CapabilitiesTab; label: string }> = [
  { id: "library", label: "My library" },
  { id: "setups", label: "Setups" },
  { id: "machines", label: "Machines" },
  { id: "updates", label: "Updates" },
  { id: "activity", label: "Activity" },
  { id: "installed", label: "Installed on this machine" },
];

/**
 * Settings → Capabilities: one manager for skills, native plugins, MCP
 * servers, commands, prompts and hooks across every agent and enrolled
 * machine (docs/architecture/agent-capabilities-management.md). The views are
 * filters over one model; "Installed on this machine" is the read-only
 * browser of the provider directories it replaces as the entry point.
 */
export function CapabilitiesSettings({ initialTab = "library" }: { initialTab?: CapabilitiesTab }) {
  const [tab, setTab] = useState<CapabilitiesTab>(initialTab);
  const [openPackage, setOpenPackage] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [activityPackage, setActivityPackage] = useState<string | undefined>(undefined);
  const [updatePreview, setUpdatePreview] = useState<CapabilityOperationSnapshot | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const setups = useCapabilityResource(() => capabilitiesApi.listCapabilitySetups(), []);
  const machines = useCapabilityResource(() => capabilitiesApi.listCapabilityMachines(), []);
  const setupList = setups.state.data?.setups ?? [];
  const machineList = machines.state.data?.machines ?? [];
  const machineNames = Object.fromEntries(
    machineList.map((machine) => [machine.nodeId, machine.name]),
  );
  const loadError = setups.state.status === "error" ? setups.state.message : null;

  return (
    <SettingsPageLayout
      width="wide"
      title="Capabilities"
      description="Add a skill, plugin, MCP server, command or prompt once, choose where to use it, and see exactly which agents and machines have it. Permissions stay in Permissions: a capability can never widen what a session is allowed to do."
    >
      {loadError ? (
        <p className="text-sm text-rose-300" role="alert">
          {loadError}
        </p>
      ) : null}
      {notice ? (
        <p className="text-xs text-sky-300" role="status">
          {notice}
        </p>
      ) : null}
      <Tabs
        value={tab}
        onValueChange={(value) => {
          setTab(value as CapabilitiesTab);
          setOpenPackage(null);
        }}
      >
        <TabsList variant="underline" className="flex-wrap">
          {TABS.map((entry) => (
            <TabsTrigger key={entry.id} value={entry.id} className="h-7 text-xs">
              {entry.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="library" className="pt-4">
          {openPackage ? (
            <PackageDetail
              packageId={openPackage}
              machines={machineList}
              setups={setupList}
              onBack={() => setOpenPackage(null)}
              onShowActivity={(packageId) => {
                setActivityPackage(packageId);
                setTab("activity");
              }}
              onShowInstalled={() => setTab("installed")}
            />
          ) : (
            <LibraryView setups={setupList} onOpen={setOpenPackage} onAdd={() => setAdding(true)} />
          )}
        </TabsContent>
        <TabsContent value="setups" className="pt-4">
          <SetupsView setups={setupList} reload={setups.reload} />
        </TabsContent>
        <TabsContent value="machines" className="pt-4">
          <MachinesView machines={machineList} reload={machines.reload} />
        </TabsContent>
        <TabsContent value="updates" className="pt-4">
          <UpdatesView
            onPreview={(updateId) =>
              void capabilitiesApi
                .previewCapabilityUpdate(updateId)
                .then((result) => setUpdatePreview(result.operation))
                .catch((error: unknown) => setNotice(describeError(error)))
            }
          />
        </TabsContent>
        <TabsContent value="activity" className="pt-4">
          <ActivityView
            packageId={activityPackage}
            onClearFilter={() => setActivityPackage(undefined)}
          />
        </TabsContent>
        <TabsContent value="installed" className="pt-4">
          <SkillsSettings
            embedded={false}
            description="What each agent's own directories hold on the machine Settings shows, managed by Orkestrator or not. Adopt an item from My library → Add → Already installed."
          />
        </TabsContent>
      </Tabs>
      <AddCapabilityDialog
        open={adding}
        onOpenChange={setAdding}
        machines={machineList}
        setups={setupList}
        onDone={(operation) => {
          setNotice(
            operation.summary.total === 0
              ? "Added to your library."
              : `Applying to ${operation.summary.total} target(s). Statuses update as each machine reports back.`,
          );
          setups.reload();
        }}
      />
      <Dialog
        open={updatePreview !== null}
        onOpenChange={(open) => !open && setUpdatePreview(null)}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Review the update</DialogTitle>
            <DialogDescription>
              The previous revision is kept for rollback. Rolling back cannot undo work a tool
              already did.
            </DialogDescription>
          </DialogHeader>
          {updatePreview ? (
            <ChangePreview
              operation={updatePreview}
              machineNames={machineNames}
              componentNames={{}}
              onCancel={() => setUpdatePreview(null)}
              onApplied={() => {
                setUpdatePreview(null);
                setNotice("Update approved; machines are applying it.");
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </SettingsPageLayout>
  );
}
