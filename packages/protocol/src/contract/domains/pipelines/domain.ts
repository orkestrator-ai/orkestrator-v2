/**
 * The `pipelines` contract domain (docs/reports/unified-federation.md §11.2,
 * plan item 7007): build pipelines, feature builds and the workflow result
 * transport's operational commands. Version 1 until a change an older peer
 * cannot handle silently.
 *
 * Browser-safe.
 */
import { defineDomain } from "../../domain.js";

export const pipelinesDomain = defineDomain({ name: "pipelines", version: 1 });
