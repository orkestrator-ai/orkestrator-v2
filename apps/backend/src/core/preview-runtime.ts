import {
  PREVIEW_LIMITS,
  PREVIEW_PROTOCOL_VERSION,
  type PreviewCapabilities,
  type PreviewLimits,
} from "@orkestrator/protocol/preview-services";

import { runCommand } from "./commands-dependencies.js";
import { dockerOwnerNamespace } from "./docker-ownership.js";
import type { Environment } from "./models.js";
import { PreviewReadinessProber } from "./preview-readiness.js";
import { PreviewServiceRegistry, type PreviewRegistryStorage } from "./preview-service-registry.js";
import { PreviewTargetResolver, type DockerRunner } from "./preview-target-resolver.js";
import { DEFAULT_PREVIEW_SETTINGS, type PreviewSettings } from "./storage-preview-services.js";

export interface PreviewRuntimeStorage extends PreviewRegistryStorage {
  getDataDir(): string;
  loadPreviewSettings(): Promise<PreviewSettings>;
  updatePreviewSettings(
    update: (current: PreviewSettings) => PreviewSettings,
  ): Promise<PreviewSettings>;
}

export interface PreviewRuntimeOptions {
  storage: PreviewRuntimeStorage;
  emit: (event: string, payload: unknown) => void;
  strictDockerOwner?: boolean;
  runDocker?: DockerRunner;
  env?: Record<string, string | undefined>;
  limits?: PreviewLimits;
  /** Test seams. */
  registry?: Partial<ConstructorParameters<typeof PreviewServiceRegistry>[0]>;
  probeFamily?: ConstructorParameters<typeof PreviewTargetResolver>[0]["probeFamily"];
}

const defaultDockerRunner: DockerRunner = (args, { timeoutMs }) =>
  runCommand("docker", args, { timeoutMs });

function localAgentPorts(environment: Environment): number[] {
  return [
    environment.localOpencodePort,
    environment.localClaudePort,
    environment.localCodexPort,
    environment.localCursorPort,
    environment.localGrokPort,
    environment.localPiPort,
  ].filter((port): port is number => typeof port === "number" && port > 0);
}

/**
 * Composition root for backend preview services: registry, resolver,
 * readiness, and the operator controls that gate them. Access, publication,
 * and relay components attach here as they are enabled.
 */
export class PreviewRuntime {
  readonly registry: PreviewServiceRegistry;
  readonly resolver: PreviewTargetResolver;
  readonly readiness: PreviewReadinessProber;
  readonly limits: PreviewLimits;
  private settings: PreviewSettings = structuredClone(DEFAULT_PREVIEW_SETTINGS);
  private readonly reserved = new Map<string, ReadonlySet<number>>();
  private readonly env: Record<string, string | undefined>;
  private initialized: Promise<void> | null = null;
  private readonly settingsListeners = new Set<(settings: PreviewSettings) => void>();

  constructor(private readonly options: PreviewRuntimeOptions) {
    this.env = options.env ?? process.env;
    this.limits = options.limits ?? PREVIEW_LIMITS;
    this.resolver = new PreviewTargetResolver({
      runDocker: options.runDocker ?? defaultDockerRunner,
      dockerOwner: dockerOwnerNamespace(options.storage.getDataDir()),
      strictOwner: options.strictDockerOwner ?? false,
      reservedPorts: () => this.reservedPorts(),
      probeFamily: options.probeFamily,
    });
    this.readiness = new PreviewReadinessProber();
    this.registry = new PreviewServiceRegistry({
      storage: options.storage,
      emit: options.emit,
      resolver: this.resolver,
      readiness: this.readiness,
      limits: this.limits,
      ...options.registry,
    });
  }

  init(): Promise<void> {
    this.initialized ??= (async () => {
      this.settings = await this.options.storage.loadPreviewSettings();
      await this.registry.init();
    })();
    return this.initialized;
  }

  dispose(): void {
    this.registry.dispose();
    this.settingsListeners.clear();
  }

