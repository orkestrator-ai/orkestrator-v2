/**
 * Design canvas accessibility: keyboard-only journey, focus survival and
 * accessibility-tree structure, against the real design runtime and a real
 * DesignService (hosted in Bun, as in DesignCanvas.spec.ts).
 *
 * AUTOMATED OBSERVATIONS — NOT A SCREEN-READER PASS. Chromium's accessibility
 * tree (Playwright `ariaSnapshot`) is the closest automated proxy for what a
 * screen reader is given; no VoiceOver/NVDA session produced these notes.
 *
 * Recorded 2026-10-22: Chromium via Playwright 1.64 on macOS, at 1024×900
 * (desktop) and 390×844 (phone; the pane is narrow, so Layers and the
 * inspector are drawers), plus 640×450 @2x (≈200% zoom of 1280×900),
 * 320×225 @4x (≈400%) and a 320×700 narrow pane. The ARIA snapshots of the
 * four regions are attached to each run (aria-*.yml).
 *
 * Structure
 * - Layer tree: `tree "Layers"` of `treeitem`s with aria-level, aria-expanded,
 *   aria-selected, aria-setsize/posinset and a single roving tabindex=0 row.
 *   Frame rows read "<frame>, <n> elements"; element rows "<id or tag>
 *   (<tag>)". Each row also exposes its tabindex=-1 name button (frames add
 *   "Frame actions for …"), so treeitems have interactive descendants that
 *   a reader may announce after the row name.
 * - Frame list: frames are the level-1 treeitems; on the canvas each is
 *   `region "Frame <name>"` with "Move frame <name>" (aria-description:
 *   arrow keys move, Alt+arrows resize, Shift for 10 px) and "Resize frame
 *   <name>". A culled frame is an empty "Frame <name> (offscreen)" region.
 * - Inspector: `complementary "Element inspector"`, a `region` per section,
 *   every control named by its visible label (WCAG 2.5.3 label in name, for
 *   speech input): "Fill", not "background-color". The CSS property is in
 *   `data-property` on the field (and the label's tooltip). Fixed 2026-10-25;
 *   until then fields were named by property.
 * - Status: a polite sr-only `status` carries conflict/failure, export,
 *   reselect and delete notices; the footer save state is now a `status`
 *   too ("Saving in workspace…" → "Saved in workspace" / "Needs review").
 *
 * Focus (a rAF watcher fails a test if focus rests on <body> for 2+ frames
 * and 100+ ms; a briefer stay is tolerated because Radix restores dialog
 * focus from a zero-delay timer, which runs late on a loaded host)
 * - From page load, the tree is the 17th/18th Tab stop (fixture button,
 *   toolbar, filter). From the tree, the inspector colour field is 35 more
 *   on desktop (canvas frame controls come first) and 27 from the drawer's
 *   first field on the phone.
 * - Fixed with this spec, each reproduced first and asserted here: closing
 *   the inspector, the narrow inspector drawer replacing Layers, a conflict
 *   staling the selection (fields disabled), zooming a focused frame out of
 *   view, closing the export dialog, and pressing Export (the button is
 *   disabled while writing; focus now moves to Cancel, which becomes Done)
 *   all dropped focus to <body>; an
 *   acknowledgement moved focus from the edited field to the first field; a
 *   successful edit was never announced.
 * - Layer-tree windowing keeps the focused and the selected rows mounted.
 * - Enter on an element row of a frame that is not rendered yet brings the
 *   frame into view, announces "Loading <frame>; the layer is selected when
 *   it appears" and selects once the frame renders (fixed 2026-10-25; it
 *   used to need a second Enter, silently). Moving to another frame first
 *   drops the wait.
 * - Fixed: a frame culled while its layers loaded showed the row "Could not
 *   load layers: Frame closed" (the 400% case hit it on a loaded host)
 *   instead of falling back to the backend hierarchy.
 *
 * Motion, zoom and narrow panes
 * - prefers-reduced-motion: every transition and animation inside the
 *   workspace is 0.01 ms. The dialog `animate-in` utilities are inert (no
 *   tw-animate-css), so dialogs and listboxes never animate; the dialog keeps
 *   `transition: all 200ms` even under reduced motion, with nothing changing.
 * - 200% and 320 px: no horizontal overflow; every control outside the
 *   pannable canvas is reachable by Tab and unclipped when focused; the
 *   journey works.
 * - 400% (320×225): below 400 px of height the toolbar keeps Layers, the
 *   design name (and the narrow inspector toggle) and moves every other tool
 *   into a "More design tools" menu, so it is one row instead of three that
 *   took half the height. Every focused control is unclipped and uncovered
 *   (asserted, as at 200%); the menu keeps zoom steps open and returns focus
 *   to its trigger after an action or a dialog it opened. Fixed 2026-10-25.
 *
 * Still needs a human screen-reader pass: wording and verbosity (treeitem
 * descendants, 30+ inspector fields), live-region timing during bursts of
 * nudges, whether aria-description on frame titles is voiced, the frame
 * iframe in Preview mode, and VoiceOver rotor / NVDA browse-mode navigation.
 */
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { planDefaultDesignExportPath } from "../apps/backend/src/core/design/export-writer";
import { startDesignServiceHost, type DesignServiceHost } from "./design-service-client";

