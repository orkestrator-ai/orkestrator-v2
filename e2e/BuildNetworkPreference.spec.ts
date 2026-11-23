import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

async function pickMachine(page: Page, name: string) {
  await page.getByRole("combobox", { name: "Machine" }).click();
  await page.getByRole("option", { name: new RegExp(`^${name}`) }).click();
}

test("remote network defaults wait for their owner and preserve an explicit choice", async ({
  page,
}, info) => {
  await page.goto("/delivery-policy?launch&machines");
  // Exercise the actual dialog and routing hooks, with a controlled remote owner.
  await page.evaluate(async () => {
    const { portalStore } = await window.__fixtureModules!["lib/portal/portal-store"]();
    const store = portalStore as unknown as {
      invokeOnNode: (node: string, command: string) => Promise<unknown>;
    };
    store.invokeOnNode = async (_node: string, command: string) => {
      if (command === "check_docker") return { available: true };
      if (command === "get_config")
        return new Promise((resolve, reject) => {
          const holder = window as unknown as { buildNetworkReads?: number };
          Object.assign(window, {
            answerBuildNetwork: resolve,
            rejectBuildNetwork: reject,
            buildNetworkReads: (holder.buildNetworkReads ?? 0) + 1,
          });
        });
      throw new Error(`Unexpected fixture command: ${command}`);
    };
  });
  await pickMachine(page, "Builder");
  const where = page.getByRole("radiogroup", { name: "Where it runs" });
  await expect(where.getByRole("radio", { name: /^Container/ })).toBeEnabled();
  await where.getByText("Container", { exact: true }).click();
  await expect(page.getByText("Loading saved network access…")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start build" })).toBeDisabled();
  const output = path.join(process.cwd(), "output/visual-previews");
  await mkdir(output, { recursive: true });
  await page.getByRole("radiogroup", { name: "Network access" }).scrollIntoViewIfNeeded();
  await page.screenshot({
    animations: "disabled",
    path: path.join(output, `build-network-loading-v3-${info.project.name}.png`),
  });
  await page.evaluate(() =>
    (window as unknown as { answerBuildNetwork: (value: unknown) => void }).answerBuildNetwork({
      repositories: { "project-builder": { lastBuildNetworkAccessMode: "restricted" } },
    }),
  );
  await expect(page.getByRole("radio", { name: /^Restricted/ })).toBeChecked();
  await expect(
    page
      .getByRole("radio", { name: /^Restricted/ })
      .locator("..")
      .locator("label"),
  ).toHaveClass(/border-cyan/);
  await expect(page.getByRole("button", { name: "Start build" })).toBeEnabled();
  await page.screenshot({
    animations: "disabled",
    path: path.join(output, `build-network-remote-saved-v3-${info.project.name}.png`),
  });

  await pickMachine(page, "Studio Mac");
  await pickMachine(page, "Builder");
  await where.getByText("Container", { exact: true }).click();
  await page.waitForFunction(
    () => (window as unknown as { buildNetworkReads: number }).buildNetworkReads === 2,
  );

  await page
    .getByRole("radiogroup", { name: "Network access" })
    .getByText("Full access", { exact: true })
    .click();
  await page.evaluate(() =>
    (window as unknown as { answerBuildNetwork: (value: unknown) => void }).answerBuildNetwork({
      repositories: { "project-builder": { lastBuildNetworkAccessMode: "restricted" } },
    }),
  );
  await expect(page.getByRole("button", { name: "Start build" })).toBeEnabled();
  await expect(page.getByRole("radio", { name: /^Full access/ })).toBeChecked();

  await pickMachine(page, "Studio Mac");
  await pickMachine(page, "Builder");
  await where.getByText("Container", { exact: true }).click();
  await page.waitForFunction(
    () => (window as unknown as { buildNetworkReads: number }).buildNetworkReads === 3,
  );

  await page.evaluate(() =>
    (window as unknown as { rejectBuildNetwork: (error: unknown) => void }).rejectBuildNetwork(
      new Error("Fixture owner disconnected"),
    ),
  );
  await expect(page.getByRole("alert")).toContainText(
    "Could not load this machine's saved network access",
  );
  await expect(page.getByRole("button", { name: "Start build" })).toBeDisabled();
  await page.getByRole("alert").scrollIntoViewIfNeeded();
  await page.screenshot({
    animations: "disabled",
    path: path.join(output, `build-network-error-v3-${info.project.name}.png`),
  });
});
