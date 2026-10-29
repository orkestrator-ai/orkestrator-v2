// The transcript-artifacts domain's public surface: the only module other
// backend code imports. Re-export by name (never `export *`) so the surface
// stays reviewable. The storage layer imports store-layout.js directly:
// routing it through here would close a runtime import cycle with storage.
export { registerTranscriptArtifactCommands } from "./commands.js";
export {
  containerRelativePath,
  registerTranscriptArtifactPdfCommands,
  type CommandLookup,
} from "./commands-pdf.js";
export type { TranscriptArtifactRuntime } from "./runtime.js";
export {
  attachTranscriptArtifactRuntime,
  createTranscriptArtifactService,
} from "./runtime-wiring.js";
export type { TranscriptArtifactService } from "./service.js";
export {
  ARTIFACT_ONLY_SERVER_INSTRUCTIONS,
  ARTIFACT_TOOL_INSTRUCTIONS,
  registerTranscriptArtifactTools,
  type TranscriptArtifactToolHost,
} from "./tools.js";