const ENVIRONMENT = "design-fixture";
const ITEM_COUNT = 60;

interface Fixture {
  service: DesignServiceHost;
  canvasId: string;
  homepageId: string;
  pricingId: string;
  worktree: string;
  frame: (id?: string) => ReturnType<DesignServiceHost["getFrame"]>;
}

/** A canvas with a long frame (for tree windowing) and a far-away second frame (for culling). */
async function withCanvas(page: Page, run: (fixture: Fixture) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "ork-design-a11y-"));
  const worktree = join(dir, "worktree");
  await mkdir(worktree);
  const service = startDesignServiceHost(dir, worktree);
  try {
    const canvas = await service.create(ENVIRONMENT, "A11y QA");
    const items = Array.from(
      { length: ITEM_COUNT },
      (_, index) => `<p id="item-${index + 1}">Item ${index + 1}</p>`,
    ).join("");
    const { frame: homepage } = await service.createFrame(
      canvas.id,
      ENVIRONMENT,
      1,
      {
        name: "Homepage",
        x: 0,
        y: 0,
        width: 480,
        height: 400,
        html: `<style>body{margin:0;padding:24px;font-family:system-ui}h1{color:rgb(20,30,40)}p{margin:2px 0}</style><h1 id="title">Accessible fixture</h1>${items}`,
      },
      "user",
    );
    const { frame: pricing } = await service.createFrame(
      canvas.id,
      ENVIRONMENT,
      2,
      {
        name: "Pricing",
        x: 3000,
        y: 0,
        width: 480,
        height: 400,
        html: "<h2 id='plans'>Plans</h2>",
      },
      "user",
    );
    await page.exposeFunction("designInvoke", (command: string, args: Record<string, unknown>) =>
      service.invoke(command, args),
    );
    await run({
      service,
      canvasId: canvas.id,
      homepageId: homepage.id,
      pricingId: pricing.id,
      worktree,
      frame: (id = homepage.id) => service.getFrame(canvas.id, ENVIRONMENT, id),
    });
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const layers = (page: Page) => page.getByRole("tree", { name: "Layers" });
const inspectorOf = (page: Page) => page.getByRole("complementary", { name: "Element inspector" });
const announcer = (page: Page) => page.locator('p.sr-only[role="status"]');
const saveState = (page: Page) => page.getByRole("contentinfo").getByRole("status");
const rovingRow = (page: Page) => layers(page).locator('[role="treeitem"][tabindex="0"]');
const narrowPane = (page: Page) =>
  page.locator(".design-workspace").evaluate((element) => element.hasAttribute("data-narrow"));

async function openCanvas(page: Page, canvasId: string) {
  await page.goto(`/design-canvas?canvasId=${canvasId}`);
  await expect(
    layers(page).getByRole("treeitem", { name: /^Homepage, \d+ elements$/ }),
  ).toBeVisible();
}

/**
 * Tabs into the tree, focuses (Enter: expand and fit) the Homepage frame and
 * selects its heading. One Enter selects even before the frame has rendered.
 */
async function selectHeadingByKeyboard(page: Page) {
  const frameRow = layers(page).getByRole("treeitem", { name: /^Homepage, \d+ elements$/ });
  await tabTo(page, frameRow);
  await page.keyboard.press("Enter");
  await expect(frameRow).toHaveAttribute("aria-expanded", "true");
  const titleRow = layers(page).getByRole("treeitem", { name: "title (h1)" });
  await expect(titleRow).toBeAttached();
  await tabTo(page, titleRow, "ArrowDown", 1);
  await page.keyboard.press("Enter");
  await expect(inspectorOf(page)).toBeVisible();
}

/** Presses `key` (Tab by default) until `target` holds focus; returns the number of presses. */
async function tabTo(page: Page, target: Locator, key = "Tab", max = 120): Promise<number> {
  for (let presses = 0; presses <= max; presses++) {
    if (
      await target.evaluateAll((elements) =>
        elements.some((element) => element === document.activeElement),
      )
    )
      return presses;
    if (presses < max) await page.keyboard.press(key);
  }
  const at = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 160));
  throw new Error(`${key} never reached ${target}; focus is on ${at}`);
}

const pause = (page: Page, ms: number) =>
  page.evaluate((delay) => new Promise((resolve) => setTimeout(resolve, delay)), ms);

/**
 * Records every time focus rests on <body> for two or more consecutive
 * animation frames and at least 100 ms after having been on a control.
 * Installed after the page loads (a load starts on <body>). A brief stay is
 * tolerated: Radix dialogs restore focus from a zero-delay timer after
 * unmounting, on every dialog, and on a loaded host that timer can run a few
 * frames late.
 */
