/**
 * Domain client adapter usage on the backend (plan item 1009,
 * `@orkestrator/protocol/contract/client-usage`).
 *
 * Both sides count into the compatibility-path counters, so one place shows
 * which adapters any peer still takes:
 *
 * - {@link backendDomainAdapterUsage} is the `usage` recorder for the
 *   backend's own domain clients (the node link's, plan item 1010):
 *   `domain-adapter.backend.<domain>.v<version>`;
 * - {@link recordRendererDomainAdapterUsage} adds a renderer's uploaded counts
 *   under `domain-adapter.renderer.<domain>.v<version>`, for the pairs the
 *   adapter list counts (an adapter below its domain's current version). A
 *   pair this build does not list (a newer or older renderer's adapter) is
 *   dropped, which keeps the id set bounded by the code.
 */
import {
  adapterKey,
  buildAdapterList,
  countedAdapterKeys,
} from "@orkestrator/protocol/contract/client-adapters";
import {
  domainAdapterPathId,
  MAX_DOMAIN_ADAPTER_USAGE_COUNT,
  type RecordDomainAdapterUsageResult,
} from "@orkestrator/protocol/contract/client-usage";
import { isDomainName } from "@orkestrator/protocol/contract/domain";
import type { DomainAdapterUsageRecorder } from "@orkestrator/protocol/contract/client";
import { compatibilityPathUsage, type CompatibilityPathUsage } from "./compatibility-path-usage.js";

let countedKeys: ReadonlySet<string> | null = null;

/** The pairs this build counts, from `DOMAIN_CLIENTS`. */
function buildCountedKeys(): ReadonlySet<string> {
  countedKeys ??= countedAdapterKeys(buildAdapterList());
  return countedKeys;
}

/** The usage recorder for the backend's own domain clients. */
export const backendDomainAdapterUsage: DomainAdapterUsageRecorder = (domain, version) => {
  compatibilityPathUsage.record(domainAdapterPathId("backend", domain, version));
};

/**
 * Adds a renderer's upload (the decoded `record_domain_adapter_usage`
 * `entries`) to the counters. A pair outside the counted list, including an
 * unknown domain, is dropped and reported in `dropped`; each count is capped.
 */
export function recordRendererDomainAdapterUsage(
  entries: readonly { readonly domain: string; readonly version: number; readonly count: number }[],
  options: {
    readonly counted?: ReadonlySet<string>;
    readonly usage?: Pick<CompatibilityPathUsage, "record">;
  } = {},
): RecordDomainAdapterUsageResult {
  const counted = options.counted ?? buildCountedKeys();
  const usage = options.usage ?? compatibilityPathUsage;
  let accepted = 0;
  for (const entry of entries) {
    if (!isDomainName(entry.domain) || !counted.has(adapterKey(entry.domain, entry.version))) {
      continue;
    }
    usage.record(
      domainAdapterPathId("renderer", entry.domain, entry.version),
      Math.min(entry.count, MAX_DOMAIN_ADAPTER_USAGE_COUNT),
    );
    accepted += 1;
  }
  return { accepted, dropped: entries.length - accepted };
}
