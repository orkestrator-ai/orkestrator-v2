/**
 * The registry list and manifest-signing policy in the capabilities store
 * (docs/architecture/agent-capabilities-management.md, "Updates and rollback",
 * "Package registries").
 * The state helpers are pure functions over `CapabilityState`; the
 * commands run them inside the store's transaction.
 */
import {
  CAPABILITY_REGISTRY_LIMITS,
  parseCapabilityRegistryInput,
  type CapabilityRegistry,
  type CapabilityRegistryList,
} from "@orkestrator/protocol/capability-registry";
import {
  graphSharingFingerprint,
  graphSharingKeyId,
  graphSharingPublicKeyBytes,
} from "@orkestrator/protocol/graphs/sharing";

import type { CapabilityRegistryPackageList } from "@orkestrator/protocol/capability-resources-api";

import type { CapabilitiesStorage } from "../storage-capabilities.js";
import type { ManifestSigningKeys } from "./manifest-signing.js";
import { newCorrelationId, recordActivity } from "./operations.js";
import {
  fetchRegistryIndex,
  listRegistryPackages,
  type RegistryContext,
  type RegistryFetch,
} from "./registry.js";
import { CapabilityError } from "./security.js";
import type { GitFetchOptions } from "./source-inspection.js";
import type { CapabilityState } from "./types.js";

export function capabilityRegistries(state: CapabilityState): CapabilityRegistry[] {
  return state.settings.registries ?? [];
}

export function registryListView(
  state: CapabilityState,
  keys: ManifestSigningKeys | undefined,
): CapabilityRegistryList {
  const own = keys?.installationKey(false);
  return {
    revision: state.revision,
    registries: structuredClone(capabilityRegistries(state)),
    requireSignedManifests: state.settings.requireSignedManifests === true,
    signingKey: own ? { keyId: own.keyId, fingerprint: graphSharingFingerprint(own.keyId) } : null,
  };
}

