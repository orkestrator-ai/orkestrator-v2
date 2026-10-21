import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, FolderGit2, Plus, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  activityRows,
  groupByProject,
  groupByRepository,
  isMachineWritable,
  type MachineView,
  type ProjectGroup,
} from "@/lib/federation/aggregate";
import { cn } from "@/lib/utils";
import { FederatedEnvironmentRow } from "./FederatedEnvironmentRow";
import { MachineDot, machineStatusText } from "./MachineDot";
import { RemoteMachineTree } from "./RemoteMachineTree";
import { UnknownOutcomesNotice } from "./UnknownOutcomesNotice";
import { useCreateFederatedEnvironment } from "./useFederatedEnvironmentActions";

/** A machine heading: colour, name and its connection state, never activity. */
export function MachineSectionHeader({
  machine,
  collapsed,
  onToggle,
}: {
  machine: MachineView;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const status = machine.bound
    ? "This window"
    : machineStatusText({
        transport: machine.transport,
        freshness: machine.freshness,
        loadedAt: machine.loadedAt,
      });
  const live = machine.bound || machine.transport === "connected";
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <div
      className="sticky top-0 z-[5] flex h-8 items-center gap-2 border-b border-border/50 bg-sidebar/95 px-3 backdrop-blur-sm"
      data-testid="machine-section-header"
      data-machine={machine.connectionId}
    >
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          className="text-muted-foreground hover:text-foreground"
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${machine.name}`}
          aria-expanded={!collapsed}
        >
          <Chevron className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : null}
      <MachineDot colorToken={machine.colorToken} machineName={machine.name} status={status} />
      <span className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {machine.name}
      </span>
      <span
        className={cn(
          "flex shrink-0 items-center gap-1 text-[11px]",
          live ? "text-muted-foreground" : "text-amber-400",
        )}
        title={machine.transportDetail}
      >
        {!live ? <WifiOff className="h-3 w-3" aria-hidden="true" /> : null}
        {status}
      </span>
    </div>
  );
}

function ProjectInstance({
  group,
  showMachineLabel,
  renderBoundEnvironment,
}: {
  renderBoundEnvironment?: (environmentId: string) => ReactNode;
  group: ProjectGroup;
  showMachineLabel: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const { machine, project, environments } = group;
  const { creating, create } = useCreateFederatedEnvironment(machine, project);
  const writable = isMachineWritable(machine) && !machine.bound;

  return (
    <div className="py-0.5" data-testid="federated-project" data-project={project.key}>
      <div className="group/project flex h-7 items-center gap-1.5 px-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
        >
          {collapsed ? (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          )}
          <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate font-medium">{project.name}</span>
          {showMachineLabel ? (
            <span className="ml-1 flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
              <MachineDot colorToken={machine.colorToken} machineName={machine.name} />
              <span className="max-w-[7rem] truncate">{machine.name}</span>
            </span>
          ) : null}
        </button>
        {!machine.bound ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 opacity-0 group-hover/project:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
            disabled={!writable || creating}
            onClick={() => void create()}
            aria-label={`New environment in ${project.name} on ${machine.name}`}
            title={
              writable ? `New environment on ${machine.name}` : `${machine.name} is unavailable`
            }
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {!collapsed
        ? environments.map((environment) =>
            machine.bound && renderBoundEnvironment ? (
              <div key={environment.key}>
                {renderBoundEnvironment(environment.ref.environmentId)}
              </div>
            ) : (
              <FederatedEnvironmentRow
                key={environment.key}
                machine={machine}
                project={null}
                environment={environment}
                showMachineLabel={false}
                indented
              />
            ),
          )
        : null}
      {!collapsed && environments.length === 0 ? (
        <p className="px-9 py-1 text-xs text-muted-foreground">No environments</p>
      ) : null}
    </div>
  );
}

function MachineNotices({ machine }: { machine: MachineView }) {
  const notices: ReactNode[] = [];
  if (!machine.bound && machine.transport !== "connected" && machine.loadedAt !== null) {
    notices.push(
      <p key="stale" className="px-3 py-1 text-[11px] text-amber-400/90">
        Showing last known state. Live actions are disabled until {machine.name} reconnects.
      </p>,
    );
  }
  if (machine.truncated) {
    notices.push(
      <p key="truncated" className="px-3 py-1 text-[11px] text-muted-foreground">
        Not every project or environment on {machine.name} is shown here.
      </p>,
    );
  }
  if (!machine.bound && machine.transportDetail && machine.transport !== "connected") {
    notices.push(
      <p key="detail" className="px-3 py-1 text-[11px] text-muted-foreground">
        {machine.transportDetail}
      </p>,
    );
  }
  return notices.length > 0 ? <>{notices}</> : null;
}

/** Another machine's projects and environments, laid out as its own sidebar lays them out. */
export function RemoteMachineSection({ machine }: { machine: MachineView }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section aria-label={`${machine.name} projects`} data-testid="remote-machine-section">
      <MachineSectionHeader
        machine={machine}
        collapsed={collapsed}
        onToggle={() => setCollapsed((value) => !value)}
      />
      {!collapsed ? (
        <div className="py-1">
          <MachineNotices machine={machine} />
          <UnknownOutcomesNotice connectionId={machine.connectionId} />
          {machine.loadedAt === null && machine.projects.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              {machine.transport === "connected" || machine.transport === "connecting"
                ? "Loading…"
                : "Not available yet."}
            </p>
          ) : machine.projects.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">No projects</p>
          ) : (
            <RemoteMachineTree machine={machine} />
          )}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Cross-machine projections: project instances (with machine badges),
 * optional repository groups, or one activity list. Grouping is visual;
 * every row keeps its own owner.
 */
export function FederatedAggregateList({
  machines,
  mode,
  renderBoundEnvironment,
}: {
  renderBoundEnvironment?: (environmentId: string) => ReactNode;
  machines: readonly MachineView[];
  mode: "project" | "repository" | "activity";
}) {
  if (mode === "activity") {
    const rows = activityRows(machines);
    return (
      <div className="py-1" data-testid="federated-activity-list">
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">No environments yet</p>
        ) : (
          rows.map((row) =>
            row.machine.bound && renderBoundEnvironment ? (
              <div key={row.environment.key}>
                {renderBoundEnvironment(row.environment.ref.environmentId)}
              </div>
            ) : (
              <FederatedEnvironmentRow
                key={row.environment.key}
                machine={row.machine}
                project={row.project}
                environment={row.environment}
                showMachineLabel
              />
            ),
          )
        )}
      </div>
    );
  }
  if (mode === "repository") {
    return (
      <div className="py-1" data-testid="federated-repository-list">
        {groupByRepository(machines).map((group) => (
          <div key={group.repository ?? group.projects[0]!.project.key}>
            {group.repository ? (
              <div className="px-3 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {group.label}
                <span className="ml-1 font-normal normal-case">
                  · {group.projects.length} {group.projects.length === 1 ? "copy" : "copies"}
                </span>
              </div>
            ) : null}
            {group.projects.map((project) => (
              <ProjectInstance
                key={project.project.key}
                group={project}
                showMachineLabel
                renderBoundEnvironment={renderBoundEnvironment}
              />
            ))}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="py-1" data-testid="federated-project-list">
      {groupByProject(machines).map((group) => (
        <ProjectInstance
          key={group.project.key}
          group={group}
          showMachineLabel
          renderBoundEnvironment={renderBoundEnvironment}
        />
      ))}
    </div>
  );
}
