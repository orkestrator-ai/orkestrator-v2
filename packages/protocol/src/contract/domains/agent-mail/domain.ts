/**
 * The `agent-mail` contract domain (docs/reports/unified-federation.md
 * §11.2): agent mailboxes, messages and conversations on one node, the
 * agent registry and the messaging settings. Mail between nodes is the
 * separate `node-mail` domain. Version 1 until a change an older peer cannot
 * handle silently.
 *
 * Browser-safe.
 */
import { defineDomain } from "../../domain.js";

export const agentMailDomain = defineDomain({ name: "agent-mail", version: 1 });
