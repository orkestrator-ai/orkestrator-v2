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
  X,
  Link2,
} from "lucide-react";
import * as backend from "@/lib/backend";
import { FullscreenSettingsLayout, type SettingsMenuItem } from "@/components/settings/FullscreenSettingsLayout";
import type { DockerSystemStats, ContainerInfo, SystemPruneResult } from "@/lib/backend";
import { useProjectStore, useEnvironmentStore } from "@/stores";
import { Checkbox } from "@/components/ui/checkbox";
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

interface DockerStatsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DockerStatsDialog({ open, onOpenChange }: DockerStatsDialogProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<DockerSystemStats | null>(null);
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [showCleanupConfirm, setShowCleanupConfirm] = useState(false);
  const [isCleaningUp, setIsCleaningUp] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<number | null>(null);
  // Track individual container operations
  const [stoppingContainerId, setStoppingContainerId] = useState<string | null>(null);
  const [deletingContainerId, setDeletingContainerId] = useState<string | null>(null);
  // System prune state
  const [showPruneConfirm, setShowPruneConfirm] = useState(false);
  const [isPruning, setIsPruning] = useState(false);
  const [pruneResult, setPruneResult] = useState<SystemPruneResult | null>(null);
  const [pruneVolumes, setPruneVolumes] = useState(false);

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
  const orphanedCount = containers.filter(c => !c.isAssigned).length;

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setCleanupResult(null);

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
      setCleanupResult(null);
      setPruneResult(null);
      setPruneVolumes(false);
    }
  }, [open, loadData]);

  const handleCleanup = async () => {
    setIsCleaningUp(true);
    try {
      const removed = await backend.cleanupOrphanedContainers();
      setCleanupResult(removed);
      // Refresh the containers list
      const containersData = await backend.getOrkestratorContainers();
      setContainers(containersData);
    } catch (err) {
      console.error("[DockerStatsDialog] Cleanup failed:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsCleaningUp(false);
      setShowCleanupConfirm(false);
    }
  };

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

  const handleSystemPrune = async () => {
    setIsPruning(true);
    setError(null);
    try {
      const result = await backend.dockerSystemPrune(pruneVolumes);
      setPruneResult(result);
      // Refresh stats after prune
      const statsData = await backend.getDockerSystemStats();
      setStats(statsData);
      // Also refresh containers list
      const containersData = await backend.getOrkestratorContainers();
      setContainers(containersData);
    } catch (err) {
      console.error("[DockerStatsDialog] System prune failed:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsPruning(false);
      setShowPruneConfirm(false);
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
        reattachName || undefined
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
          <AlertCircle className="h-4 w-4 shrink-0" /><span>{error}</span>
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
        {/* System Resources */}
        {stats && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">System Resources</h3>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => setShowPruneConfirm(true)} disabled={isPruning}>
                  {isPruning ? (<><Loader2 className="h-4 w-4 mr-1 animate-spin" />Pruning...</>) : (<><Trash2 className="h-4 w-4 mr-1" />Clean Up</>)}
                </Button>
                <Button variant="ghost" size="sm" onClick={loadData} disabled={isLoading}>
                  <RefreshCw className={`h-4 w-4 mr-1 ${isLoading ? "animate-spin" : ""}`} />Refresh
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
              <div className="text-center p-3 rounded-md bg-zinc-800/50 border border-zinc-700">
                <div className="text-xs text-muted-foreground uppercase tracking-wide">CPU</div>
                <div className="text-lg font-semibold mt-1">{stats.cpuUsagePercent}% <span className="text-xs font-normal text-muted-foreground">({stats.cpus} cores)</span></div>
                <Progress value={Math.min(stats.cpuUsagePercent, 100)} className="mt-2 h-1" />
              </div>
              <div className="text-center p-3 rounded-md bg-zinc-800/50 border border-zinc-700">
                <div className="text-xs text-muted-foreground uppercase tracking-wide">MEMORY</div>
                <div className="text-lg font-semibold mt-1">{formatBytes(stats.memoryUsed)} / {formatBytes(stats.memoryTotal)}</div>
                <Progress value={stats.memoryTotal > 0 ? (stats.memoryUsed / stats.memoryTotal) * 100 : 0} className="mt-2 h-1" />
              </div>
              <div className="text-center p-3 rounded-md bg-zinc-800/50 border border-zinc-700">
                <div className="text-xs text-muted-foreground uppercase tracking-wide">DISK</div>
                <div className="text-lg font-semibold mt-1">{stats.diskTotal > 0 ? `${formatBytes(stats.diskUsed)} / ${formatBytes(stats.diskTotal)}` : formatBytes(stats.diskUsed)}</div>
                <Progress value={stats.diskTotal > 0 ? (stats.diskUsed / stats.diskTotal) * 100 : 0} className="mt-2 h-1" />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
              <div className="text-center p-3 rounded-md bg-zinc-800/50 border border-zinc-700"><div className="text-lg font-semibold">{stats.containersRunning}</div><div className="text-xs text-muted-foreground">Running</div></div>
              <div className="text-center p-3 rounded-md bg-zinc-800/50 border border-zinc-700"><div className="text-lg font-semibold">{stats.containersTotal}</div><div className="text-xs text-muted-foreground">Containers</div></div>
              <div className="text-center p-3 rounded-md bg-zinc-800/50 border border-zinc-700"><div className="text-lg font-semibold">{stats.imagesTotal}</div><div className="text-xs text-muted-foreground">Images</div></div>
            </div>
            {pruneResult !== null && (
              <div className="flex items-start gap-2 p-3 rounded-md bg-green-500/10 text-green-700 dark:text-green-400 text-sm">
                <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
                <div className="flex-1">
                  {pruneResult.containersDeleted === 0 && pruneResult.imagesDeleted === 0 && pruneResult.networksDeleted === 0 && pruneResult.volumesDeleted === 0 ? (
                    <div className="font-medium">Nothing to clean up</div>
                  ) : (
                    <><div className="font-medium">Docker cleanup completed</div><div className="text-xs mt-1 space-y-0.5 opacity-80">
                      {pruneResult.containersDeleted > 0 && <div>{pruneResult.containersDeleted} container{pruneResult.containersDeleted > 1 ? "s" : ""} removed</div>}
                      {pruneResult.imagesDeleted > 0 && <div>{pruneResult.imagesDeleted} image{pruneResult.imagesDeleted > 1 ? "s" : ""} removed</div>}
                      {pruneResult.networksDeleted > 0 && <div>{pruneResult.networksDeleted} network{pruneResult.networksDeleted > 1 ? "s" : ""} removed</div>}
                      {pruneResult.volumesDeleted > 0 && <div>{pruneResult.volumesDeleted} volume{pruneResult.volumesDeleted > 1 ? "s" : ""} removed</div>}
                      <div className="font-medium mt-1">{formatBytes(pruneResult.spaceReclaimed)} reclaimed</div>
                    </div></>
                  )}
                </div>
                <button onClick={() => setPruneResult(null)} className="shrink-0 p-0.5 rounded hover:bg-green-500/20 transition-colors" aria-label="Dismiss"><X className="h-4 w-4" /></button>
              </div>
            )}
          </div>
        )}

        {/* Orkestrator Containers */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Orkestrator Containers</h3>
            {orphanedCount > 0 && (
              <Button variant="destructive" size="sm" onClick={() => setShowCleanupConfirm(true)} disabled={isCleaningUp}>
                {isCleaningUp ? (<><Loader2 className="h-4 w-4 mr-1 animate-spin" />Cleaning...</>) : (<><Trash2 className="h-4 w-4 mr-1" />Clean Up ({orphanedCount})</>)}
              </Button>
            )}
          </div>
          {cleanupResult !== null && (
            <div className="flex items-center gap-2 p-3 rounded-md bg-green-500/10 text-green-700 dark:text-green-400 text-sm">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>{cleanupResult === 0 ? "No orphaned containers to remove." : `Successfully removed ${cleanupResult} orphaned container${cleanupResult > 1 ? "s" : ""}.`}</span>
            </div>
          )}
          {containers.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No Orkestrator containers found.</p>
          ) : (
            <div className="space-y-2">
              {containers.map((container) => {
                const isOrphaned = !container.isAssigned;
                const isStopping = stoppingContainerId === container.id;
                const isDeleting = deletingContainerId === container.id;
                const isOperating = isStopping || isDeleting;
                const isRunning = container.state === "running";
                const project = container.projectId ? getProjectById(container.projectId) : null;
                return (
                  <div key={container.id} className={`flex items-center justify-between p-3 rounded-md ${isOrphaned ? "bg-red-500/10 border border-red-500/30" : "bg-zinc-800/50 border border-zinc-700"}`}>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className={`font-medium text-sm truncate ${isOrphaned ? "text-red-700 dark:text-red-400" : ""}`}>
                          {container.name}{project && <span className="text-muted-foreground font-normal ml-1">({project.name})</span>}
                        </span>
                        {isOrphaned && <span className="text-xs px-1.5 py-0.5 rounded bg-red-500/20 text-red-700 dark:text-red-400">Orphaned</span>}
                      </div>
                      <div className="text-xs text-muted-foreground">{container.id.substring(0, 12)} · {formatRelativeTime(container.created)}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      {isRunning && container.cpuPercent !== null && <span className="text-xs text-muted-foreground">CPU: {container.cpuPercent}%</span>}
                      <div className="flex items-center gap-1">
                        {isRunning ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : <XCircle className="h-4 w-4 text-muted-foreground" />}
                        <span className="text-xs capitalize">{container.state}</span>
                      </div>
                      {isOrphaned && (
                        <div className="flex items-center gap-1 ml-2">
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-blue-600 hover:text-blue-700 dark:hover:bg-blue-900/30" onClick={() => openReattachDialog(container)} disabled={isOperating || isReattaching} title="Reattach to project"><Link2 className="h-4 w-4" /></Button>
                          {isRunning && <Button variant="ghost" size="icon" className="h-7 w-7 text-orange-600 hover:text-orange-700 dark:hover:bg-orange-900/30" onClick={() => handleStopContainer(container.id)} disabled={isOperating} title="Stop container">{isStopping ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}</Button>}
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-red-600 hover:text-red-700 dark:hover:bg-red-900/30" onClick={() => handleDeleteContainer(container.id)} disabled={isOperating} title="Delete container">{isDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}</Button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {orphanedCount > 0 && <p className="text-xs text-muted-foreground">Orphaned containers are not assigned to any environment. Cleaning them up will permanently delete them.</p>}
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

      {/* Cleanup Confirmation Dialog */}
      <AlertDialog open={showCleanupConfirm} onOpenChange={setShowCleanupConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clean Up Orphaned Containers?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete {orphanedCount} container{orphanedCount > 1 ? "s" : ""} that {orphanedCount > 1 ? "are" : "is"} not assigned to any environment.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isCleaningUp}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleCleanup}
              disabled={isCleaningUp}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isCleaningUp ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Cleaning...
                </>
              ) : (
                "Delete Containers"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* System Prune Confirmation Dialog */}
      <AlertDialog open={showPruneConfirm} onOpenChange={(open) => {
        setShowPruneConfirm(open);
        if (!open) setPruneVolumes(false);
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clean Up Docker Resources?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  This will remove unused Docker resources to free up disk space:
                </p>
                <ul className="list-disc list-inside text-sm space-y-1">
                  <li>Stopped containers</li>
                  <li>Dangling images (untagged)</li>
                  <li>Unused networks</li>
                </ul>
                <div className="flex items-center space-x-2 pt-2">
                  <Checkbox
                    id="prune-volumes"
                    checked={pruneVolumes}
                    onCheckedChange={(checked) => setPruneVolumes(checked === true)}
                  />
                  <Label
                    htmlFor="prune-volumes"
                    className="text-sm font-normal cursor-pointer"
                  >
                    Also remove unused volumes (may delete data)
                  </Label>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPruning}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleSystemPrune}
              disabled={isPruning}
            >
              {isPruning ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Cleaning...
                </>
              ) : (
                "Clean Up"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reattach Container Dialog */}
      <AlertDialog open={showReattachDialog} onOpenChange={(open) => {
        setShowReattachDialog(open);
        if (!open) {
          setReattachingContainer(null);
          setSelectedProjectId("");
          setReattachName("");
        }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reattach Container to Project</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-4">
                <p>
                  Reattach this container to a project by creating a new environment entry.
                </p>
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
                  <Select
                    value={selectedProjectId}
                    onValueChange={setSelectedProjectId}
                  >
                    <SelectTrigger id="project-select">
                      <SelectValue placeholder="Choose a project..." />
                    </SelectTrigger>
                    <SelectContent>
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
