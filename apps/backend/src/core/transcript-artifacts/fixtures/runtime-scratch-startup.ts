import { createTranscriptArtifactRuntime } from "../runtime.js";

// A fresh backend process observes its own TMPDIR, with no module mocks or
// changes to the parent test runner's scratch directory.
const runtime = await createTranscriptArtifactRuntime({
  dataDir: process.argv[3]!,
  publishedPinFile: null,
  env: {
    ORKESTRATOR_ARTIFACT_PREVIEW_ISOLATION: process.argv[2]!,
    ORKESTRATOR_ARTIFACT_PREVIEW_DOCKER: process.argv[4]!,
    ORKESTRATOR_ARTIFACT_PREVIEW_IMAGE: `worker@sha256:${"a".repeat(64)}`,
  },
  logger: { info: () => {}, warn: (message) => console.error(message) },
});
try {
  console.log(JSON.stringify({ isolation: runtime.config.isolation }));
} finally {
  await runtime.close();
}
