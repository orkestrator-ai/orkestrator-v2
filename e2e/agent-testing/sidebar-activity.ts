import type { Page } from "@playwright/test";
import {
  environmentMarkerState,
  sidebarActivityFromMarkerState,
  type SidebarActivity,
} from "./idle-observation-live-support";

/**
 * What one environment's sidebar row shows, read from its status marker's
 * `data-state`. `unknown` when the row or its marker is absent, or the page
 * could not be read (a closed or navigating page).
 */
export async function sidebarActivity(
  page: Page,
  environmentName: string,
): Promise<SidebarActivity> {
  const state = await page.evaluate(environmentMarkerState, environmentName).catch(() => null);
  return sidebarActivityFromMarkerState(state);
}
