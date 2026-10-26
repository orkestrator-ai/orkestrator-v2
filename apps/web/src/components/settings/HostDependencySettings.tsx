import { useState } from "react";
import { Container, Loader2, Wrench } from "lucide-react";
import { toast } from "sonner";
import type {
  HostImageStatus,
  HostMaintenanceSnapshot,
  HostTask,
  HostTaskKind,
  HostToolStatus,
} from "@orkestrator/protocol/host-maintenance";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Z_FULLSCREEN_DIALOG } from "@/constants/z-index";
import type { HostMaintenanceClient } from "@/lib/host-maintenance-client";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function TaskStatus({ task }: { task: HostTask | undefined }) {
  if (!task) return null;
  const finished = task.completedAt ? new Date(task.completedAt).toLocaleString() : null;
  const text =
    task.state === "running"
      ? (task.stage ?? "Working…")
      : task.state === "failed"
        ? `Failed: ${task.error ?? "unknown error"}`
        : `Done${finished ? ` ${finished}` : ""}.`;
  return (
    <p
      role="status"
      className={
        task.state === "failed" ? "text-sm text-destructive" : "text-sm text-muted-foreground"
      }
    >
      {task.state === "running" && (
        <Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      )}
      {text}
    </p>
  );
}

function sourceLabel(tool: HostToolStatus): string {
  if (tool.source === "managed") return tool.installedVersion ?? "version unavailable";
  if (tool.source === "path") return "on PATH (not managed)";
  return "missing";
}

export type OutdatedEnvironment = HostImageStatus["outdatedEnvironments"][number];

