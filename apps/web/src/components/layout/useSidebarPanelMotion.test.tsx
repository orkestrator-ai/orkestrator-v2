import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { SIDEBAR_WIDTH_TRANSITION_MS, type SidebarPanelMode } from "@/lib/sidebar-width";
import { uiStore } from "@/stores/uiStore";
import { useUIChromeStore } from "@/stores/uiChromeStore";
import { useSidebarPanelMotion } from "./useSidebarPanelMotion";
import { appCommandStore } from "@/test/app-command-store";

const initialUI = appCommandStore(uiStore).getState();

type Motion = ReturnType<typeof useSidebarPanelMotion>;

function element(width: number, parent?: HTMLElement): HTMLElement {
  const node = document.createElement("div");
  node.getBoundingClientRect = () => ({ width }) as DOMRect;
  parent?.appendChild(node);
  return node;
}

let motion: Motion;
let panelWidth = 0;
let panelSizeError: Error | null = null;
let resizeError: Error | null = null;
const resize = mock((_size: string | number) => {});

function report(result: Motion) {
  motion = result;
}

function Harness(props: {
  mode: SidebarPanelMode;
  reducedMotion?: boolean;
  sidebar: HTMLElement | null;
  main: HTMLElement | null;
}) {
  const result = useSidebarPanelMotion({
    mode: props.mode,
    reducedMotion: props.reducedMotion ?? false,
    sidebarElement: props.sidebar,
    mainElement: props.main,
  });
  const { panelRef } = result;
  useLayoutEffect(() => {
    report(result);
  });
  // Before the hook's own effect runs on a later render, as a registered panel is.
  useLayoutEffect(() => {
    panelRef.current = {
      getSize: () => {
        if (panelSizeError) throw panelSizeError;
        return { inPixels: panelWidth, asPercentage: 0 };
      },
      resize: (size) => {
        if (resizeError) throw resizeError;
        resize(size);
      },
      collapse: () => {},
      expand: () => {},
      isCollapsed: () => false,
    };
  }, [panelRef]);
  return null;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SIDEBAR_WIDTH_TRANSITION_MS + 80));
  });
}

async function nextFrame() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  });
}

beforeEach(() => {
  panelWidth = 344;
  panelSizeError = null;
  resizeError = null;
  resize.mockClear();
  useUIChromeStore.setState({ sidebarWidth: 280 });
});

afterEach(() => {
  cleanup();
  appCommandStore(uiStore).setState(initialUI, true);
});

