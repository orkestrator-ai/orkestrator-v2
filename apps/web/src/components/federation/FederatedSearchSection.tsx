import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import { searchMachines } from "@/lib/federation/aggregate";
import { useFederation } from "./FederationProvider";
import { MachineDot } from "./MachineDot";
import { useRemoteMachineViews } from "./useMachineViews";

const MAX_RESULTS = 20;

/**
 * Search results from other machines' summaries. Results are labelled with
 * their machine and open it on that machine; when a machine is
 * unavailable, still loading or truncated, the section says results may be
 * incomplete instead of implying nothing matched there.
 */
export function FederatedSearchSection({
  query,
  onOpened,
}: {
  query: string;
  onOpened: () => void;
}) {
  const { enabled } = useFederation();
  const machines = useRemoteMachineViews();
  const openPanel = openMachineWorkspace;
  if (!enabled || machines.length === 0 || !query.trim()) return null;
  const { rows, incomplete } = searchMachines(machines, query);
  return (
    <section className="mt-3" data-testid="federated-search-results">
      <h3 className="px-3 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        Other machines
      </h3>
      {rows.length === 0 ? (
        <p className="px-3 py-1 text-xs text-muted-foreground">No matches on other machines.</p>
      ) : (
        <div className="space-y-0.5">
          {rows.slice(0, MAX_RESULTS).map(({ machine, project, environment }) => (
            <button
              key={environment.key}
              type="button"
              className="flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm hover:bg-elevated"
              aria-label={`${environment.name} on ${machine.name}${project ? `, project ${project.name}` : ""}`}
              onClick={() => {
                openPanel({
                  connectionId: machine.connectionId,
                  projectId: environment.projectId,
                  environmentId: environment.ref.environmentId,
                  title: environment.name,
                });
                onOpened();
              }}
            >
              <MachineDot colorToken={machine.colorToken} machineName={machine.name} />
              <span className="min-w-0 flex-1 truncate">{environment.name}</span>
              <span className="shrink-0 truncate text-xs text-muted-foreground">
                {machine.name}
                {project ? ` · ${project.name}` : ""}
              </span>
            </button>
          ))}
        </div>
      )}
      {incomplete ? (
        <p
          className="px-3 pt-1.5 text-[11px] text-amber-400/90"
          data-testid="federated-search-incomplete"
        >
          Results may be incomplete: some machines are unavailable or not fully loaded.
        </p>
      ) : null}
    </section>
  );
}
