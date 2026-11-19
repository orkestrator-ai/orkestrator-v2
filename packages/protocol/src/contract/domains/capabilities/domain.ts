/**
 * The `capabilities` contract domain: Agent Capabilities management
 * (docs/architecture/agent-capabilities-management.md). Version 1; its
 * commands (`./commands.ts`) and events (`./events.ts`) share it.
 *
 * Browser-safe.
 */
import { defineDomain } from "../../domain.js";

export const capabilitiesDomain = defineDomain({ name: "capabilities", version: 1 });
