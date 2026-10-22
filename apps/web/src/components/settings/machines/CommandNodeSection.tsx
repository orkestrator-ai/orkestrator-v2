import { useState } from "react";
import { toast } from "sonner";
import type { NodeStatus } from "@orkestrator/protocol/command-nodes";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  allowController,
  detachControllerHere,
  nodeErrorText,
  setCommandNodeEnabled,
} from "@/lib/backend/command-nodes";
import { MachineSection, formatMachineTime } from "./machine-ui";

/**
 * The command-node side of the machine this client is connected to: whether
 * it may control other machines, and the command nodes controlling it.
 */
export function CommandNodeSection({
  status,
  onChanged,
}: {
  status: NodeStatus;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const leaf = status.mode === "leaf";

  const run = async (key: string, action: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    try {
      await action();
      if (success) toast.success(success);
      onChanged();
    } catch (error) {
      toast.error(nodeErrorText(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <MachineSection
      title="Command node"
      description="A command node keeps the list of machines it controls and connects to them itself. Their tokens stay on it; clients never receive them."
      testId="machine-command-node"
    >
      {!leaf ? (
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>
            <span className="text-zinc-200">Allow this machine to command others</span>
            <span className="block text-xs text-zinc-500">
              The desktop app&apos;s own backend always allows it.
            </span>
          </span>
          <Switch
            checked={status.registrationEnabled}
            disabled={busy !== null}
            onCheckedChange={(checked) =>
              void run("registration", () => setCommandNodeEnabled(checked))
            }
            aria-label="Allow this machine to command others"
          />
        </label>
      ) : null}

      {status.controllers.length > 0 || status.detachedControllers.length > 0 ? (
        <div className="space-y-2" data-testid="controllers">
          <p className="text-xs font-medium text-zinc-300">Controlled by</p>
          {status.controllers.map((controller) => (
            <div
              key={controller.controllerId}
              className="flex items-center justify-between gap-2 rounded-md border border-zinc-800 px-3 py-2 text-sm"
            >
              <span className="min-w-0">
                <span className="text-zinc-200">{controller.displayName}</span>
                <span className="block text-xs text-zinc-500">
                  Attached {formatMachineTime(controller.attachedAt) ?? "—"} · last contact{" "}
                  {formatMachineTime(controller.lastContactAt) ?? "—"}
                  {controller.controllerId === status.mostRecentControllerId
                    ? " (most recent)"
                    : ""}
                </span>
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() =>
                  void run(
                    controller.controllerId,
                    () => detachControllerHere(controller.controllerId),
                    `Detached ${controller.displayName}. Work on this machine keeps running.`,
                  )
                }
              >
                Detach
              </Button>
            </div>
          ))}
          {status.detachedControllers.map((controller) => (
            <div
              key={controller.controllerId}
              className="flex items-center justify-between gap-2 rounded-md border border-dashed border-zinc-800 px-3 py-2 text-xs text-zinc-500"
            >
              <span>
                {controller.displayName} was detached here{" "}
                {formatMachineTime(controller.detachedAt) ?? ""} and cannot attach again.
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy !== null}
                onClick={() =>
                  void run(controller.controllerId, () => allowController(controller.controllerId))
                }
              >
                Allow again
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </MachineSection>
  );
}