async function watchFocus(page: Page) {
  await page.evaluate(() => {
    const describe = (element: Element) =>
      `${element.tagName.toLowerCase()}[${element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 40) ?? ""}]`;
    const state = {
      losses: [] as string[],
      last: "<body>",
      paused: false,
      onBody: 0,
      since: 0,
      from: "",
    };
    (window as unknown as { __focusWatch: typeof state }).__focusWatch = state;
    const tick = () => {
      const active = document.activeElement;
      if (state.paused) {
        state.last = "<body>";
        state.onBody = 0;
      } else if (!active || active === document.body) {
        if (state.last !== "<body>") {
          state.from = state.last;
          state.since = performance.now();
        }
        state.last = "<body>";
        if (state.from && ++state.onBody >= 2 && performance.now() - state.since >= 100) {
          state.losses.push(`lost after ${state.from}`);
          state.from = "";
        }
      } else {
        state.last = describe(active);
        state.onBody = 0;
        state.from = "";
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function expectFocusNeverLost(page: Page) {
  // Give a late unmount or focus fixup a few frames to show up.
  await pause(page, 150);
  expect(
    await page.evaluate(
      () => (window as unknown as { __focusWatch: { losses: string[] } }).__focusWatch.losses,
    ),
  ).toEqual([]);
}

/** Focus is on `target` and stays there (not just for one frame). */
async function expectSettledFocus(page: Page, target: Locator) {
  await expect(target).toBeFocused();
  await pause(page, 250);
  await expect(target).toBeFocused();
}

async function typeStyle(page: Page, value: string) {
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(value);
  await page.keyboard.press("Enter");
}

test("keyboard-only journey keeps focus through acknowledgement, panels, culling and errors", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await withCanvas(page, async ({ service, canvasId, homepageId, pricingId, worktree, frame }) => {
    // Reopen: a reload lands back on the same canvas (view prefs restored).
    await openCanvas(page, canvasId);
    await page.reload();
    await openCanvas(page, canvasId);
    await watchFocus(page);
    const narrow = await narrowPane(page);
    const tree = layers(page);
    const inspector = inspectorOf(page);
    const frameRow = tree.getByRole("treeitem", { name: /^Homepage, \d+ elements$/ });
    const titleRow = tree.getByRole("treeitem", { name: "title (h1)" });
    const color = inspector.getByRole("textbox", { name: "Color", exact: true });
    const display = inspector.getByRole("combobox", { name: "Display", exact: true });
    const moveTitle = page.getByRole("button", { name: "Move frame Homepage" });
    const layersToggle = page.getByRole("button", { name: "Toggle layers" });
    const embedded = page.frameLocator('iframe[title="Homepage"]');

    // Tab from the top of the page into the tree: the roving row takes focus.
    await tabTo(page, frameRow);
    await expect(frameRow).toHaveAttribute("tabindex", "0");
    await expect(frameRow).toHaveAttribute("aria-level", "1");

    // Select the frame (Enter focuses, expands and fits it), then an element.
    await page.keyboard.press("Enter");
    await expect(frameRow).toHaveAttribute("aria-expanded", "true");
    await expect(frameRow).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('iframe[title="Homepage"]')).toHaveCount(1);
    await expectSettledFocus(page, frameRow);
    await page.keyboard.press("ArrowDown");
    await expectSettledFocus(page, titleRow);
    await page.keyboard.press("Enter");
    await expect(inspector).toBeVisible();
    await expect(inspector.getByRole("heading", { name: "h1" })).toBeVisible();
    if (narrow) {
      // (b) The inspector drawer replaces Layers: focus moves into it.
      await expect(tree).toBeHidden();
      await expectSettledFocus(page, display);
    } else {
      await expect(titleRow).toHaveAttribute("aria-selected", "true");
      await expectSettledFocus(page, titleRow);
    }

    // Edit a style through the inspector with the keyboard only.
    await tabTo(page, color);
    await typeStyle(page, "rgb(200, 0, 0)");
    // (a) The backend acknowledges; focus stays in the field being edited.
    await expect.poll(async () => (await frame()).revision).toBe(2);
    expect((await frame()).html).toContain("rgb(200, 0, 0)");
    await expect(embedded.locator("#title")).toHaveCSS("color", "rgb(200, 0, 0)");
    await expect(saveState(page)).toHaveText("Saved in workspace");
    await expectSettledFocus(page, color);
    // The applied value is now the authored baseline, no longer an unsent draft.
    await expect(color).toHaveValue("rgb(200, 0, 0)");
    await expect(color).not.toHaveAttribute("data-changed", "true");

    // (b) Closing the inspector returns focus to the Layers tree.
    await tabTo(page, inspector.getByRole("button", { name: "Close inspector" }), "Shift+Tab");
    await page.keyboard.press("Enter");
    await expect(inspector).toBeHidden();
    await expect(tree).toBeVisible();
    await expectSettledFocus(page, narrow ? rovingRow(page) : titleRow);

    // (b) The Layers panel/drawer toggle keeps focus on itself.
    await tabTo(page, layersToggle, "Shift+Tab");
    await page.keyboard.press("Enter");
    await expect(tree).toBeHidden();
    await expect(layersToggle).toHaveAttribute("aria-pressed", "false");
    await expectSettledFocus(page, layersToggle);
    await page.keyboard.press("Enter");
    await expect(tree).toBeVisible();
    await expect(layersToggle).toHaveAttribute("aria-pressed", "true");
    await expectSettledFocus(page, layersToggle);
    if (narrow) {
      // Escape closes narrow drawers and returns focus to the Layers toggle.
      await tabTo(page, rovingRow(page));
      await page.keyboard.press("Escape");
      await expect(tree).toBeHidden();
      await expectSettledFocus(page, layersToggle);
    }

    // Move and resize the frame from its title: arrows move, Alt+arrows resize.
    await tabTo(page, moveTitle);
    for (let step = 0; step < 3; step++) await page.keyboard.press("ArrowRight");
    await expect.poll(async () => (await frame()).x).toBe(3);
    await expectSettledFocus(page, moveTitle);
    // A new key burst (after the 800 ms gesture window) is a separate undo entry.
    await pause(page, 900);
    await page.keyboard.press("Alt+ArrowDown");
    await page.keyboard.press("Alt+ArrowDown");
    await expect.poll(async () => (await frame()).height).toBe(402);
    await expectSettledFocus(page, moveTitle);
    // The resize handle takes arrows too (Shift for 10 px).
    const resizeHandle = page.getByRole("button", { name: "Resize frame Homepage" });
    await pause(page, 900);
    await tabTo(page, resizeHandle);
    await page.keyboard.press("Shift+ArrowLeft");
    await expect.poll(async () => (await frame()).width).toBe(470);
    await expectSettledFocus(page, resizeHandle);

    // Undo the last gesture with the keyboard; focus stays put.
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await frame()).width).toBe(480);
    expect(await frame()).toMatchObject({ x: 3, height: 402 });
    await expectSettledFocus(page, resizeHandle);
    await expect(saveState(page)).toHaveText("Saved in workspace");

    // (c) Culling: zoom the focused frame out of view and back.
    await tabTo(page, moveTitle, "Shift+Tab");
    await page.keyboard.press("Shift+Digit1");
    for (let step = 0; step < 8; step++) await page.keyboard.press("+");
    await expect(page.getByRole("region", { name: "Frame Pricing (offscreen)" })).toHaveCount(1);
    // The focused frame lost its live preview but keeps its chrome and focus.
    await expect(page.locator('iframe[title="Homepage"]')).toHaveCount(0);
    await expectSettledFocus(page, moveTitle);
    await page.keyboard.press("Shift+Digit2");
    await expect(page.locator('iframe[title="Homepage"]')).toHaveCount(1);
    await expectSettledFocus(page, moveTitle);

    // (c) Layer-tree windowing keeps the focused row (and the selection) mounted.
    if (narrow) {
      await tabTo(page, layersToggle, "Shift+Tab");
      await page.keyboard.press("Enter");
      await expect(tree).toBeVisible();
    }
    await tabTo(page, rovingRow(page));
    await page.keyboard.press("Home");
    await expectSettledFocus(page, frameRow);
    await page.keyboard.press("ArrowDown");
    await expectSettledFocus(page, titleRow);
    if (!narrow) {
      await page.keyboard.press("Enter");
      await expect(titleRow).toHaveAttribute("aria-selected", "true");
      await expect(inspector).toBeVisible();
    }
    // End: the last row, in the Pricing frame after Homepage's 60+ rows. If
    // that row was "Loading layers…", the tree moves focus to its frame row
    // when the loaded rows replace it.
    await page.keyboard.press("End");
    await expectSettledFocus(page, rovingRow(page));
    await expect(rovingRow(page)).toHaveAttribute("data-row-key", new RegExp(`^${pricingId}`));
    await expect(tree.getByRole("treeitem", { name: "item-1 (p)" })).toHaveCount(0);
    if (!narrow) await expect(titleRow).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Home");
    await expectSettledFocus(page, frameRow);
    await page.keyboard.press("ArrowDown");
    await expectSettledFocus(page, titleRow);

    // (d) Error: a second client changes the frame before the edit is applied.
    if (narrow) {
      await page.keyboard.press("Enter");
      await expectSettledFocus(page, display);
    }
    await tabTo(page, color);
    await page.keyboard.type("blue");
    const before = await frame();
    await service.mutate(canvasId, ENVIRONMENT, homepageId, before.revision, {
      html: "<h1 id='title'>Agent's newer edit</h1>",
    });
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("alert").filter({ hasText: "Design revision conflict:" }).first(),
    ).toBeVisible();
    await expect(announcer(page)).toContainText("Design revision conflict:");
    await expect(saveState(page)).toHaveText("Needs review");
    // The stale inspector disables its fields; focus moves to the recovery action.
    const reselect = inspector.getByRole("button", { name: "Reselect" });
    await expectSettledFocus(page, reselect);
    expect((await frame()).html).toContain("Agent's newer edit");
    await page.keyboard.press("Enter");
    await expect(inspector).toBeHidden();
    await expect(announcer(page)).toHaveText(
      "Select the element again; your draft values are kept",
    );
    await expectSettledFocus(page, rovingRow(page));

    // Export to the repository, keyboard only; focus returns to the toolbar.
    const exportButton = page.getByRole("button", { name: "Export design to repository" });
    await tabTo(page, exportButton, "Shift+Tab");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Export design to repository" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("combobox", { name: "Folder" })).toBeFocused();
    const exportPath = planDefaultDesignExportPath("A11y QA", canvasId);
    const revision = (await service.get(canvasId, ENVIRONMENT)).revision;
    await tabTo(page, dialog.getByRole("button", { name: `Export revision ${revision}` }));
    await page.keyboard.press("Enter");
    await expect(dialog.getByText(`Exported revision ${revision} to ${exportPath}`)).toBeVisible();
    await expect(announcer(page)).toHaveText(`Exported revision ${revision} to ${exportPath}`);
    // Pressing Export moved focus to Cancel, which is now Done.
    await expectSettledFocus(page, dialog.getByRole("button", { name: "Done" }));
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expectSettledFocus(page, exportButton);
    const exported = JSON.parse(await readFile(join(worktree, exportPath), "utf8"));
    expect(exported).toMatchObject({ format: "orkdes", version: 1, id: canvasId, revision });
    expect(exported.frames[0].html).toContain("Agent's newer edit");

    await expectFocusNeverLost(page);
  });
});

