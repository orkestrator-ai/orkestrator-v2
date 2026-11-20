/**
 * The `rich-interactions` contract domain: app-owned interaction requests in
 * agent sessions, the user's drafts and submissions, delivery receipts and
 * session deliverable metadata. Version 1.
 *
 * Browser-safe.
 */
import { defineDomain } from "../../domain.js";

export const richInteractionsDomain = defineDomain({ name: "rich-interactions", version: 1 });
