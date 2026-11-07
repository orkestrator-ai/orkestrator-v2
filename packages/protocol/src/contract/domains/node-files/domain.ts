/**
 * The `node-files` contract domain (docs/reports/unified-federation.md §11.2,
 * plan item 1010): files read and written on one node in bounded chunks, and
 * the command node's transfers between its nodes. Version 1 until a change
 * an older peer cannot handle silently.
 *
 * Browser-safe.
 */
import { defineDomain } from "../../domain.js";

export const nodeFilesDomain = defineDomain({ name: "node-files", version: 1 });