describe("animating a width change", () => {
  test("holds content at the larger width for the transition, then releases it once", async () => {
    const resizes = mock(() => {});
    window.addEventListener("resize", resizes);
    const group = document.createElement("div");
    const props = { sidebar: element(344, group), main: element(900) };
    const { rerender } = render(<Harness mode="full" {...props} />);
    expect(motion.animating).toBe(false);

    rerender(<Harness mode="compact" {...props} />);
    expect(motion.animating).toBe(true);
    expect(motion.pins).toEqual({ sidebar: 344, main: 900 + 344 - 56 });
    expect(resizes).not.toHaveBeenCalled();

    await settle();
    window.removeEventListener("resize", resizes);
    expect(motion.animating).toBe(false);
    expect(motion.pins).toBeNull();
    // Native previews follow their host only on a resize.
    expect(resizes).toHaveBeenCalledTimes(1);
  });

  test("the release's resize waits a frame, so a terminal's two fits become one", async () => {
    const resizes = mock(() => {});
    window.addEventListener("resize", resizes);
    const originalFrame = globalThis.requestAnimationFrame;
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (callback) => frames.push(callback);
    try {
      const props = { sidebar: element(344), main: element(900) };
      const { rerender } = render(<Harness mode="full" {...props} />);
      rerender(<Harness mode="compact" {...props} />);
      await settle();
      expect(motion.pins).toBeNull();
      expect(resizes).not.toHaveBeenCalled();
      for (const frame of frames.splice(0)) frame(0);
      expect(resizes).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.requestAnimationFrame = originalFrame;
      window.removeEventListener("resize", resizes);
    }
  });

  test("is off under reduced motion", () => {
    const props = { sidebar: element(344), main: element(900) };
    const { rerender } = render(<Harness mode="full" reducedMotion {...props} />);
    rerender(<Harness mode="compact" reducedMotion {...props} />);
    expect(motion.animating).toBe(false);
    expect(motion.pins).toBeNull();
  });

  test("is off while a resize handle is held", () => {
    const group = document.createElement("div");
    const handle = document.createElement("div");
    handle.setAttribute("data-separator", "active");
    group.appendChild(handle);
    const props = { sidebar: element(344, group), main: element(900) };
    const { rerender } = render(<Harness mode="full" {...props} />);
    rerender(<Harness mode="compact" {...props} />);
    expect(motion.animating).toBe(false);
  });

  test("grabbing a handle mid-animation ends it at once", () => {
    const props = { sidebar: element(344), main: element(900) };
    const { rerender } = render(<Harness mode="full" {...props} />);
    rerender(<Harness mode="compact" {...props} />);
    expect(motion.animating).toBe(true);
    act(() => motion.settleNow());
    expect(motion.animating).toBe(false);
  });

  test("a change mid-animation starts over without a second release", async () => {
    const resizes = mock(() => {});
    window.addEventListener("resize", resizes);
    const props = { sidebar: element(200), main: element(900) };
    const { rerender } = render(<Harness mode="full" {...props} />);
    rerender(<Harness mode="compact" {...props} />);
    rerender(<Harness mode="hidden" {...props} />);
    expect(motion.pins).toEqual({ sidebar: 200, main: 1100 });
    await settle();
    window.removeEventListener("resize", resizes);
    expect(resizes).toHaveBeenCalledTimes(1);
  });
});

test("reversal measures the panel, not the pinned content", () => {
  const parent = element(900);
  const main = element(900, parent);
  const sidebar = element(344);
  const { rerender } = render(<Harness mode="full" sidebar={sidebar} main={main} />);
  rerender(<Harness mode="compact" sidebar={sidebar} main={main} />);
  main.getBoundingClientRect = () => ({ width: 1188 }) as DOMRect;
  parent.getBoundingClientRect = () => ({ width: 1100 }) as DOMRect;
  sidebar.getBoundingClientRect = () => ({ width: 144 }) as DOMRect;
  rerender(<Harness mode="full" sidebar={sidebar} main={main} />);
  expect(motion.pins).toEqual({ sidebar: 344, main: 1100 });
});

describe("the resize handle a hidden sidebar does not have", () => {
  function group() {
    const parent = document.createElement("div");
    const sidebar = element(344, parent);
    element(1, parent).setAttribute("data-separator", "");
    return { sidebar, main: element(900) };
  }

  test("hiding holds the column at the width it gets once the handle has gone", () => {
    const props = group();
    const { rerender } = render(<Harness mode="full" {...props} />);
    rerender(<Harness mode="hidden" {...props} />);
    expect(motion.pins).toEqual({ sidebar: 344, main: 900 + 344 + 1 });
  });

  test("showing holds the column at the width it had before the handle mounted", () => {
    const props = { ...group(), sidebar: element(0, group().sidebar.parentElement!) };
    props.sidebar.parentElement!.append(props.sidebar, element(1));
    props.sidebar.nextElementSibling!.setAttribute("data-separator", "");
    const { rerender } = render(<Harness mode="hidden" {...props} />);
    rerender(<Harness mode="full" {...props} />);
    expect(motion.pins).toEqual({ sidebar: 280, main: 900 + 1 });
  });

  test("a change that keeps the handle holds no extra width", () => {
    const props = group();
    const { rerender } = render(<Harness mode="full" {...props} />);
    rerender(<Harness mode="compact" {...props} />);
    expect(motion.pins).toEqual({ sidebar: 344, main: 900 + 344 - 56 });
  });
});

