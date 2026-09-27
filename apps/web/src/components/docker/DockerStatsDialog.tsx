import { useState, useEffect, useCallback } from "react";
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
import { Progress } from "@/components/ui/progress";
import {
  Loader2,
  Container,
  RefreshCw,
  Trash2,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Square,
  Link2,
} from "lucide-react";
import { Z_FULLSCREEN_DIALOG, Z_FULLSCREEN_DIALOG_POPOVER } from "@/constants/z-index";
import * as backend from "@/lib/backend";
import {
  FullscreenSettingsLayout,
  type SettingsMenuItem,
} from "@/components/settings/FullscreenSettingsLayout";
import type { DockerSystemStats, ContainerInfo } from "@/lib/backend";
import { useProjectStore, useEnvironmentStore } from "@/stores";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatBytes, formatRelativeTime } from "./docker-stats-format";
import { DockerImageStatusPanel } from "./DockerImageStatusPanel";
import { DockerCleanupReview } from "./DockerCleanupReview";

interface DockerStatsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** A container nothing claims; older backends omit `cleanupExclusion`. */
function isUnclaimedContainer(container: ContainerInfo): boolean {
  if (container.isAssigned) return false;
  return container.cleanupExclusion === undefined || container.cleanupExclusion === null;
}

export function DockerStatsDialog({ open, onOpenChange }: DockerStatsDialogProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<DockerSystemStats | null>(null);
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [showCleanupReview, setShowCleanupReview] = useState(false);
  // Track individual container operations
  const [stoppingContainerId, setStoppingContainerId] = useState<string | null>(null);
  const [deletingContainerId, setDeletingContainerId] = useState<string | null>(null);

  // Get project lookup function and projects list
  const getProjectById = useProjectStore((state) => state.getProjectById);
  const projects = useProjectStore((state) => state.projects);

  // Get environment store action to add reattached environments
  const addEnvironment = useEnvironmentStore((state) => state.addEnvironment);

  // Reattach dialog state
  const [showReattachDialog, setShowReattachDialog] = useState(false);
  const [reattachingContainer, setReattachingContainer] = useState<ContainerInfo | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [reattachName, setReattachName] = useState<string>("");
  const [isReattaching, setIsReattaching] = useState(false);

  // Count orphaned containers
  const orphanedCount = containers.filter(isUnclaimedContainer).length;

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [statsData, containersData] = await Promise.all([
        backend.getDockerSystemStats(),
        backend.getOrkestratorContainers(),
      ]);
      setStats(statsData);
      setContainers(containersData);
    } catch (err) {
      console.error("[DockerStatsDialog] Failed to load data:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Load data when dialog opens
  useEffect(() => {
    if (open) {
      loadData();
    } else {
      // Reset state when closing
      setStats(null);
      setContainers([]);
      setError(null);
    }
  }, [open, loadData]);

  const handleStopContainer = async (containerId: string) => {
    setStoppingContainerId(containerId);
    setError(null);
    try {
      await backend.dockerStopContainer(containerId);
      // Refresh the containers list
      const containersData = await backend.getOrkestratorContainers();
      setContainers(containersData);
    } catch (err) {
      console.error("[DockerStatsDialog] Stop container failed:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStoppingContainerId(null);
    }
  };

  const handleDeleteContainer = async (containerId: string) => {
    setDeletingContainerId(containerId);
    setError(null);
    try {
      await backend.dockerRemoveContainer(containerId);
      // Refresh the containers list
      const containersData = await backend.getOrkestratorContainers();
      setContainers(containersData);
    } catch (err) {
      console.error("[DockerStatsDialog] Delete container failed:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingContainerId(null);
    }
  };

  const openReattachDialog = (container: ContainerInfo) => {
    setReattachingContainer(container);
    setReattachName(container.name);
    setSelectedProjectId("");
    setShowReattachDialog(true);
  };

  const handleReattach = async () => {
    if (!reattachingContainer || !selectedProjectId) return;

    setIsReattaching(true);
    setError(null);

    try {
      const newEnvironment = await backend.reattachContainer(
        selectedProjectId,
        reattachingContainer.id,
        reattachName || undefined,
      );
      // Add the new environment to the store so sidebar updates immediately
      addEnvironment(newEnvironment);
      // Refresh the containers list
      const containersData = await backend.getOrkestratorContainers();
      setContainers(containersData);
      // Close dialog
      setShowReattachDialog(false);
      setReattachingContainer(null);
      setSelectedProjectId("");
      setReattachName("");
    } catch (err) {
      console.error("[DockerStatsDialog] Reattach failed:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsReattaching(false);
    }
  };

  const dockerMenuItems: SettingsMenuItem[] = [
    { id: "containers", label: "Containers", icon: <Container className="h-4 w-4" /> },
  ];

  const renderDockerSection = () => {
    if (error) {
      return (
        <div className="flex items-center gap-2 p-3 rounded-md bg-destructive/10 text-destructive text-sm">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      );
    }
    if (isLoading) {
      return (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <span className="ml-2 text-muted-foreground">Loading Docker stats...</span>
        </div>
      );
    }

    return (
      <div className="max-w-3xl space-y-6">
        <DockerImageStatusPanel />
        {/* System Resources */}
        {stats && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">System Resources</h3>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => setShowCleanupReview(true)}>
                  <Trash2 className="h-4 w-4 mr-1" />
                  Review cleanup…
                </Button>
                <Button variant="ghost" size="sm" onClick={loadData} disabled={isLoading}>
                  <RefreshCw className={`h-4 w-4 mr-1 ${isLoading ? "animate-spin" : ""}`} />
                  Refresh
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
              <div className="text-center p-3 rounded-md bg-zinc-800/50 border border-zinc-700">
                <div className="text-xs text-muted-foreground uppercase tracking-wide">CPU</div>
                <div className="text-lg font-semibold mt-1">
                  {stats.cpuCoresUsed != null
                    ? `${stats.cpuCoresUsed} cores`
                    : `${stats.cpuUsagePercent}%`}{" "}
                  <span className="text-xs font-normal text-muted-foreground">
                    of {stats.cpus || "?"} Docker CPUs
                  </span>
                </div>
                <Progress value={Math.min(stats.cpuUsagePercent, 100)} className="mt-2 h-1" />
              </div>
              <div className="text-center p-3 rounded-md bg-zinc-800/50 border border-zinc-700">
                <div className="text-xs text-muted-foreground uppercase tracking-wide">MEMORY</div>
                <div className="text-lg font-semibold mt-1">
                  {formatBytes(stats.memoryUsed)} /{" "}
                  {stats.memoryTotalKnown === false ? "unknown" : formatBytes(stats.memoryTotal)}
                </div>
                <Progress
                  value={stats.memoryTotal > 0 ? (stats.memoryUsed / stats.memoryTotal) * 100 : 0}
                  className="mt-2 h-1"
                />
              </div>
              <div className="text-center p-3 rounded-md bg-zinc-800/50 border border-zinc-700">
                <div className="text-xs text-muted-foreground uppercase tracking-wide">
                  DISK (ALL OF DOCKER)
                </div>
                <div className="text-lg font-semibold mt-1">
                  {stats.diskKnown === false
                    ? "unknown"
                    : stats.diskTotal > 0
                      ? `${formatBytes(stats.diskUsed)} / ${formatBytes(stats.diskTotal)}`
                      : formatBytes(stats.diskUsed)}
                </div>
                <Progress
                  value={stats.diskTotal > 0 ? (stats.diskUsed / stats.diskTotal) * 100 : 0}
                  className="mt-2 h-1"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              CPU and memory in use are this installation&apos;s containers; totals are what Docker
              reports (on Docker Desktop, its virtual machine).
              {stats.sampledAt
                ? ` Measured ${new Date(stats.sampledAt).toLocaleTimeString()}${stats.stale ? " (stale)" : ""}.`
                : ""}
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
              <div className="text-center p-3 rounded-md bg-zinc-800/50 border border-zinc-700">
                <div className="text-lg font-semibold">{stats.containersRunning}</div>
                <div className="text-xs text-muted-foreground">Running</div>
              </div>
              <div className="text-center p-3 rounded-md bg-zinc-800/50 border border-zinc-700">
                <div className="text-lg font-semibold">{stats.containersTotal}</div>
                <div className="text-xs text-muted-foreground">Containers</div>
              </div>
              <div className="text-center p-3 rounded-md bg-zinc-800/50 border border-zinc-700">
                <div className="text-lg font-semibold">{stats.imagesTotal}</div>
                <div className="text-xs text-muted-foreground">Images</div>
              </div>
            </div>
          </div>
        )}

        {/* Orkestrator Containers */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Orkestrator Containers</h3>
            {orphanedCount > 0 && (
              <Button variant="destructive" size="sm" onClick={() => setShowCleanupReview(true)}>
                <Trash2 className="h-4 w-4 mr-1" />
                Review cleanup ({orphanedCount})
              </Button>
            )}
          </div>
          {containers.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No Orkestrator containers found.
            </p>
          ) : (
            <div className="space-y-2">
              {containers.map((container) => {
                const isOrphaned = isUnclaimedContainer(container);
                const isLinked = !container.isAssigned && !isOrphaned;
                const isStopping = stoppingContainerId === container.id;
                const isDeleting = deletingContainerId === container.id;
                const isOperating = isStopping || isDeleting;
                const isRunning = container.state === "running";
                const project = container.projectId ? getProjectById(container.projectId) : null;
                return (
                  <div
                    key={container.id}
                    className={`flex items-center justify-between p-3 rounded-md ${isOrphaned ? "bg-red-500/10 border border-red-500/30" : "bg-zinc-800/50 border border-zinc-700"}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`font-medium text-sm truncate ${isOrphaned ? "text-red-700 dark:text-red-400" : ""}`}
                        >
                          {container.name}
                          {project && (
                            <span className="text-muted-foreground font-normal ml-1">
                              ({project.name})
                            </span>
                          )}
                        </span>
                        {isOrphaned && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-red-500/20 text-red-700 dark:text-red-400">
                            Orphaned
                          </span>
                        )}
                        {isLinked && (
                          <span
                            className="text-xs px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-700 dark:text-yellow-400"
                            title="Kept by cleanup: an environment or operation still claims this container."
                          >
                            Protected
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {container.id.substring(0, 12)} · {formatRelativeTime(container.created)}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {isRunning && container.cpuPercent !== null && (
                        <span className="text-xs text-muted-foreground">
                          CPU: {container.cpuPercent}%
                          {container.memoryBytes != null
                            ? ` · ${formatBytes(container.memoryBytes)}`
                            : ""}
                        </span>
                      )}
                      {!isRunning && container.oomKilled ? (
                        <span className="text-xs text-destructive">Out of memory</span>
                      ) : null}
                      <div className="flex items-center gap-1">
                        {isRunning ? (
                          <CheckCircle2 className="h-4 w-4 text-green-500" />
                        ) : (
                          <XCircle className="h-4 w-4 text-muted-foreground" />
                        )}
                        <span className="text-xs capitalize">{container.state}</span>
                      </div>
                      {isOrphaned && (
                        <div className="flex items-center gap-1 ml-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-blue-600 hover:text-blue-700 dark:hover:bg-blue-900/30"
                            onClick={() => openReattachDialog(container)}
                            disabled={isOperating || isReattaching}
                            title="Reattach to project"
                          >
                            <Link2 className="h-4 w-4" />
                          </Button>
                          {isRunning && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-orange-600 hover:text-orange-700 dark:hover:bg-orange-900/30"
                              onClick={() => handleStopContainer(container.id)}
                              disabled={isOperating}
                              title="Stop container"
                            >
                              {isStopping ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Square className="h-4 w-4" />
                              )}
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-red-600 hover:text-red-700 dark:hover:bg-red-900/30"
                            onClick={() => handleDeleteContainer(container.id)}
                            disabled={isOperating}
                            title="Delete container"
                          >
                            {isDeleting ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Trash2 className="h-4 w-4" />
                            )}
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {orphanedCount > 0 && (
            <p className="text-xs text-muted-foreground">
              Orphaned containers are not assigned to any environment or kept as a recovery copy.
              Review cleanup lists exactly what would be deleted before anything is removed.
            </p>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      <FullscreenSettingsLayout
        open={open}
        onOpenChange={onOpenChange}
        title="Docker"
        menuItems={dockerMenuItems}
      >
        {() => renderDockerSection()}
      </FullscreenSettingsLayout>

      <DockerCleanupReview
        open={showCleanupReview}
        onOpenChange={setShowCleanupReview}
        onFinished={() => void loadData()}
      />

      {/* Reattach Container Dialog */}
      <AlertDialog
        open={showReattachDialog}
        onOpenChange={(open) => {
          setShowReattachDialog(open);
          if (!open) {
            setReattachingContainer(null);
            setSelectedProjectId("");
            setReattachName("");
          }
        }}
      >
        <AlertDialogContent className={Z_FULLSCREEN_DIALOG} overlayClassName={Z_FULLSCREEN_DIALOG}>
          <AlertDialogHeader>
            <AlertDialogTitle>Reattach Container to Project</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-4">
                <p>Reattach this container to a project by creating a new environment entry.</p>
                {reattachingContainer && (
                  <div className="text-sm p-2 rounded bg-muted">
                    <span className="font-medium">{reattachingContainer.name}</span>
                    <span className="text-muted-foreground ml-2">
                      ({reattachingContainer.id.substring(0, 12)})
                    </span>
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="project-select">Select Project</Label>
                  <Select value={selectedProjectId} onValueChange={setSelectedProjectId}>
                    <SelectTrigger id="project-select">
                      <SelectValue placeholder="Choose a project..." />
                    </SelectTrigger>
                    <SelectContent className={Z_FULLSCREEN_DIALOG_POPOVER}>
                      {projects.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="env-name">Environment Name</Label>
                  <Input
                    id="env-name"
                    value={reattachName}
                    onChange={(e) => setReattachName(e.target.value)}
                    placeholder="Enter environment name..."
                  />
                  <p className="text-xs text-muted-foreground">
                    Leave as-is to use the container name, or enter a custom name.
                  </p>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isReattaching}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleReattach}
              disabled={isReattaching || !selectedProjectId}
            >
              {isReattaching ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Reattaching...
                </>
              ) : (
                <>
                  <Link2 className="mr-2 h-4 w-4" />
                  Reattach
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
