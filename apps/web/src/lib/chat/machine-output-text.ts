/**
 * Compatibility surface for web callers. The classifier is shared with native
 * bridges so every transcript decides machine output with the same rules.
 */
export {
  isWithheldMachineOutput,
  jsonDocumentState,
  lastMachineJsonDocument,
} from "@orkestrator/protocol/structured-output";
export type { JsonDocumentState } from "@orkestrator/protocol/structured-output";
