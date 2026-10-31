import { sanitizeRunArtifacts } from "./global-teardown";

export default async function globalTeardown(): Promise<void> {
  await sanitizeRunArtifacts("goals");
}
