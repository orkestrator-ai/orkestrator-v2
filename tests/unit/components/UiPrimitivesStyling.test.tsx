import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../../../apps/web/src/components/ui/resizable";

describe("styled UI primitives", () => {
  afterEach(() => cleanup());

  test("ContextMenu source keeps the dark popup treatment", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../../apps/web/src/components/ui/context-menu.tsx"),
      "utf8",
    );

    expect(source).toContain("rounded-xl border border-zinc-700/70 bg-zinc-900/95");
    expect(source).toContain("focus:bg-zinc-800/80 focus:text-foreground");
    expect(source).toContain("bg-zinc-700/60");
  });

  test("DropdownMenu source keeps the dark popup treatment", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../../apps/web/src/components/ui/dropdown-menu.tsx"),
      "utf8",
    );

    expect(source).toContain("rounded-xl border border-zinc-700/70 bg-zinc-900/95");
    expect(source).toContain("focus:bg-zinc-800/80 focus:text-foreground");
    expect(source).toContain("bg-zinc-700/60");
  });

  test("Select source keeps the dark popup treatment", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../../apps/web/src/components/ui/select.tsx"),
      "utf8",
    );

    expect(source).toContain("rounded-xl border border-zinc-700/70 bg-zinc-900/95");
    expect(source).toContain("focus:bg-zinc-800/80 focus:text-foreground");
    expect(source).toContain("bg-zinc-700/60");
  });

  test("ResizableHandle renders a 1px divider with orientation-specific classes", () => {
    const { container } = render(
      <ResizablePanelGroup direction="horizontal">
        <ResizablePanel defaultSize={50}>Left</ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize={50}>Right</ResizablePanel>
      </ResizablePanelGroup>,
    );

    const handle = container.querySelector('[data-slot="resizable-handle"]') as HTMLElement;
    expect(handle.style.width).toBe("1px");
    expect(handle.style.height).toBe("100%");
    expect(handle.className).toContain("after:w-px");
    expect(handle.className).toContain("hover:after:bg-primary/50");
  });
});
