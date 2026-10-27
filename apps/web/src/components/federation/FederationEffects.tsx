import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import {
  FEDERATED_LINK_PARAM,
  decodeResourceLink,
  environmentKey,
  environmentRef,
  projectKey,
  projectRef,
  type BackendId,
} from "@orkestrator/protocol/federation";
import { requestGlobalSettings } from "@/lib/settings-navigation";
import type { MachineView } from "@/lib/federation/aggregate";
import { useUIStore } from "@/stores";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { useFederation } from "./FederationProvider";
import { useMachineViews } from "./useMachineViews";

const MAX_NOTIFIED_KEYS = 500;

/**
 * Cross-machine side effects of the main window: opening a machine-qualified
 * link, and attention toasts for other machines. Both are keyed by machine
 * plus resource; neither ever resolves a resource against this window's own
 * machine just because the local IDs happen to match.
 */
export function FederationEffects() {
  const { kind } = useFederation();
  if (kind === "none") return null;
  return <FederationEffectsActive />;
}

function FederationEffectsActive() {
  const machines = useMachineViews();
  const { bound } = useFederation();
  useResourceLink(machines);
  useAttentionToasts(machines);
  useRecentSelections(bound?.backendId ?? null);
  return null;
}

/**
 * Records this window's own project and environment selections as recently
 * used, by node-qualified key, next to other machines' (recorded when they
 * are opened), so the project search ranks every machine's recents together.
 * A local selection also ends the search's highlight of another machine's
 * project.
 */
function useRecentSelections(backendId: BackendId | null) {
  useEffect(() => {
    if (!backendId) return;
    return useUIStore.subscribe((state, previous) => {
      if (
        state.projectSelectionRevision === previous.projectSelectionRevision &&
        state.selectedEnvironmentId === previous.selectedEnvironmentId
      ) {
        return;
      }
      const keys: string[] = [];
      if (state.selectedEnvironmentId) {
        keys.push(environmentKey(environmentRef(backendId, state.selectedEnvironmentId)));
      }
      if (state.selectedProjectId) {
        keys.push(projectKey(projectRef(backendId, state.selectedProjectId)));
      }
      const views = useMachineViewStore.getState();
      views.recordRecent(keys);
      views.revealProject(null);
    });
  }, [backendId]);
}

/** `?resource=` names a machine and a resource; never a route, port or token. */
function useResourceLink(machines: readonly MachineView[]) {
  const handled = useRef(false);
  const openPanel = openMachineWorkspace;
  useEffect(() => {
    if (handled.current) return;
    const value = new URLSearchParams(window.location.search).get(FEDERATED_LINK_PARAM);
    if (!value) {
      handled.current = true;
      return;
    }
    const ref = decodeResourceLink(value);
    if (!ref) {
      handled.current = true;
      return;
    }
    const machine = machines.find((candidate) => candidate.backendId === ref.backendId);
    if (!machine) {
      // Wait for the connection list; then offer to add the machine instead
      // of reinterpreting the link against this one.
      if (machines.length === 0) return;
      handled.current = true;
      toast.info("This link is for a machine that isn't saved here", {
        action: { label: "Add a machine", onClick: () => requestGlobalSettings("machines") },
      });
      return;
    }
    handled.current = true;
    if (machine.bound) {
      if ("environmentId" in ref) {
        const environment = Array.from(machine.environmentsByProject.values())
          .flat()
          .find((candidate) => candidate.ref.environmentId === ref.environmentId);
        if (environment) {
          useUIStore
            .getState()
            .selectProjectAndEnvironment(environment.projectId, ref.environmentId);
        }
      } else {
        useUIStore.getState().selectProject(ref.projectId);
      }
      return;
    }
    if ("environmentId" in ref) {
      const environment = Array.from(machine.environmentsByProject.values())
        .flat()
        .find((candidate) => candidate.ref.environmentId === ref.environmentId);
      if (environment) {
        openPanel({
          connectionId: machine.connectionId,
          projectId: environment.projectId,
          environmentId: ref.environmentId,
          title: environment.name,
        });
      } else {
        handled.current = false; // Summaries may still be loading.
      }
    } else {
      openPanel({ connectionId: machine.connectionId, projectId: ref.projectId, title: "Project" });
    }
  }, [machines, openPanel]);
}

/**
 * Another machine's environment started waiting for input or finished new
 * work. The toast names the machine and opens the environment there; it is
 * deduplicated by machine-qualified key, so identical local IDs on two
 * machines are two notifications.
 */
function useAttentionToasts(machines: readonly MachineView[]) {
  const openPanel = openMachineWorkspace;
  const previous = useRef(new Map<string, { waiting: boolean; unread: boolean }>());
  const primed = useRef(new Set<string>());
  useEffect(() => {
    const seen = previous.current;
    for (const machine of machines) {
      if (machine.bound || machine.loadedAt === null) continue;
      const firstLook = !primed.current.has(machine.connectionId);
      primed.current.add(machine.connectionId);
      for (const environments of machine.environmentsByProject.values()) {
        for (const environment of environments) {
          const key = environmentKey(environment.ref);
          const state = {
            waiting: environment.activity === "waiting",
            unread: environment.hasUnreadWork,
          };
          const before = seen.get(key);
          seen.set(key, state);
          if (firstLook || !before) continue;
          const becameWaiting = state.waiting && !before.waiting;
          const becameUnread = state.unread && !before.unread;
          if (!becameWaiting && !becameUnread) continue;
          toast(becameWaiting ? "Waiting for input" : "New completed work", {
            id: `federated-attention:${key}`,
            description: `${environment.name} on ${machine.name}`,
            action: {
              label: "Open",
              onClick: () =>
                openPanel({
                  connectionId: machine.connectionId,
                  projectId: environment.projectId,
                  environmentId: environment.ref.environmentId,
                  title: environment.name,
                }),
            },
          });
        }
      }
    }
    if (seen.size > MAX_NOTIFIED_KEYS * 4) {
      for (const key of Array.from(seen.keys()).slice(0, seen.size - MAX_NOTIFIED_KEYS * 4)) {
        seen.delete(key);
      }
    }
  }, [machines, openPanel]);
}
