// The design domain's public surface: the only module other backend code
// imports. Re-export by name (never `export *`) so the surface stays reviewable.
export { registerDesignCommandHandlers } from "./commands.js";
export { resolveDesignDestination } from "./exports.js";
export { DesignService } from "./service.js";
export { resolveDesignChromiumPath } from "./renderer.js";
export { createDesignMcp } from "./tools.js";
