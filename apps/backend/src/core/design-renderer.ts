import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright-core";
import { designBootstrap } from "@orkestrator/protocol/design-runtime";
import type { DesignFrame, DesignOperation } from "@orkestrator/protocol/design-canvas";

const SYSTEM_CHROMIUM_PATHS = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

export function resolveDesignChromiumPath(
  env: NodeJS.ProcessEnv = process.env,
  candidates: readonly string[] = SYSTEM_CHROMIUM_PATHS,
): string | undefined {
  const configured = env.ORKESTRATOR_DESIGN_CHROMIUM_PATH?.trim();
  if (configured) return existsSync(configured) ? configured : undefined;
  const managed = env.PLAYWRIGHT_BROWSERS_PATH ? chromium.executablePath() : undefined;
  return [managed, chromium.executablePath(), ...candidates].find(
    (candidate): candidate is string => Boolean(candidate && existsSync(candidate)),
  );
}

/** Backend DOM operations never depend on a mounted client's iframe. */
export class DesignRenderer {
  private browser: Promise<Browser> | undefined;
  private pending = 0;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly launchBrowser: typeof chromium.launch = chromium.launch.bind(chromium),
    private readonly executablePath: () => string | undefined = resolveDesignChromiumPath,
  ) {}
  status(): { ready: boolean; error?: string } {
    if (this.executablePath()) return { ready: true };
    return {
      ready: false,
      error:
        "Design workspaces require Chromium. Install Chromium or set ORKESTRATOR_DESIGN_CHROMIUM_PATH to its executable.",
    };
  }
  async run(
    frame: Pick<DesignFrame, "html" | "width" | "height">,
    operation: DesignOperation | { op: "capture" },
  ): Promise<unknown> {
    if (this.pending >= 16) throw new Error("Design renderer busy; retry later");
    this.pending++;
    const work = this.tail.then(async () => {
      this.browser ??= this.launchBrowser({
        headless: true,
        timeout: 15_000,
        executablePath: this.executablePath(),
      })
        .then((browser) => {
          browser.once("disconnected", () => {
            this.browser = undefined;
          });
          return browser;
        })
        .catch(() => {
          this.browser = undefined;
          throw new Error(
            "Design renderer needs Chromium. Set ORKESTRATOR_DESIGN_CHROMIUM_PATH to a Chromium executable.",
          );
        });
      const browser = await this.browser;
      const context = await browser.newContext({
        viewport: { width: Math.round(frame.width), height: Math.round(frame.height) },
        serviceWorkers: "block",
        acceptDownloads: false,
      });
      const deadline = setTimeout(() => {
        void context.close().catch(() => undefined);
      }, 15_000);
      try {
        // Designs are self-contained. No credentialed, local-network or file reads.
        await context.route("**/*", (route) => route.abort());
        const page = await context.newPage();
        page.setDefaultTimeout(10_000);
        await page.setContent(designBootstrap(randomUUID()), { waitUntil: "load" });
        const run = (op: DesignOperation) =>
          page.evaluate(
            (input) =>
              (window as unknown as { orkDesign: (input: DesignOperation) => unknown }).orkDesign(
                input,
              ),
            op,
          );
        await run({ op: "render", html: frame.html });
        if (operation.op === "capture") {
          const png = await page.screenshot({
            type: "png",
            timeout: 10_000,
            animations: "disabled",
          });
          if (png.byteLength > 8 * 1024 * 1024) throw new Error("Capture exceeds 8 MiB");
          return { mimeType: "image/png", data: png.toString("base64") };
        }
        return await run(operation);
      } finally {
        clearTimeout(deadline);
        await context.close().catch(() => undefined);
      }
    });
    this.tail = work.catch(() => undefined);
    try {
      return await work;
    } finally {
      this.pending--;
    }
  }
  async close() {
    await this.tail;
    const browser = this.browser;
    this.browser = undefined;
    await browser?.then((value) => value.close()).catch(() => undefined);
  }
}
