// The permission-rules domain's public surface: the only module other backend
// code imports. Re-export by name (never `export *`) so the surface stays
// reviewable.
export { PermissionRuleEnforcer, type PermissionRuleChoice } from "./enforcer.js";
export { listExternalPermissionRules } from "./external-rules.js";
export { PERMISSION_RULE_STORE_LAYOUTS } from "./layout.js";
export {
  acpRuleDetail,
  claudeRuleDetail,
  codexRuleDetail,
  openCodeRuleDetail,
} from "./request-detail.js";
export { PermissionRuleStore } from "./store.js";
