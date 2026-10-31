import { expect, test, type Locator } from "@playwright/test";

/** Computed paint of an environment name, as the browser resolves it. */
function paint(name: Locator) {
  return name.evaluate((element) => {
    const styles = getComputedStyle(element);
    return {
      animationName: styles.animationName,
      backgroundImage: styles.backgroundImage,
      color: styles.color,
      textFill: styles.getPropertyValue("-webkit-text-fill-color"),
      textOverflow: styles.textOverflow,
    };
  });
}

for (const [signal, label] of [
  ["merge-ready", "Ready to merge"],
  ["needs-answer", "Waiting for your answer"],
  ["merge-conflicts", "Merge conflicts to resolve"],
] as const) {
  test(`${signal} sweeps; reduced motion and forced colors retain a readable signal`, async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ reducedMotion: "no-preference", forcedColors: "none" });
    await page.goto(`/sidebar-drag?signal=${signal}`);

    const ready = page.getByText("p-env-1", { exact: true });
    const blocked = page.getByText("p-env-2", { exact: true });
    await expect(ready).toBeVisible();
    await expect(ready).toHaveAttribute("data-name-signal", signal);
    await expect(blocked).not.toHaveAttribute("data-merge-ready", "true");

    const moving = await paint(ready);
    expect(moving.animationName).toBe("text-shimmer");
    expect(moving.backgroundImage).toContain("linear-gradient");
    expect(moving.textFill).toBe("rgba(0, 0, 0, 0)");
    // The name keeps its own colour (the row's muted text) and its truncation.
    const resting = await paint(blocked);
    expect(moving.color).toBe(resting.color);
    expect(moving.textOverflow).toBe("ellipsis");
    // The reduced-motion indicator stays out of the way while the sweep runs.
    const row = page.getByRole("button", { name: "p-env-1", exact: true });
    await expect(row.getByTestId(`${signal}-indicator`)).toBeHidden();
    await expect(row).toHaveAccessibleDescription(label);
    await page.screenshot({ path: testInfo.outputPath(`${signal}-moving.png`) });

    await page.emulateMedia({ reducedMotion: "reduce" });
    const still = await paint(ready);
    expect(still.animationName).toBe("none");
    expect(still.backgroundImage).toBe("none");
    expect(still.textFill).not.toBe("rgba(0, 0, 0, 0)");
    // The static highlight is the band's colour, not the resting text colour.
    expect(still.color).not.toBe(resting.color);
    await expect(row.getByTestId(`${signal}-indicator`)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${signal}-reduced-motion.png`) });

    await page.emulateMedia({ reducedMotion: "no-preference", forcedColors: "active" });
    const forced = await paint(ready);
    expect(forced.animationName).toBe("none");
    expect(forced.backgroundImage).toBe("none");
    expect(forced.textFill).not.toBe("rgba(0, 0, 0, 0)");
    await expect(row.getByTestId(`${signal}-indicator`)).toBeVisible();
  });
}

test("another machine's clean PR stays plain without leaf monitor health", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/remote-machine-tree?merge-ready=1");

  // Even a current clean persisted snapshot cannot establish that the leaf's
  // monitor checked GitHub successfully during its current lifetime.
  const name = page.getByText("b", { exact: true });
  await expect(name).toBeVisible();
  await expect(name).not.toHaveAttribute("data-merge-ready", "true");
  expect((await paint(name)).animationName).toBe("none");
  const row = page.getByRole("button", { name: /^b, on Remote/ });
  await expect(row).not.toHaveAccessibleDescription("Ready to merge");
  await expect(row.getByTestId("merge-ready-indicator")).toHaveCount(0);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(name).not.toHaveAttribute("data-merge-ready", "true");
  await expect(row.getByTestId("merge-ready-indicator")).toHaveCount(0);
  await expect(page.getByText("c", { exact: true })).not.toHaveAttribute(
    "data-merge-ready",
    "true",
  );
});

test("another machine's rows shimmer once its own monitor vouches for the reading", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/remote-machine-tree?merge-ready=confirmed");

  const ready = page.getByText("b", { exact: true });
  await expect(ready).toHaveAttribute("data-merge-ready", "true");
  expect((await paint(ready)).animationName).toBe("text-shimmer");
  await expect(page.getByRole("button", { name: /^b, on Remote/ })).toHaveAccessibleDescription(
    "Ready to merge",
  );

  const conflicted = page.getByText("c", { exact: true });
  await expect(conflicted).toHaveAttribute("data-name-signal", "merge-conflicts");
  await expect(page.getByRole("button", { name: /^c, on Remote/ })).toHaveAccessibleDescription(
    "Merge conflicts to resolve",
  );
});

test("remote waiting follows live activity, transport, container and deletion changes", async ({
  page,
}) => {
  await page.goto("/remote-machine-tree");
  const row = page.getByRole("button", { name: /^b, on Remote/ });
  const name = row.locator("span.truncate").first();
  const change = async (state: string) =>
    page.getByRole("button", { name: `Signal ${state}`, exact: true }).click();
  const waiting = async () => {
    await expect(name).toHaveAttribute("data-name-signal", "needs-answer");
    await expect(row).toHaveAccessibleDescription("Waiting for your answer");
  };
  const plain = async () => {
    await expect(name).not.toHaveAttribute("data-name-signal");
    await expect(name).not.toHaveClass(/text-shimmer/);
    await expect(row).not.toHaveAttribute("aria-describedby");
    await expect(row.getByTestId("needs-answer-indicator")).toHaveCount(0);
  };
  await plain();
  await change("waiting");
  await waiting();
  await row.focus();
  await expect(page.getByTestId("environment-tooltip-needs-answer")).toBeVisible();
  await row.blur();
  await change("working");
  await plain();
  await change("waiting");
  await waiting();
  await change("disconnect");
  await plain();
  await change("connect");
  await waiting();
  await change("stopped");
  await plain();
  await change("running");
  await waiting();
  await change("deleting");
  await plain();
  await row.focus();
  await expect(page.getByTestId("environment-tooltip-needs-answer")).toHaveCount(0);
  await change("restore");
  await waiting();
});
