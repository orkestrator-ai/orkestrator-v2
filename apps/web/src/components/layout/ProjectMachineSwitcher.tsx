import { useContext, useMemo, useRef, useSyncExternalStore } from "react";
import { useStore } from "zustand";
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
import { scopeRowsSource } from "@/lib/federation/scope-overlay";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";
import { usePortalLayout } from "@/lib/portal/portal-layout";
import { portalStore } from "@/lib/portal/portal-store";
import { cn } from "@/lib/utils";
import type { ProjectBoardTab } from "@/stores";
import { CloseMobileToolsContext } from "./mobile-tools-context";
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
  const { windowScope } = useScopesWithCommandFallback();
  const source = scopeRowsSource(windowScope, "projects");
  const projects = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const targets = useLinearMachineTargets(props.projectId, projects);
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
  const selfId = useStore(portalStore.store, (state) => state.selfId);
  const commandNodeId = selfId ?? windowScope.commandScope().nodeId;
  const nodes = useStore(portalStore.store, (state) => state.nodes);
  const layout = usePortalLayout();
  const closeMobileTools = useContext(CloseMobileToolsContext);
  const choseMachine = useRef(false);
  const options = useMemo(
    () =>
      projectMachineOptions(
        targets,
        layout,
        commandNodeId,
        nodes.map((node) => node.nodeId),
      ),
    [commandNodeId, layout, nodes, targets],
  );
  const current = options.find((option) => option.current);
  const switchTo = (key: string) => {
    const option = options.find((entry) => entry.key === key);
    if (!option || option.current || !option.available) return;
    choseMachine.current = true;
    openMachineWorkspace({
      connectionId: option.connectionId,
      projectId: option.projectId,
      boardTab: tab,
      title: projectName,
    });
  };
  return (
    <div data-testid="project-machine-switcher" className={isGrid ? "col-span-2" : "shrink-0 pl-2"}>
      <Select value={current?.key} onValueChange={switchTo}>
        <SelectTrigger
          size="sm"
          aria-label="Machine"
          data-keep-mobile-tools-open
          title="Open this project on another machine"
          className={cn(
            "gap-1.5 rounded-lg border-border/60 bg-transparent px-2 text-xs shadow-none hover:bg-elevated",
            isGrid ? "w-full" : "!h-6 max-w-48",
          )}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent
          position="popper"
          align="end"
          onCloseAutoFocus={(event) => {
            if (choseMachine.current && closeMobileTools) {
              // Wait for the select's focus trap to release before Tools restores focus.
              event.preventDefault();
              closeMobileTools();
            }
            choseMachine.current = false;
          }}
        >
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