async function attachSnapshot(testInfo: TestInfo, name: string, locator: Locator) {
  await testInfo.attach(`aria-${name}.yml`, {
    body: await locator.ariaSnapshot(),
    contentType: "text/yaml",
  });
}

test("layer tree, frame list, inspector and status regions expose stable roles and names", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await withCanvas(page, async ({ canvasId }) => {
    await openCanvas(page, canvasId);
    const narrow = await narrowPane(page);
    const tree = layers(page);
    const canvasViewport = page.getByRole("main", { name: "Canvas viewport" });
    await attachSnapshot(testInfo, "layer-tree", tree);
    await attachSnapshot(testInfo, "frame-list", canvasViewport);
    await expect(tree).toMatchAriaSnapshot(`
      - tree "Layers":
        - treeitem /^Homepage, \\d+ elements$/ [expanded] [level=1]:
          - button "Homepage"
          - button "Frame actions for Homepage"
        - treeitem "title (h1)" [level=2]
        - treeitem "item-1 (p)" [level=2]
    `);
    // Frames are the level-1 rows, numbered within the set.
    const frameRows = tree.locator('[role="treeitem"][aria-level="1"]');
    await expect(frameRows.first()).toHaveAttribute("aria-posinset", "1");
    await expect(frameRows.first()).toHaveAttribute("aria-setsize", "2");
    await expect(canvasViewport).toMatchAriaSnapshot(`
      - main "Canvas viewport":
        - region "Frame Homepage":
          - button /^Move frame Homepage/
          - button "Frame actions for Homepage"
          - button "Resize frame Homepage"
    `);
    await expect(page.getByRole("button", { name: "Move frame Homepage" })).toHaveAttribute(
      "aria-description",
      /Arrow keys move, Alt\+Arrow keys resize/,
    );
    // Exactly one roving tab stop in the tree.
    await expect(rovingRow(page)).toHaveCount(1);

    // Status regions: the announcer and the footer save state are both polite.
    await expect(announcer(page)).toHaveAttribute("aria-live", "polite");
    await expect(saveState(page)).toHaveText("Saved in workspace");
    await attachSnapshot(testInfo, "status", page.getByRole("contentinfo"));
    await expect(page.getByRole("contentinfo")).toMatchAriaSnapshot(`
      - contentinfo:
        - status: Saved in workspace
    `);

    // Select an element by keyboard and capture the inspector.
    await selectHeadingByKeyboard(page);
    const inspector = inspectorOf(page);
    if (!narrow) {
      await expect(tree).toMatchAriaSnapshot(`
        - tree "Layers":
          - treeitem /^Homepage/ [expanded] [level=1]
          - treeitem "title (h1)" [level=2] [selected]
      `);
    }
    await attachSnapshot(testInfo, "inspector", inspector);
    await expect(inspector).toMatchAriaSnapshot(`
      - complementary "Element inspector":
        - heading "h1" [level=3]
        - button "Ask agent"
        - button "Close inspector"
        - group:
          - region "Layout":
            - heading "Layout" [level=4]
            - combobox "Display"
          - region "Size and spacing":
            - textbox "Width"
            - textbox "Height"
          - region "Typography":
            - textbox "Size"
            - textbox "Color"
          - region "Appearance":
            - textbox "Fill"
          - region "Advanced":
            - textbox "New property name"
            - button "Add property"
        - button "Apply styles" [disabled]
        - button "Reset" [disabled]
    `);
    // Every inspector control has an accessible name.
    const unnamed = await inspector.evaluate((root) =>
      Array.from(root.querySelectorAll("input, button, select, textarea, [role=combobox]"))
        .filter((element) => {
          const label =
            element.getAttribute("aria-label") ??
            (element.id ? root.querySelector(`label[for="${element.id}"]`)?.textContent : null) ??
            element.textContent;
          return !label?.trim();
        })
        .map((element) => element.outerHTML.slice(0, 120)),
    );
    expect(unnamed).toEqual([]);
    // Label in name (WCAG 2.5.3): each field is named by the label it shows
    // (fields under the collapsed "More styles" are hidden, so unnamed).
    const fields = await inspector.locator("[data-property]:visible").all();
    expect(fields.length).toBeGreaterThan(5);
    for (const field of fields) {
      const label = (await field.locator("label").textContent())!.trim();
      await expect(
        field.locator('input:not([type="color"]), [role="combobox"]').first(),
      ).toHaveAccessibleName(label);
    }
  });
});