describe("the sidebar's content", () => {
  test("stays until a hidden panel has finished closing", async () => {
    const props = { sidebar: element(344), main: element(900) };
    const { rerender } = render(<Harness mode="full" {...props} />);
    rerender(<Harness mode="hidden" {...props} />);
    expect(motion.contentShown).toBe(true);
    await settle();
    expect(motion.contentShown).toBe(false);
  });

  test("goes at once without an animation, and returns at once", () => {
    const props = { sidebar: element(344), main: element(900) };
    const { rerender } = render(<Harness mode="full" reducedMotion {...props} />);
    rerender(<Harness mode="hidden" reducedMotion {...props} />);
    expect(motion.contentShown).toBe(false);
    rerender(<Harness mode="full" reducedMotion {...props} />);
    expect(motion.contentShown).toBe(true);
  });

  test("starts absent on a sidebar stored as hidden", () => {
    render(<Harness mode="hidden" sidebar={element(0)} main={element(900)} />);
    expect(motion.contentShown).toBe(false);
  });
});

describe("restoring the width", () => {
  test("leaving compact returns to the width the user had", async () => {
    const props = { sidebar: element(344), main: element(900) };
    const { rerender } = render(<Harness mode="full" {...props} />);
    rerender(<Harness mode="compact" {...props} />);
    expect(useUIChromeStore.getState().sidebarWidth).toBe(344);
    await settle();

    panelWidth = 56;
    rerender(<Harness mode="full" {...props} />);
    await nextFrame();
    expect(resize).toHaveBeenCalledWith("344px");
    expect(useUIChromeStore.getState().sidebarWidth).toBe(344);
  });

  test("a sidebar reloaded in compact returns to the stored width", async () => {
    useUIChromeStore.setState({ sidebarWidth: 312 });
    panelWidth = 56;
    const props = { sidebar: element(56), main: element(900) };
    const { rerender } = render(<Harness mode="compact" {...props} />);
    rerender(<Harness mode="full" {...props} />);
    await nextFrame();
    expect(resize).toHaveBeenCalledWith("312px");
  });

  test("hiding and showing also keep it", async () => {
    const props = { sidebar: element(344), main: element(900) };
    const { rerender } = render(<Harness mode="full" {...props} />);
    rerender(<Harness mode="hidden" {...props} />);
    panelWidth = 0;
    rerender(<Harness mode="full" {...props} />);
    await nextFrame();
    expect(resize).toHaveBeenCalledWith("344px");
  });

  test("a panel not yet registered with its group keeps the remembered width", async () => {
    useUIChromeStore.setState({ sidebarWidth: 312 });
    panelWidth = Number.NaN;
    const props = { sidebar: element(344), main: element(900) };
    const { rerender } = render(<Harness mode="full" {...props} />);
    // The library throws until the group has registered the panel.
    panelSizeError = new Error("Group not found");
    resizeError = new Error("Group not found");
    rerender(<Harness mode="compact" {...props} />);
    expect(useUIChromeStore.getState().sidebarWidth).toBe(312);
    rerender(<Harness mode="full" {...props} />);
    await nextFrame();
    expect(motion.contentShown).toBe(true);
  });

  test("moving between compact and hidden leaves the remembered width alone", () => {
    useUIChromeStore.setState({ sidebarWidth: 312 });
    panelWidth = 56;
    const props = { sidebar: element(56), main: element(900) };
    const { rerender } = render(<Harness mode="compact" {...props} />);
    rerender(<Harness mode="hidden" {...props} />);
    expect(useUIChromeStore.getState().sidebarWidth).toBe(312);
    expect(resize).not.toHaveBeenCalled();
  });
});

for (const destination of ["compact", "hidden"] as const) {
  test(`repeated full/${destination} reversals preserve the settled width`, () => {
    const props = { sidebar: element(344), main: element(900) };
    const { rerender } = render(<Harness mode="full" {...props} />);
    rerender(<Harness mode={destination} {...props} />);
    rerender(<Harness mode="full" {...props} />);
    panelWidth = 300;
    rerender(<Harness mode={destination} {...props} />);
    expect(useUIChromeStore.getState().sidebarWidth).toBe(344);
  });
}
