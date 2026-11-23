import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

export const FIXTURE_IDENTITY_PATH = "/__orkestrator_fixture_server";
export const FIXTURE_IDENTITY_HEADER = "x-orkestrator-fixture-server";
export const FIXTURE_PREVIEW_IDENTITY_ENV = "ORKESTRATOR_E2E_FIXTURE_PREVIEW_IDENTITY";
export const FIXTURE_OUT_DIR_ENV = "ORKESTRATOR_E2E_FIXTURE_OUT_DIR";

export function fixtureDevIdentity(root = path.join(import.meta.dirname, "fixture")): string {
  return `dev-${createHash("sha256").update(realpathSync(root)).digest("hex")}`;
}
