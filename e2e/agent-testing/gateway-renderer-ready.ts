import { DIRECT_LOAD_WAIT_MS, expect, type Page } from "./browser-test";

/**
 * The dev renderer imports App asynchronously, then restores cached catalogues
 * before its first React render. Navigation load events do not await that work.
 * Use the existing cold module-load bound here; interaction assertions keep
 * their normal deadlines once the application has painted.
 */
export async function waitForGatewayRenderer(page: Page): Promise<void> {
  await expect(page.locator("#root")).not.toBeEmpty({ timeout: DIRECT_LOAD_WAIT_MS });
}