test("Enter on a layer of an unrendered frame announces the wait and selects once it renders", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await withCanvas(page, async ({ canvasId }) => {
    await openCanvas(page, canvasId);
    await watchFocus(page);
    const narrow = await narrowPane(page);
    const tree = layers(page);
    const inspector = inspectorOf(page);
    const pricing = page.locator('iframe[title="Pricing"]');
    const plansRow = tree.getByRole("treeitem", { name: "plans (h2)" });
    // Fit Homepage: Pricing, 3000 px to the right, is culled.
    const frameRow = tree.getByRole("treeitem", { name: /^Homepage, \d+ elements$/ });
    await tabTo(page, frameRow);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("region", { name: "Frame Pricing (offscreen)" })).toHaveCount(1);
    // Pricing's heading row (End lands on its frame row while its layers load).
    await page.keyboard.press("End");
    await expect(plansRow).toBeAttached();
    await tabTo(page, plansRow, "ArrowDown", 3);
    // Focusing the row keeps Pricing's chrome mounted offscreen, not rendered.
    await expect(pricing).toHaveCount(0);

    // Hold the real runtime's inspection reply, leaving the post-render window
    // open while the user moves focus to a different row in this same frame.
    await page.evaluate(() => {
      const state = window as unknown as {
        heldInspection?: MessageEvent;
        releaseInspection?: () => void;
      };
      const hold = (event: MessageEvent) => {
        if (event.data?.channel !== "orkestrator-design" || event.data?.result?.tag !== "h2")
          return;
        event.stopImmediatePropagation();
        state.heldInspection = event;
      };
      window.addEventListener("message", hold, true);
      state.releaseInspection = () => {
        window.removeEventListener("message", hold, true);
        const event = state.heldInspection!;
        window.dispatchEvent(
          new MessageEvent("message", {
            data: event.data,
            source: event.source,
            origin: event.origin,
          }),
        );
      };
    });
    // One Enter: Pricing comes into view and the wait is announced.
    await page.keyboard.press("Enter");
    await expect(announcer(page)).toHaveText(
      "Loading Pricing; the layer is selected when it appears",
    );
    await expect(pricing).toHaveCount(1);
    await expect
      .poll(() =>
        page.evaluate(() =>
          Boolean((window as unknown as { heldInspection?: MessageEvent }).heldInspection),
        ),
      )
      .toBe(true);
    const pricingRow = tree.getByRole("treeitem", { name: /^Pricing, \d+ elements$/ });
    await page.keyboard.press("ArrowUp");
    await expect(pricingRow).toBeFocused();
    await expect(inspector).toBeHidden();
    await page.evaluate(() =>
      (window as unknown as { releaseInspection: () => void }).releaseInspection(),
    );
    await expect(inspector).toBeVisible();
    await expect(inspector.getByRole("heading", { name: "h2" })).toBeVisible();
    if (narrow) {
      // The inspector drawer replaces Layers and takes focus.
      await expect(tree).toBeHidden();
      await expect(inspector.locator(":focus")).toHaveCount(1);
    } else {
      await expect(plansRow).toHaveAttribute("aria-selected", "true");
      await expectSettledFocus(page, pricingRow);
    }
    await expectFocusNeverLost(page);
  });
});

