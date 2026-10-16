import { sanitizeRunArtifacts } from "./global-teardown";

export default async function coordinatorLiveTeardown(): Promise<void> {
  await sanitizeRunArtifacts("coordinator");
}
