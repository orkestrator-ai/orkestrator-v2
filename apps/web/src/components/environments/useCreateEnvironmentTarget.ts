import type { BackendId } from "@orkestrator/protocol/federation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { toast } from "sonner";
import { useNodeDockerAvailability } from "@/hooks/useNodeDockerAvailability";
import { useScopesWithCommandFallback, useSignal } from "@/lib/node-scope/providers";
import { portalStore } from "@/lib/portal/portal-store";
import type { CreateEnvironmentMachine } from "./create-environment-machines";
import {
  prepareCreateEnvironmentTarget,
  type CreateEnvironmentTarget,
} from "./create-environment-target";

interface SelectedTarget extends CreateEnvironmentTarget {
  readonly machine: CreateEnvironmentMachine;
}

/**
 * Which machine an open New Environment form creates on.
 *
 * Picking one changes only the target: the form keeps reading the machine it
 * had until the new one is ready (`prepareCreateEnvironmentTarget`), and stays
 * on it, with the reason in a toast, when the new one cannot be used. `target`
 * is null while the form creates on its origin, the node scope it opened in.
 */
export function useCreateEnvironmentTarget({
  open,
  machines,
}: {
  open: boolean;
  /** The machines offered, the origin's (`current`) included. */
  machines: readonly CreateEnvironmentMachine[];
}) {
  const { windowScope, scope: origin } = useScopesWithCommandFallback();
  // Re-render when a scope closes, so a target that went away is dropped.
  useSignal(windowScope.nodeScopes);
  const registryLoaded = useStore(portalStore.store, (state) => state.loaded);
  const nodes = useStore(portalStore.store, (state) => state.nodes);
  const [selected, setSelected] = useState<SelectedTarget | null>(null);
  const [pending, setPending] = useState<CreateEnvironmentMachine | null>(null);
  const attempt = useRef<AbortController | null>(null);
  const active = useRef<AbortController | null>(null);

  // Each opening starts on its origin. The last target outlives the close, so
  // the closing dialog does not flip back to the origin as it fades.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    setPending(null);
    if (open) setSelected(null);
  }
  useEffect(
    () => () => {
      attempt.current?.abort();
      active.current?.abort();
    },
    [open],
  );

  const target =
    selected &&
    !selected.scope.disposed &&
    (selected.scope.role === "command" ||
      nodes.some(({ nodeId }) => nodeId === selected.scope.nodeId))
      ? selected
      : null;
  const originAvailable =
    !origin.disposed &&
    (origin.role === "command" ||
      !registryLoaded ||
      nodes.some(({ nodeId }) => nodeId === origin.nodeId));
  const originMachine = machines.find((machine) => machine.current);
  const originName = originMachine?.name ?? "this machine";
  const lost = open && selected !== null && target === null ? selected.machine.name : null;
  useEffect(() => {
    if (lost === null) return;
    toast.error(`${lost} is no longer connected`, {
      description: originAvailable
        ? `The environment will be created on ${originName}.`
        : "Choose another machine to create the environment.",
    });
    active.current?.abort();
    // oxlint-disable-next-line react/set-state-in-effect -- the scope closed outside React
    setSelected(null);
  }, [lost, originAvailable, originName]);

  // Used while hidden: its scope must not be suspended or given back.
  const targetScope = target?.scope ?? null;
  useEffect(() => {
    if (!open) return;
    const unpins = [origin, targetScope].map((scope) =>
      scope ? windowScope.lifecycle.pin(scope.nodeId) : null,
    );
    return () => {
      for (const unpin of unpins) unpin?.();
    };
  }, [open, origin, targetScope, windowScope]);

  const polledDocker = useNodeDockerAvailability(
    targetScope ?? origin,
    open && targetScope !== null,
    target,
  );

  const currentMachine = target?.machine ?? (originAvailable ? originMachine : null);
  const selectedKey = (pending ?? currentMachine)?.key ?? null;
  const currentKey = currentMachine?.key ?? null;
  const currentName = target?.machine.name ?? originName;
  const select = useCallback(
    (machine: CreateEnvironmentMachine) => {
      if (machine.current && !originAvailable) return;
      attempt.current?.abort();
      if (machine.current || machine.key === currentKey) {
        if (machine.current) {
          active.current?.abort();
          setSelected(null);
        }
        setPending(null);
        return;
      }
      const preparation = new AbortController();
      attempt.current = preparation;
      setPending(machine);
      prepareCreateEnvironmentTarget({
        windowScope,
        nodeId: machine.machine ? (machine.machine as BackendId) : null,
        projectId: machine.projectId,
        signal: preparation.signal,
      }).then(
        (prepared) => {
          if (preparation.signal.aborted) return;
          attempt.current = null;
          if (
            prepared.scope.role === "leaf" &&
            !portalStore.getState().nodes.some(({ nodeId }) => nodeId === prepared.scope.nodeId)
          ) {
            preparation.abort();
            setPending(null);
            toast.error(`${machine.name} is no longer connected`);
            return;
          }
          active.current?.abort();
          active.current = preparation;
          setSelected({ ...prepared, machine });
          setPending(null);
        },
        (error: unknown) => {
          if (preparation.signal.aborted) return;
          setPending(null);
          attempt.current = null;
          const reason = error instanceof Error ? error.message : String(error);
          toast.error(`Could not switch to ${machine.name}`, {
            description: `${reason} The environment will be created on ${currentName}.`,
          });
        },
      );
    },
    [currentKey, currentName, originAvailable, windowScope],
  );

  return {
    target,
    originAvailable,
    /** The target's Docker daemon; meaningless while `target` is null. */
    dockerAvailable: polledDocker ?? target?.dockerAvailable ?? false,
    selectedKey,
    /** The machine being made ready, while the form still creates on the previous one. */
    switchingTo: pending?.name ?? null,
    select,
  };
}