/** Largest transition/animation duration (seconds) of each element matching `selector`. */
const motionOf = (page: Page, selector: string) =>
  page.evaluate((query) => {
    const seconds = (value: string) =>
      Math.max(
        ...value.split(",").map((part) => {
          const text = part.trim();
          return text.endsWith("ms") ? Number.parseFloat(text) / 1000 : Number.parseFloat(text);
        }),
      );
    return Array.from(document.querySelectorAll(query)).map((element) => {
      const style = getComputedStyle(element);
      return {
        element: `${element.tagName.toLowerCase()}.${(element.getAttribute("class") ?? "").slice(0, 40)}`,
        transition: seconds(style.transitionDuration),
        animation: style.animationName === "none" ? 0 : seconds(style.animationDuration),
        animationName: style.animationName,
      };
    });
  }, selector);

test("prefers-reduced-motion disables canvas, dialog and popup animation", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "motion is width-independent");
  test.setTimeout(90_000);
  await withCanvas(page, async ({ canvasId }) => {
    const exportButton = page.getByRole("button", { name: "Export design to repository" });
    const dialog = page.getByRole("dialog", { name: "Export design to repository" });
    // Baseline: with no preference, the workspace and dialogs do animate.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await openCanvas(page, canvasId);
    const baseline = await motionOf(page, ".design-workspace *");
    expect(Math.max(...baseline.map((entry) => entry.transition))).toBeGreaterThan(0.05);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    await openCanvas(page, canvasId);
    // Every transition and animation inside the workspace is effectively instant.
    const reduced = await motionOf(page, ".design-workspace, .design-workspace *");
    expect(reduced.length).toBeGreaterThan(50);
    expect(reduced.filter((entry) => entry.transition > 0.001 || entry.animation > 0.001)).toEqual(
      [],
    );
    // Popups portalled outside the workspace: the export dialog and a listbox.
    await tabTo(page, exportButton);
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    const [reducedDialog] = await motionOf(page, '[role="dialog"]');
    expect(reducedDialog!.animationName).toBe("none");
    await testInfo.attach("reduced-motion-dialog.json", {
      body: JSON.stringify(
        await dialog.evaluate((element) => ({
          transitionProperty: getComputedStyle(element).transitionProperty,
          transitionDuration: getComputedStyle(element).transitionDuration,
        })),
      ),
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(exportButton).toBeFocused();
    await selectHeadingByKeyboard(page);
    const display = inspectorOf(page).getByRole("combobox", { name: "Display", exact: true });
    await tabTo(page, display);
    await page.keyboard.press("Enter");
    const listbox = page.getByRole("listbox");
    await expect(listbox).toBeVisible();
    const popups = await motionOf(page, '[role="listbox"]');
    expect(popups.length).toBeGreaterThan(0);
    expect(popups.filter((entry) => entry.animationName !== "none")).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(listbox).toBeHidden();
    await expect(display).toBeFocused();
  });
});

