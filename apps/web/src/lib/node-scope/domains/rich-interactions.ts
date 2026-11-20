/**
 * The `rich-interactions` domain on a `lib/backend` factory's client:
 * `richInteractions(client)().rich_interaction_submit({...})`. The adapter is
 * picked per call from the node's negotiated `domains` (`domainApi`).
 */
import {
  richInteractionsClient,
  type RichInteractionsApi,
} from "@orkestrator/protocol/contract/domains/rich-interactions";
import type { BackendClient } from "@/lib/backend/client";
import { domainApi } from "./domain-api";

export type { RichInteractionsApi } from "@orkestrator/protocol/contract/domains/rich-interactions";

export function richInteractions(client: BackendClient): () => RichInteractionsApi {
  return () => domainApi(client, richInteractionsClient);
}
