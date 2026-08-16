import { BuildPipelineServiceInteractions } from "./build-pipeline-service-interactions.js";

/**
 * Public build-pipeline service facade. Implementation is layered by lifecycle,
 * supervisor/stage progression, recovery, and interaction persistence.
 */
export class BuildPipelineService extends BuildPipelineServiceInteractions {}
