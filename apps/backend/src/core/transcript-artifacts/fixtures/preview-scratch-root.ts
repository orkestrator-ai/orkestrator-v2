import { tmpdir } from "node:os";

import { PARENT_TMPDIR_ENV } from "../../../../../../tests/temp-sweep.js";

/**
 * Where a process-isolation test runner makes its job scratch directories.
 * Each test process has a private TMPDIR (`tests/private-tmpdir.ts`); a scratch
 * directory inside it, with Chromium's `org.chromium.Chromium.*\/SingletonSocket`
 * inside that, passed Linux's 108-byte socket limit (113 bytes) and Chromium
 * aborted at launch. The parent TMPDIR gives the same depth as production. The
 * scratch directories stay owned: the supervisor removes each after a verified
 * exit, and the backend's startup recovery removes those of exited owners.
 */
export function previewTestScratchRoot(): string {
  return process.env[PARENT_TMPDIR_ENV] || tmpdir();
}
