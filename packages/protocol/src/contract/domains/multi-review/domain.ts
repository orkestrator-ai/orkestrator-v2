/**
 * The `multi-review` contract domain (docs/reports/unified-federation.md
 * §11.2, plan item 7007): Multi Review workflows and review validation runs.
 * Version 1 until a change an older peer cannot handle silently.
 *
 * Browser-safe.
 */
import { defineDomain } from "../../domain.js";

export const multiReviewDomain = defineDomain({ name: "multi-review", version: 1 });