/**
 * Tabs through every focusable control once and returns those that are
 * clipped or covered when focused. Canvas content (inside the viewport) pans
 * and zooms by design and is excluded; its keyboard reachability is covered
 * by the journey.
 */
async function unreachableControls(page: Page) {
  // Restart from the top of the document. The deliberate blur, and Tab
  // leaving the end of the document, are not focus losses.
  const setPaused = (paused: boolean) =>
    page.evaluate((value) => {
      const watch = (window as unknown as { __focusWatch?: { paused: boolean } }).__focusWatch;
      if (watch) watch.paused = value;
      if (value) (document.activeElement as HTMLElement | null)?.blur();
    }, paused);
  await setPaused(true);
  const problems: string[] = [];
  const seen = new Set<string>();
  for (let presses = 0; presses < 160; presses++) {
    await page.keyboard.press("Tab");
    const report = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (!element || element === document.body) return null;
      const region = element.closest('[role="tree"]')
        ? "tree"
        : element.closest('[aria-label="Element inspector"]')
          ? "inspector"
          : "shell";
      const key = [
        region,
        element.tagName,
        element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 30),
        element.getAttribute("data-row-key") ?? "",
        element.closest("[data-property]")?.getAttribute("data-property") ?? "",
      ].join(":");
      if (element.closest('[aria-label="Canvas viewport"]')) return { key, problem: null };
      const rect = element.getBoundingClientRect();
      const inside =
        rect.width > 0 &&
        rect.height > 0 &&
        rect.left >= -1 &&
        rect.top >= -1 &&
        rect.right <= window.innerWidth + 1 &&
        rect.bottom <= window.innerHeight + 1;
      const hit = document.elementFromPoint(
        Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1),
        Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1),
      );
      // A visually hidden native input (the colour picker) sits under its swatch.
      const covered =
        !hit || !(element.contains(hit) || hit.contains(element) || hit === element.parentElement);
      return {
        key,
        problem: inside && !covered ? null : `${key} ${inside ? "covered" : "clipped"}`,
      };
    });
    if (!report) continue;
    if (seen.has(report.key)) break;
    seen.add(report.key);
    if (report.problem) problems.push(report.problem);
  }
  await setPaused(false);
  return { problems, reached: seen.size };
}

/**
 * Arrows down an open menu until `item` has focus. Radix moves focus a task
 * after the key, so each press waits for focus to move before the next.
 */
async function arrowTo(page: Page, item: Locator, max = 20) {
  const focused = () => page.evaluate(() => document.activeElement?.textContent ?? "");
  for (let presses = 0; presses < max; presses++) {
    if (await item.evaluate((element) => element === document.activeElement)) return;
    const before = await focused();
    await page.keyboard.press("ArrowDown");
    await expect.poll(focused).not.toBe(before);
  }
  throw new Error(`ArrowDown never reached ${item}`);
}

/** `target` lies inside the window and is not covered. */
const isOnScreen = (target: Locator) =>
  target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.top >= -1 &&
      rect.left >= -1 &&
      rect.bottom <= window.innerHeight + 1 &&
      rect.right <= window.innerWidth + 1 &&
      hit !== null &&
      (element === hit || element.contains(hit))
    );
  });

/** The focused control lies inside the window and is not covered. */
async function expectOnScreen(target: Locator) {
  await expect(target).toBeFocused();
  expect(await isOnScreen(target)).toBe(true);
}

