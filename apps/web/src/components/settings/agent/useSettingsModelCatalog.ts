import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  normalizeOpenCodeModelProviders,
  openCodeModelDisplayLabel,
} from "@orkestrator/protocol/native-agent";
import { useFederation } from "@/components/federation/FederationProvider";
import { useProjectModelCatalog } from "@/hooks/useBuildLaunchOptions";
import * as backend from "@/lib/backend";
import { buildReviewModelCatalog, includeMissingOpenCodeModels } from "@/lib/review-launch-options";
import { useProjectStore, useUIStore } from "@/stores";
import { isWindowMachine, useAccountMachine } from "../account-machine";
import { useSettingsConfig } from "../settings-config";
import {
  refreshSettingsModelCatalog,
  resolveSettingsCatalogProjectId,
} from "./refresh-model-catalog";

/** Other machines' catalogues and project IDs never enter workspace stores. */
export function useSettingsModelCatalog() {
  const { machine } = useAccountMachine();
  const own = isWindowMachine(machine);
  const { portalState } = useFederation();
  const { config } = useSettingsConfig();
  const ownProjects = useProjectStore((state) => state.projects);
  const ownSelected = useUIStore((state) => state.selectedProjectId);
  const selectedProjectId = own ? ownSelected : null;
  const projects = useMemo(() => {
    if (own) return ownProjects;
    const summary =
      machine === null || machine === portalState.selfId
        ? portalState.self
        : portalState.nodes.find((node) => node.nodeId === machine);
    return (summary?.projects ?? []).map((project) => ({
      id: project.ref.projectId,
      name: project.name,
    }));
  }, [machine, own, ownProjects, portalState.nodes, portalState.self, portalState.selfId]);
  const catalogProjectId = resolveSettingsCatalogProjectId(
    selectedProjectId,
    projects.map((project) => project.id),
  );
  const catalogProjectLabel =
    projects.find((project) => project.id === catalogProjectId)?.name ?? catalogProjectId;
  const windowCatalog = useProjectModelCatalog(own ? (catalogProjectId ?? "") : "", own);
  const [snapshot, setSnapshot] = useState<{
    machine: typeof machine;
    projectId: string | null;
    cache: backend.AgentModelCatalogCache;
    openCode: backend.OpenCodeModelCatalogSnapshot | null;
  } | null>(null);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const request = ++generation.current;
    const [cache, openCode] = await Promise.all([
      backend.getAgentModelCatalogCache(machine),
      catalogProjectId ? backend.getCachedOpenCodeModelCatalog(catalogProjectId, machine) : null,
    ]);
    if (request === generation.current)
      setSnapshot({ machine, projectId: catalogProjectId, cache, openCode });
  }, [machine, catalogProjectId]);
  useEffect(() => {
    if (!own)
      void load().catch((error: unknown) =>
        console.warn("[settings] Failed to read model catalogues:", error),
      );
    return () => {
      generation.current += 1;
    };
  }, [load, own]);
  const remoteCatalog = useMemo(() => {
    const current =
      snapshot && snapshot.machine === machine && snapshot.projectId === catalogProjectId
        ? snapshot
        : null;
    const cache = current?.cache;
    const catalog = buildReviewModelCatalog({
      claudeModels: cache?.claude?.models ?? [],
      codexModels: cache?.codex?.models ?? [],
      cursorModels: cache?.cursor?.models ?? [],
      grokModels: cache?.grok?.models ?? [],
      piModels: cache?.pi?.models ?? [],
    });
    const models = current?.openCode?.projectId === catalogProjectId ? current.openCode.models : [];
    const mapped = models.length
      ? models.map((model) => ({
          id: model.id,
          name: openCodeModelDisplayLabel(model.id, model.name),
          providerLabel: model.provider,
          description: model.provider,
          reasoningEfforts: [...(model.variants ?? [])],
          ...(model.connected === false ? { connected: false } : {}),
        }))
      : catalog.opencode;
    return {
      ...catalog,
      opencode: includeMissingOpenCodeModels(
        mapped,
        (config.global.favoriteModels ?? [])
          .filter((favorite) => favorite.platform === "opencode")
          .map((favorite) => favorite.modelId),
        normalizeOpenCodeModelProviders(config.global.openCodeModelProviders),
      ),
    };
  }, [
    snapshot,
    machine,
    catalogProjectId,
    config.global.favoriteModels,
    config.global.openCodeModelProviders,
  ]);
  const refresh = useCallback(
    (platform: AgentPlatform) =>
      own
        ? refreshSettingsModelCatalog(platform, catalogProjectId)
        : refreshSettingsModelCatalog(platform, catalogProjectId, {
            refreshGlobal: (agent) =>
              backend.refreshHostAgentModelCatalog(agent, undefined, machine),
            refreshOpenCode: (projectId) =>
              backend.refreshHostAgentModelCatalog("opencode", projectId, machine),
            hydrate: load,
            dispatch: () => true,
          }),
    [catalogProjectId, machine, own, load],
  );
  return {
    catalog: own ? windowCatalog : remoteCatalog,
    catalogProjectId,
    catalogProjectLabel,
    selectedProjectId,
    refresh,
  };
}
