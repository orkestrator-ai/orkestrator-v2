/**
 * The `graphs` contract domain (docs/reports/unified-federation.md §11.2,
 * plan item 7007): graph templates, sharing, describe jobs, launches, runs and
 * mock runs. Version 1 until a change an older peer cannot handle silently.
 *
 * Browser-safe.
 */
import { defineDomain } from "../../domain.js";

export const graphsDomain = defineDomain({ name: "graphs", version: 1 });