/** Adds or replaces a registry (by id). Changing its address or key clears the last fetch result. */
export function saveRegistry(
  state: CapabilityState,
  input: unknown,
  now: string,
): CapabilityRegistry {
  const parsed = parseCapabilityRegistryInput(input);
  if ("error" in parsed) throw new CapabilityError("invalid-request", parsed.error);
  const { registry } = parsed;
  if (registry.signingKey && !graphSharingPublicKeyBytes(registry.signingKey)) {
    throw new CapabilityError("invalid-request", "The signing key is not an Ed25519 public key.");
  }
  const list = capabilityRegistries(state);
  const previous = list.find((entry) => entry.id === registry.id);
  if (!previous && list.length >= CAPABILITY_REGISTRY_LIMITS.maxRegistries) {
    throw new CapabilityError(
      "too-large",
      `At most ${CAPABILITY_REGISTRY_LIMITS.maxRegistries} registries can be configured.`,
    );
  }
  const sameEndpoint =
    previous?.indexUrl === registry.indexUrl && previous?.signingKey === registry.signingKey;
  const saved: CapabilityRegistry = {
    id: registry.id,
    label: registry.label,
    indexUrl: registry.indexUrl,
    ...(registry.signingKey
      ? { signingKey: registry.signingKey, signingKeyId: graphSharingKeyId(registry.signingKey) }
      : {}),
    addedAt: previous?.addedAt ?? now,
    updatedAt: now,
    ...(sameEndpoint && previous?.lastFetchedAt ? { lastFetchedAt: previous.lastFetchedAt } : {}),
    ...(sameEndpoint && previous?.packageCount !== undefined
      ? { packageCount: previous.packageCount }
      : {}),
  };
  state.settings.registries = [...list.filter((entry) => entry.id !== registry.id), saved].sort(
    (a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
  );
  return saved;
}

export function removeRegistry(state: CapabilityState, registryId: string): boolean {
  const list = capabilityRegistries(state);
  const next = list.filter((entry) => entry.id !== registryId);
  state.settings.registries = next;
  return next.length !== list.length;
}

/** Records the outcome of fetching a registry's index (shown in the Registries list). */
export function recordRegistryFetch(
  state: CapabilityState,
  registryId: string,
  outcome: { packageCount: number } | { error: string },
  now: string,
): boolean {
  const registry = capabilityRegistries(state).find((entry) => entry.id === registryId);
  if (!registry) return false;
  registry.lastFetchedAt = now;
  if ("error" in outcome) {
    registry.lastError = outcome.error.slice(0, 300);
  } else {
    registry.packageCount = outcome.packageCount;
    delete registry.lastError;
  }
  return true;
}

export interface RegistryCommandDeps {
  storage: CapabilitiesStorage;
  signing?: ManifestSigningKeys;
  fetch?: RegistryFetch;
  gitRun?: GitFetchOptions["run"];
  dataDir: string;
  now(): string;
  assertAuthority(): void;
  announce(): void;
}

/**
 * The registry commands: list, add/replace/remove a registry, the signed
 * manifest policy, and a registry's package listing. Saving a registry
 * fetches its index once so the list shows whether it is reachable and
 * correctly signed; a failure is recorded, never thrown.
 */
export class CapabilityRegistryCommands {
  constructor(private readonly deps: RegistryCommandDeps) {}

  /** The context every registry fetch uses: the configured list and the forbidden sources. */
  context(state: CapabilityState, indexCache?: RegistryContext["indexCache"]): RegistryContext {
    return {
      registries: capabilityRegistries(state),
      forbiddenSources: state.settings.forbiddenSources,
      workRoot: this.deps.dataDir,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      ...(this.deps.gitRun ? { gitRun: this.deps.gitRun } : {}),
      ...(indexCache ? { indexCache } : {}),
    };
  }

  async list(): Promise<CapabilityRegistryList> {
    return registryListView(await this.deps.storage.loadCapabilityState(), this.deps.signing);
  }

  async set(args: Record<string, unknown>, actor?: string): Promise<CapabilityRegistryList> {
    this.deps.assertAuthority();
    const remove = typeof args.remove === "string" ? args.remove : undefined;
    let savedId: string | undefined;
    this.deps.storage.mutateCapabilityState((state) => {
      let summary: string;
      if (remove !== undefined) {
        if (!removeRegistry(state, remove)) {
          throw new CapabilityError("not-found", "That registry is not configured.");
        }
        summary = `Removed the package registry ${remove}.`;
      } else {
        const saved = saveRegistry(state, args.registry, this.deps.now());
        savedId = saved.id;
        summary = `Saved the package registry ${saved.label} (${saved.id}).`;
      }
      recordActivity(state, {
        ...(actor ? { actor } : {}),
        action: "registry",
        summary,
        packageIds: [],
        setupIds: [],
        correlationId: newCorrelationId(),
      });
      return { result: undefined, changed: true };
    });
    if (savedId) await this.refresh(savedId);
    this.deps.announce();
    return this.list();
  }

  /** Fetches a registry's index and records the outcome; never throws for a fetch failure. */
  async refresh(registryId: string): Promise<void> {
    const state = await this.deps.storage.loadCapabilityState();
    const registry = capabilityRegistries(state).find((entry) => entry.id === registryId);
    if (!registry) return;
    let outcome: { packageCount: number } | { error: string };
    try {
      const index = await fetchRegistryIndex(registry, this.context(state));
      outcome = { packageCount: Object.keys(index.packages).length };
    } catch (error) {
      outcome = {
        error: error instanceof CapabilityError ? error.message : "The index could not be read.",
      };
    }
    this.deps.storage.mutateCapabilityState((current) => ({
      result: undefined,
      changed: recordRegistryFetch(current, registryId, outcome, this.deps.now()),
    }));
  }

  async setManifestPolicy(
    args: Record<string, unknown>,
    actor?: string,
  ): Promise<CapabilityRegistryList> {
    this.deps.assertAuthority();
    if (typeof args.requireSignedManifests !== "boolean") {
      throw new CapabilityError("invalid-request", "requireSignedManifests must be true or false.");
    }
    const required = args.requireSignedManifests;
    this.deps.storage.mutateCapabilityState((state) => {
      if ((state.settings.requireSignedManifests === true) === required) {
        return { result: undefined, changed: false };
      }
      state.settings.requireSignedManifests = required;
      recordActivity(state, {
        ...(actor ? { actor } : {}),
        action: "manifest-policy",
        summary: required
          ? "Imports now require manifests signed by a trusted key."
          : "Imports no longer require signed manifests.",
        packageIds: [],
        setupIds: [],
        correlationId: newCorrelationId(),
      });
      return { result: undefined, changed: true };
    });
    this.deps.announce();
    return this.list();
  }

  async listPackages(args: Record<string, unknown>): Promise<CapabilityRegistryPackageList> {
    if (typeof args.registryId !== "string") {
      throw new CapabilityError("invalid-request", "registryId is required.");
    }
    const query = typeof args.query === "string" ? args.query.slice(0, 200) : "";
    const state = await this.deps.storage.loadCapabilityState();
    return listRegistryPackages(args.registryId, this.context(state), query);
  }
}