/** The pinned toolchain, gh's channel, and the container image of the host. */
export function HostDependencySettings({
  client,
  snapshot,
  accept,
  onRebuildEnvironment,
}: {
  client: HostMaintenanceClient;
  snapshot: HostMaintenanceSnapshot;
  accept: (snapshot: HostMaintenanceSnapshot) => void;
  /**
   * Opens one outdated environment's Rebuild (keep work), which carries its
   * own preservation and capacity checks. Absent: the list only names them.
   */
  onRebuildEnvironment?: (environment: OutdatedEnvironment) => void;
}) {
  const [starting, setStarting] = useState<HostTaskKind | null>(null);
  const [confirmGh, setConfirmGh] = useState<"pinned" | "latest" | null>(null);
  const tasks = snapshot.tasks;
  const nextPins = snapshot.nextRelease?.tools ?? {};

  const start = async (kind: HostTaskKind, run: () => Promise<HostTask>) => {
    setStarting(kind);
    try {
      await run();
      accept(await client.getHostMaintenance());
    } catch (failure) {
      toast.error(errorText(failure));
    } finally {
      setStarting(null);
    }
  };

  const tools = snapshot.tools ?? [];
  const repairNeeded = tools.some((tool) => tool.source !== "managed");
  const image = snapshot.image;

  return (
    <>
      <section className="space-y-4">
        <div>
          <h3 className="text-sm font-medium">Agent tools</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            The command-line tools this Orkestrator release pins, as the host has them. Newer
            versions arrive with Orkestrator updates
            {snapshot.nextRelease
              ? `; ${snapshot.nextRelease.version} brings the versions shown`
              : ""}
            .
          </p>
        </div>
        {tools.length > 0 ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 font-normal">Tool</th>
                <th className="py-1 font-normal">Pinned</th>
                <th className="py-1 font-normal">On the host</th>
                {snapshot.nextRelease && <th className="py-1 font-normal">Next release</th>}
              </tr>
            </thead>
            <tbody>
              {tools.map((tool) => (
                <tr key={tool.name} className="border-t border-border/40">
                  <td className="py-1.5 font-mono">{tool.name}</td>
                  <td className="py-1.5 font-mono">{tool.pinnedVersion}</td>
                  <td
                    className={
                      tool.source === "managed" ? "py-1.5 font-mono" : "py-1.5 text-amber-500"
                    }
                  >
                    {sourceLabel(tool)}
                    {tool.channel === "latest" && " (newest release)"}
                  </td>
                  {snapshot.nextRelease && (
                    <td className="py-1.5 font-mono">
                      {nextPins[tool.name] && nextPins[tool.name] !== tool.pinnedVersion
                        ? nextPins[tool.name]
                        : "—"}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-muted-foreground">Tool status is not available.</p>
        )}
        <TaskStatus task={tasks["toolchain-repair"]} />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={repairNeeded ? "default" : "outline"}
            size="sm"
            disabled={starting !== null || tasks["toolchain-repair"]?.state === "running"}
            onClick={() => void start("toolchain-repair", client.startHostToolchainRepair)}
          >
            {starting === "toolchain-repair" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Repair agent tools
          </Button>
        </div>
        <div className="flex items-center justify-between gap-4 rounded-md border border-border/60 p-3">
          <div>
            <Label htmlFor="host-gh-latest" className="text-sm">
              Follow the newest gh release
            </Label>
            <p className="mt-1 text-xs text-muted-foreground">
              Unqualified: this Orkestrator was tested with gh{" "}
              {tools.find((tool) => tool.name === "gh")?.pinnedVersion ?? "its pin"}.
            </p>
            <TaskStatus task={tasks["gh-update"]} />
          </div>
          <Switch
            id="host-gh-latest"
            checked={snapshot.ghChannel === "latest"}
            disabled={starting !== null || tasks["gh-update"]?.state === "running"}
            onCheckedChange={(checked) => setConfirmGh(checked ? "latest" : "pinned")}
          />
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h3 className="text-sm font-medium">Container image</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            New container environments start from this image. Running environments keep theirs until
            they are rebuilt.
          </p>
        </div>
        {image === undefined ? (
          <p className="text-sm text-muted-foreground">Checking the image…</p>
        ) : image === null ? (
          <p className="text-sm text-muted-foreground">Docker is not reachable on the host.</p>
        ) : (
          <div className="space-y-2 text-sm">
            <p>
              <span className="font-mono">{image.name}</span>
              <span className="text-muted-foreground">
                {!image.present
                  ? " · not installed"
                  : image.compatible
                    ? " · compatible"
                    : " · not compatible with this backend"}
              </span>
            </p>
            {image.reason && <p className="text-muted-foreground">{image.reason}</p>}
            {image.outdatedEnvironments.length > 0 && (
              <div>
                <p className="text-muted-foreground">
                  {onRebuildEnvironment
                    ? "Still on an older image. Each rebuild keeps the environment's work and checks its own space first:"
                    : "Still on an older image — rebuild each from its environment menu (Settings → Container → Rebuild, keeping work):"}
                </p>
                {onRebuildEnvironment ? (
                  <ul className="mt-1 space-y-1">
                    {image.outdatedEnvironments.map((environment) => (
                      <li key={environment.id} className="flex items-center justify-between gap-3">
                        <span className="min-w-0 truncate">{environment.name}</span>
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={`Rebuild ${environment.name}`}
                          onClick={() => onRebuildEnvironment(environment)}
                        >
                          Rebuild…
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <ul className="mt-1 list-inside list-disc">
                    {image.outdatedEnvironments.map((environment) => (
                      <li key={environment.id}>{environment.name}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
        <TaskStatus task={tasks["image-update"]} />
        <Button
          variant="outline"
          size="sm"
          disabled={
            starting !== null || tasks["image-update"]?.state === "running" || image === null
          }
          onClick={() => void start("image-update", client.startHostImageUpdate)}
        >
          {starting === "image-update" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Container className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          Pull {image?.releaseReference ?? "the release image"}
        </Button>
      </section>

      <AlertDialog open={confirmGh !== null} onOpenChange={(open) => !open && setConfirmGh(null)}>
        <AlertDialogContent className={Z_FULLSCREEN_DIALOG} overlayClassName={Z_FULLSCREEN_DIALOG}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmGh === "latest"
                ? "Follow the newest gh release?"
                : "Go back to the pinned gh?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmGh === "latest"
                ? "The host downloads the newest gh release, checks it against GitHub's published checksums, and uses it from then on. It has not been tested with this Orkestrator release."
                : "The host goes back to the gh this Orkestrator release pins."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const channel = confirmGh;
                setConfirmGh(null);
                if (channel) void start("gh-update", () => client.setHostGhChannel(channel));
              }}
            >
              {confirmGh === "latest" ? "Use the newest gh" : "Use the pinned gh"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
