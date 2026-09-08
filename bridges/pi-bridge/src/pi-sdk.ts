/**
 * The public Pi SDK values this bridge needs at runtime.
 *
 * Keep the exported names and PI_BRIDGE_RUNTIME_EXPORTS together. The bridge
 * imports every runtime value through this module, while the vendoring test
 * uses the list to prove the staged package exposes the same surface.
 */
export {
  convertToPng,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  detectSupportedImageMimeTypeFromFile,
  getAgentDir,
  getLastAssistantUsage,
  ModelRuntime,
  resizeImage,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

export const PI_BRIDGE_RUNTIME_EXPORTS = [
  "convertToPng",
  "createAgentSessionFromServices",
  "createAgentSessionRuntime",
  "createAgentSessionServices",
  "detectSupportedImageMimeTypeFromFile",
  "getAgentDir",
  "getLastAssistantUsage",
  "ModelRuntime",
  "resizeImage",
  "SessionManager",
  "SettingsManager",
] as const;
