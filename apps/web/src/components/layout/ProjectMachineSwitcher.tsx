import { useMemo } from "react";
import { MachineColorDot } from "@/components/federation/MachineDot";
import { useLinearMachineTargets } from "@/components/linear/linear-machines";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";
import { usePortalLayout } from "@/lib/portal/portal-layout";
import { cn } from "@/lib/utils";
import type { ProjectBoardTab } from "@/stores";
import { projectMachineOptions, type ProjectMachineOption } from "./project-machine-options";

interface ProjectMachineSwitcherProps {
  projectId: string;
  projectName: string;
  /** The project page's tab, which the other machine's copy opens on. */
  tab: ProjectBoardTab;
  /** The grid (mobile tools) toolbar stretches it to its cell. */
  isGrid?: boolean;
}

/**
 * The project page's machine dropdown, at the right end of its tab row: every
 * machine with a copy of this project's repository, the one shown selected.
 * Picking another opens that machine's copy of the project on the same tab
 * (its Home, its Coordinator, its Kanban and so on). Nothing is drawn while
 * this machine is the only one with the repository.
 */
export function ProjectMachineSwitcher(props: ProjectMachineSwitcherProps) {
  const targets = useLinearMachineTargets(props.projectId);
  // Mount the select (and its sidebar-order subscription) only when there is a choice.
  if (targets.length < 2) return null;
  return <ProjectMachineSelect {...props} targets={targets} />;
}

function ProjectMachineSelect({
  projectName,
  tab,
  isGrid = false,
  targets,
}: ProjectMachineSwitcherProps & { targets: ReturnType<typeof useLinearMachineTargets> }) {
  const { windowScope } = useScopesWithCommandFallback();
  const commandNodeId = windowScope.commandScope().nodeId;
  const layout = usePortalLayout();
  const options = useMemo(
    () => projectMachineOptions(targets, layout, commandNodeId),
    [commandNodeId, layout, targets],
  );
  const current = options.find((option) => option.current);
  const switchTo = (key: string) => {
    const option = options.find((entry) => entry.key === key);
    if (!option || option.current || !option.available) return;
    openMachineWorkspace({
      connectionId: option.connectionId,
      projectId: option.projectId,
      boardTab: tab,
      title: projectName,
    });
  };
  return (
    <div
      data-testid="project-machine-switcher"
      className={cn(isGrid ? "col-span-2" : "ml-auto shrink-0 pl-2")}
    >
      <Select value={current?.key} onValueChange={switchTo}>
        <SelectTrigger
          size="sm"
          aria-label="Machine"
          title="Open this project on another machine"
          className={cn(
            "gap-1.5 rounded-lg border-border/60 bg-transparent px-2 text-xs shadow-none hover:bg-elevated",
            isGrid ? "w-full" : "!h-6 max-w-48",
          )}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align="end">
          {options.map((option) => (
            <MachineOption key={option.key} option={option} />
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function MachineOption({ option }: { option: ProjectMachineOption }) {
  return (
    <SelectItem
      value={option.key}
      disabled={!option.available}
      data-project-machine-option={option.key}
    >
      <MachineColorDot colorToken={option.colorToken} />
      <span className="truncate">{option.name}</span>
      {!option.available ? <span className="text-xs text-zinc-500">Not connected</span> : null}
    </SelectItem>
  );
}
