import { Box, FolderGit2, GitBranch } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { useEnvironmentStore } from "@/stores/environmentStore";

export interface EnvironmentContainment {
  /** "worktree", "container" or "project checkout". */
  isolation: string;
  /** "host network", "restricted network" or "full network". */
  network: string;
  branch: string;
  /** Plain-language account of the boundary, for the tooltip. */
  explanation: string;
  container: boolean;
}

/**
 * What isolates an environment's agents, in the words the tooltip and the tag
 * share. A local worktree has no container firewall, so its network is the
 * host's whatever the environment's stored network mode says.
 */
export function describeEnvironmentContainment(environment: {
  environmentType: "containerized" | "local";
  networkAccessMode: "full" | "restricted";
  branch: string;
  projectHome?: boolean;
}): EnvironmentContainment {
  const container = environment.environmentType === "containerized";
  if (environment.projectHome) {
    return {
      isolation: "project checkout",
      network: "host network",
      branch: environment.branch,
      explanation:
        "The project's own checkout on this machine. Changes here land directly in the repository.",
      container: false,
    };
  }
  if (!container) {
    return {
      isolation: "worktree",
      network: "host network",
      branch: environment.branch,
      explanation:
        "A Git worktree on this machine with its own branch. Agents work outside your main checkout, but a local worktree has no container firewall.",
      container: false,
    };
  }
  const restricted = environment.networkAccessMode === "restricted";
  return {
    isolation: "container",
    network: restricted ? "restricted network" : "full network",
    branch: environment.branch,
    explanation: restricted
      ? "A Docker container with its own checkout and branch. Outbound traffic reaches only the allowlisted hosts."
      : "A Docker container with its own checkout and branch. Its network is unrestricted.",
    container: true,
  };
}

/**
 * The environment's containment, stated where the work happens: a mono line
 * reading "worktree · host network · feature/x" or "container · restricted
 * network · feature/x". Reads the environment store only; renders nothing until
 * the environment is known.
 */
export function EnvironmentContainmentTag({
  environmentId,
  className,
}: {
  environmentId: string;
  className?: string;
}) {
  const facts = useEnvironmentStore(
    useShallow((state) => {
      const environment = state.environments.find((candidate) => candidate.id === environmentId);
      return environment
        ? {
            environmentType: environment.environmentType,
            networkAccessMode: environment.networkAccessMode,
            branch: environment.branch,
            projectHome: environment.projectHome === true,
          }
        : null;
    }),
  );
  if (!facts) return null;
  const containment = describeEnvironmentContainment(facts);
  const IsolationIcon = containment.container ? Box : FolderGit2;
  const summary = [containment.isolation, containment.network, containment.branch]
    .filter(Boolean)
    .join(" · ");
  return (
    <span
      data-testid="environment-containment"
      title={`${summary}\n${containment.explanation}`}
      className={cn(
        "flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground",
        className,
      )}
    >
      <IsolationIcon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="shrink-0">{containment.isolation}</span>
      {/* Narrow panes keep the isolation; network and branch return from @md up. */}
      <span aria-hidden="true" className="hidden @md:inline">
        ·
      </span>
      <span className="hidden shrink-0 @md:inline">{containment.network}</span>
      <span aria-hidden="true" className="hidden @md:inline">
        ·
      </span>
      <GitBranch aria-hidden="true" className="hidden size-3 shrink-0 @md:block" />
      <span className="hidden min-w-0 truncate @md:inline">{containment.branch}</span>
    </span>
  );
}