  /** Orkestrator-owned listeners (gateway, control MCP, agent tools) register here. */
  reservePorts(owner: string, ports: Iterable<number>): void {
    this.reserved.set(owner, new Set(ports));
  }

  async reservedPorts(): Promise<ReadonlySet<number>> {
    const ports = new Set<number>();
    for (const owned of this.reserved.values()) for (const port of owned) ports.add(port);
    for (const environment of await this.options.storage.loadEnvironments()) {
      for (const port of localAgentPorts(environment)) ports.add(port);
    }
    return ports;
  }

  private envFlag(name: string): boolean | undefined {
    const value = this.env[name];
    if (value === "1" || value === "true") return true;
    if (value === "0" || value === "false") return false;
    return undefined;
  }

  /** Stored settings with environment overrides applied. */
  effectiveSettings(): PreviewSettings {
    return {
      ...this.settings,
      transport: this.envFlag("ORKESTRATOR_PREVIEW_TRANSPORT") ?? this.settings.transport,
      relay: this.envFlag("ORKESTRATOR_PREVIEW_RELAY") ?? this.settings.relay,
      publication: { ...this.settings.publication },
    };
  }

  storedSettings(): PreviewSettings {
    return structuredClone(this.settings);
  }

  async updateSettings(
    update: (current: PreviewSettings) => PreviewSettings,
  ): Promise<PreviewSettings> {
    this.settings = await this.options.storage.updatePreviewSettings(update);
    const effective = this.effectiveSettings();
    for (const listener of Array.from(this.settingsListeners)) listener(effective);
    return this.storedSettings();
  }

  onSettingsChanged(listener: (settings: PreviewSettings) => void): () => void {
    this.settingsListeners.add(listener);
    return () => this.settingsListeners.delete(listener);
  }

  /**
   * Advertise each mode only when its server dependencies are actually ready.
   * Components that attach later (access, publication, relay) contribute
   * through the provider hooks below.
   */
  capabilities(): PreviewCapabilities {
    const settings = this.effectiveSettings();
    const access = this.accessStatus();
    const publication = this.publicationStatus();
    const transportReason = !settings.transport
      ? "Service preview transport is disabled in settings."
      : !access.available
        ? access.reason
        : undefined;
    const tunnelReason =
      transportReason ?? (this.tunnelReady() ? undefined : "The preview tunnel is not listening.");
    const browserReason =
      transportReason ?? (publication.available ? undefined : publication.reason);
    return {
      protocolVersion: PREVIEW_PROTOCOL_VERSION,
      backendInstanceId: this.registry.backendInstanceId,
      backendEpoch: this.registry.backendEpoch,
      registry: { available: true },
      targets: ["container", "worktree", "backend-host"],
      access: settings.transport ? access : { available: false, reason: transportReason },
      surfaces: {
        desktopTunnel: {
          available: tunnelReason === undefined,
          ...(tunnelReason ? { reason: tunnelReason } : {}),
          upstreamSchemes: ["http"],
        },
        browserTopLevel: {
          available: browserReason === undefined,
          ...(browserReason ? { reason: browserReason } : {}),
          upstreamSchemes: browserReason === undefined ? ["http", "https"] : [],
        },
        browserEmbedded: {
          available: false,
          reason:
            "Embedded browser previews have not passed real-browser privacy tests; use the top-level preview.",
          platforms: [],
        },
        legacyPath: { available: true },
      },
      relay: this.relayStatus(),
      limits: { ...this.limits },
    };
  }

  // Provider hooks, replaced as components attach.
  accessStatus: () => { available: boolean; reason?: string } = () => ({
    available: false,
    reason: "Scoped preview access is not available on this backend.",
  });
  tunnelReady: () => boolean = () => false;
  publicationStatus: () => { available: boolean; reason?: string } = () => ({
    available: false,
    reason: "No private preview domain is configured.",
  });
  relayStatus: () => { available: boolean; reason?: string } = () => ({
    available: false,
    reason: "The container relay is disabled.",
  });
}
