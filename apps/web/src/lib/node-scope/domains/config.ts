/**
 * The `config` domain on a `lib/backend` factory's client (plan item 7005):
 * `config(client)().get_config({})`, and `clientStateCapabilities()`, which
 * version 1 answers without asking. The adapter is picked per call from the
 * node's negotiated `domains` (`domainApi`,
 * `./domain-api.ts`). `lib/backend/config-integrations.ts`,
 * `client-state.ts`, `permission-rules.ts` and the config layering
 * (`lib/portal/command-node-config.ts`, on both of its nodes) call it.
 */
import { configClient, type ConfigApi } from "@orkestrator/protocol/contract/domains/config";
import type { BackendClient } from "@/lib/backend/client";
import { domainApi } from "./domain-api";

export type { ConfigApi } from "@orkestrator/protocol/contract/domains/config";

export function config(client: BackendClient): () => ConfigApi {
  return () => domainApi(client, configClient);
}