for (const zoom of [
  { name: "200% zoom", viewport: { width: 640, height: 450 }, deviceScaleFactor: 2 },
  { name: "400% zoom", viewport: { width: 320, height: 225 }, deviceScaleFactor: 4 },
  { name: "320 px narrow pane", viewport: { width: 320, height: 700 }, deviceScaleFactor: 1 },
]) {
  test(`${zoom.name}: controls stay reachable and the keyboard journey works`, async ({
    browser,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "emulates its own viewport");
    test.setTimeout(120_000);
    const context = await browser.newContext({
      baseURL: testInfo.project.use.baseURL,
      viewport: zoom.viewport,
      deviceScaleFactor: zoom.deviceScaleFactor,
    });
    const page = await context.newPage();
    const short = zoom.viewport.height < 400;
    try {
      await withCanvas(page, async ({ canvasId, frame }) => {
        await openCanvas(page, canvasId);
        await watchFocus(page);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        expect(
          await page
            .locator(".design-workspace")
            .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
        ).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`${zoom.name}-idle.png`) });
        const toolbar = page.getByRole("toolbar", { name: "Design tools" });
        const more = toolbar.getByRole("button", { name: "More design tools" });
        if (short) {
          // One row of tools, not three: the panels keep the height.
          await expect(more).toBeVisible();
          await expect(toolbar.getByRole("button", { name: "Zoom in" })).toHaveCount(0);
          expect((await toolbar.boundingBox())!.height).toBeLessThan(zoom.viewport.height / 4);
        } else await expect(more).toHaveCount(0);
        const idle = await unreachableControls(page);
        await testInfo.attach(`${zoom.name}-idle.json`, { body: JSON.stringify(idle, null, 2) });
        expect(idle.reached).toBeGreaterThan(short ? 10 : 15);
        expect(idle.problems).toEqual([]);

        // Select, edit and close the inspector by keyboard at this zoom.
        await selectHeadingByKeyboard(page);
        const inspector = inspectorOf(page);
        const inspectorBox = (await inspector.boundingBox())!;
        expect(inspectorBox.x).toBeGreaterThanOrEqual(0);
        expect(inspectorBox.x + inspectorBox.width).toBeLessThanOrEqual(zoom.viewport.width + 1);
        await page.screenshot({ path: testInfo.outputPath(`${zoom.name}-inspector.png`) });
        const withInspector = await unreachableControls(page);
        await testInfo.attach(`${zoom.name}-inspector.json`, {
          body: JSON.stringify(withInspector, null, 2),
        });
        expect(withInspector.problems).toEqual([]);
        const color = inspector.getByRole("textbox", { name: "Color", exact: true });
        await tabTo(page, color);
        await expectOnScreen(color);
        // Its visible label is in view with it, not scrolled or clipped away.
        expect(await isOnScreen(inspector.locator('[data-property="color"] label'))).toBe(true);
        await typeStyle(page, "rgb(0, 120, 0)");
        await expect.poll(async () => (await frame()).revision).toBe(2);
        await expectOnScreen(color);
        await tabTo(page, inspector.getByRole("button", { name: "Close inspector" }), "Shift+Tab");
        await page.keyboard.press("Enter");
        await expect(inspector).toBeHidden();
        await expectOnScreen(rovingRow(page));

        if (short) {
          // The overflow menu: zoom steps keep it open; an action, or a dialog
          // it opened, returns focus to the trigger.
          const zoomLabel = () =>
            page.getByRole("menuitem", { name: /^Zoom \d+%\. Reset to 100%$/ }).textContent();
          await tabTo(page, more, "Shift+Tab");
          await page.keyboard.press("Enter");
          const menu = page.getByRole("menu");
          await expect(menu).toBeVisible();
          const before = await zoomLabel();
          await arrowTo(page, menu.getByRole("menuitem", { name: "Zoom in" }));
          await expectOnScreen(menu.getByRole("menuitem", { name: "Zoom in" }));
          await page.keyboard.press("Enter");
          await expect(menu).toBeVisible();
          await expect.poll(zoomLabel).not.toBe(before);
          await page.keyboard.press("Escape");
          await expect(menu).toBeHidden();
          await expectSettledFocus(page, more);

          // Checkbox tools run after closing the menu, update their checked
          // state, and leave focus on the trigger for the next action.
          for (const [name, activeName] of [
            ["Preview mode", "Exit preview mode"],
            ["Design history", "Design history"],
          ]) {
            await page.keyboard.press("Enter");
            const item = menu.getByRole("menuitemcheckbox", { name, exact: true });
            await arrowTo(page, item);
            await expect(item).toHaveAttribute("aria-checked", "false");
            await page.keyboard.press("Enter");
            await expect(menu).toBeHidden();
            await expectSettledFocus(page, more);
            if (name === "Preview mode")
              await expect(
                page.getByRole("button", { name: "Exit preview", exact: true }),
              ).toBeVisible();
            else
              await expect(
                page.getByRole("complementary", { name: "Design history" }),
              ).toBeVisible();
            await page.keyboard.press("Enter");
            const active = menu.getByRole("menuitemcheckbox", { name: activeName, exact: true });
            await arrowTo(page, active);
            await expect(active).toHaveAttribute("aria-checked", "true");
            await page.keyboard.press("Enter");
            await expect(menu).toBeHidden();
            await expectSettledFocus(page, more);
            if (name === "Preview mode")
              await expect(
                page.getByRole("button", { name: "Exit preview", exact: true }),
              ).toBeHidden();
            else
              await expect(
                page.getByRole("complementary", { name: "Design history" }),
              ).toBeHidden();
            await page.keyboard.press("Enter");
            await arrowTo(page, menu.getByRole("menuitemcheckbox", { name, exact: true }));
            await expect(menu.getByRole("menuitemcheckbox", { name, exact: true })).toHaveAttribute(
              "aria-checked",
              "false",
            );
            await page.keyboard.press("Escape");
            await expectSettledFocus(page, more);
          }

          await page.keyboard.press("Enter");
          const exportItem = menu.getByRole("menuitem", { name: "Export design to repository" });
          await arrowTo(page, exportItem);
          await expectOnScreen(exportItem);
          await page.keyboard.press("Enter");
          const dialog = page.getByRole("dialog", { name: "Export design to repository" });
          await expect(dialog).toBeVisible();
          await expect(dialog.getByRole("combobox", { name: "Folder" })).toBeFocused();
          await page.keyboard.press("Escape");
          await expect(dialog).toBeHidden();
          await expectSettledFocus(page, more);
        }
        await expectFocusNeverLost(page);
      });
    } finally {
      await context.close();
    }
  });
}
