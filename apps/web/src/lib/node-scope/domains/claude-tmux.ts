/**
 * The `claude-tmux` domain on a `lib/backend` factory's client (plan item
 * 7002): `claudeTmux(client).claude_tmux_status({ environmentId, tabId })`.
 * See `./domain-api.ts` for the adapter choice and the hot path.
 */
import {
  claudeTmuxClient,
  type ClaudeTmuxApi,
} from "@orkestrator/protocol/contract/domains/claude-tmux";
import type { BackendClient } from "@/lib/backend/client";
import { domainApi } from "./domain-api";

export type { ClaudeTmuxApi } from "@orkestrator/protocol/contract/domains/claude-tmux";

export function claudeTmux(client: BackendClient): ClaudeTmuxApi {
  return domainApi(client, claudeTmuxClient);
}
