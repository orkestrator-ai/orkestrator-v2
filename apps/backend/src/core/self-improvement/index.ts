// The self-improvement domain's public surface: the only module other backend
// code imports. Re-export by name (never `export *`) so the surface stays
// reviewable.
export type { Board, BoardTicket } from "./loop.js";
export { SelfImprovementService } from "./service.js";
