import type { NativeAgentReadiness } from "@orkestrator/protocol/native-agent";
import { isSelectableOpenCodeProvider } from "@orkestrator/protocol/native-agent";
import { INTERACTIVE_RUNTIME_METADATA_TTL_MS } from "./agent-provider-runtime.js";
import {
  OPENCODE_SIGN_IN_COMMAND_HINT,
  OPENCODE_SIGN_IN_REQUIRED_MESSAGE,
} from "./opencode-capabilities.js";
import {
  normalizeOpenCodeComposerCatalog,
  openCodeCatalogCacheKey,
} from "./opencode-model-catalog.js";

export type OpenCodeComposerCatalog = ReturnType<typeof normalizeOpenCodeComposerCatalog>;

type CatalogRead = (
  allowedProviders: readonly string[],
  options: { requireConnected: boolean; priorityProviders: readonly string[] },
) => Promise<OpenCodeComposerCatalog>;

/**
 * The provider's composer catalogue: one entry, keyed by the provider filter
 * it was read with, because a listing returns thousands of models.
 */
export class OpenCodeCatalogCache {
  private entry: {
    expiresAt: number;
    providersKey: string;
    catalog: OpenCodeComposerCatalog;
  } | null = null;

  constructor(private readonly readCatalog: CatalogRead) {}

  async read(
    allowedProviders: readonly string[],
    requireConnected: boolean,
    priorityProviders: readonly string[] = [],
  ): Promise<OpenCodeComposerCatalog> {
    const providersKey = openCodeCatalogCacheKey(
      allowedProviders,
      requireConnected,
      priorityProviders,
    );
    if (
      this.entry &&
      this.entry.expiresAt > Date.now() &&
      this.entry.providersKey === providersKey
    ) {
      return this.entry.catalog;
    }
    const catalog = await this.readCatalog(allowedProviders, {
      requireConnected,
      priorityProviders,
    });
    this.entry = {
      expiresAt: Date.now() + INTERACTIVE_RUNTIME_METADATA_TTL_MS,
      providersKey,
      catalog,
    };
    return catalog;
  }

  /** The effective default from the cached read, without reading. */
  get selectedModelId(): string | undefined {
    return this.entry?.catalog.selectedModelId;
  }

  /** Adopt a picker catalogue a preflight read, without extending a config read's lifetime. */
  publish(catalog: OpenCodeComposerCatalog, allowedProviders: readonly string[]): void {
    this.entry = {
      expiresAt: this.entry?.expiresAt ?? Date.now(),
      providersKey: openCodeCatalogCacheKey(allowedProviders, true),
      catalog,
    };
  }

  clear(): void {
    this.entry = null;
  }

  /**
   * Prompt admission: locked only when OpenCode authoritatively reports that
   * no allowed provider is connected. The managed pair's own `opencode`
   * provider is connected with no login, so this needs an allowlist without
   * it. Read under the picker's key, so a snapshot shares the picker's listing
   * rather than adding one; a failed read is unknown and stays unreported.
   * Returned as a field to spread, because both snapshot reads carry it.
   */
  async signInReadiness(
    allowedProviders: () => Promise<readonly string[]>,
  ): Promise<{ readiness?: NativeAgentReadiness }> {
    try {
      const allowed = await allowedProviders();
      const connected = (await this.read(allowed, true)).connectedProviderIds;
      if (!connected || connected.some((id) => isSelectableOpenCodeProvider(id, allowed))) {
        return {};
      }
      return {
        readiness: {
          state: "authentication-required",
          message: OPENCODE_SIGN_IN_REQUIRED_MESSAGE,
          signIn: { kind: "terminal", hint: OPENCODE_SIGN_IN_COMMAND_HINT },
        },
      };
    } catch {
      return {};
    }
  }
}
