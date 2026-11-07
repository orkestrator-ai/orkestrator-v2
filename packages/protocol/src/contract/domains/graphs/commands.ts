/**
 * Every `graphs` command (plan item 7007; docs/reports/unified-federation.md
 * §11.2, Appendix E): the template library and sharing
 * (`commands-templates.ts`), runs (`commands-runs.ts`), and describe jobs,
 * launches and mock runs (`commands-launch.ts`).
 *
 * Browser-safe.
 */
import { GRAPH_LAUNCH_COMMANDS } from "./commands-launch.js";
import { GRAPH_RUN_COMMANDS } from "./commands-runs.js";
import { GRAPH_TEMPLATE_COMMANDS } from "./commands-templates.js";

export * from "./commands-templates.js";
export * from "./commands-runs.js";
export * from "./commands-launch.js";

export const GRAPHS_COMMANDS = [
  ...GRAPH_TEMPLATE_COMMANDS,
  ...GRAPH_RUN_COMMANDS,
  ...GRAPH_LAUNCH_COMMANDS,
] as const;
