/**
 * The `agent-mail` contract domain (docs/reports/unified-federation.md §11.2):
 * agent mailboxes, messages and conversations on one node, the agent registry
 * and the messaging settings. Mail between nodes is the separate `node-mail`
 * domain. Version 2 since commands nothing called were removed on 2026-11-10
 * (docs/architecture/version-compatibility.md, Retired); version 1 peers are
 * still accepted (`min: 1`). The next change an older peer cannot handle
 * silently bumps it again.
 *
 * Browser-safe.
 */
import { defineDomain } from "../../domain.js";

export const agentMailDomain = defineDomain({ name: "agent-mail", version: 2, min: 1 });
