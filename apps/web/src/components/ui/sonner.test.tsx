import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, mock, test } from "bun:test"
import type { CSSProperties } from "react"
import { toast as mockedToast, type ToastT, type ToastToDismiss } from "sonner"

import { mockToastDismiss } from "../../../../../tests/mocks/sonner"
import * as realSonner from "../../../node_modules/sonner"
import { Toaster } from "./sonner"

type ToastId = ToastT["id"]

const createdToastIds = new Set<ToastId>()

function showToast(id: ToastId, message: string, options: realSonner.ExternalToast = {}) {
  createdToastIds.add(id)
  act(() => {
    realSonner.toast.message(message, { ...options, id, duration: Infinity })
  })
}

function showTypedToast(
  type: "success" | "info" | "warning" | "error" | "loading",
  id: ToastId,
  message: string,
) {
  createdToastIds.add(id)
  act(() => {
    realSonner.toast[type](message, { id, duration: Infinity })
  })
}

async function getToastElement(message: string): Promise<HTMLElement> {
  const toastElement = (await screen.findByText(message)).closest<HTMLElement>(
    "[data-sonner-toast]",
  )
  if (!toastElement) throw new Error(`Toast element not found for ${message}`)
  return toastElement
}

function activeToastIds(): ToastId[] {
  return realSonner.toast
    .getToasts()
    .filter((toastItem): toastItem is ToastT => !("dismiss" in toastItem))
    .map((toastItem) => toastItem.id)
}

describe("Toaster", () => {
  afterEach(() => {
    mockToastDismiss.mockImplementation(() => undefined)
    mockedToast.getToasts = realSonner.toast.getToasts
    for (const id of createdToastIds) realSonner.toast.dismiss(id)
    createdToastIds.clear()
    cleanup()
  })

  test("dismisses the specific toast that is clicked", async () => {
    render(<Toaster />)
    showToast("older-toast", "Older message")
    showToast("newer-toast", "Newer message")

    fireEvent.click(await screen.findByText("Older message"))

    expect(mockToastDismiss).toHaveBeenCalledWith("older-toast")
    expect(mockToastDismiss).not.toHaveBeenCalledWith("newer-toast")
  })

  test("keeps toast identities stable across rapid exit-animation clicks", async () => {
    render(<Toaster />)
    showToast("oldest-toast", "Oldest message")
    showToast("middle-toast", "Middle message")
    showToast("newest-toast", "Newest message")
    await getToastElement("Oldest message")

    mockToastDismiss.mockImplementation((id) => {
      realSonner.toast.dismiss(id as ToastId)
    })
    fireEvent.click(await screen.findByText("Newest message"))
    fireEvent.click(await screen.findByText("Middle message"))

    expect(mockToastDismiss.mock.calls.map(([id]) => id)).toEqual([
      "newest-toast",
      "middle-toast",
    ])
    expect(activeToastIds()).toEqual(["oldest-toast"])
  })

  test("maps a new toast while an older toast is exiting", async () => {
    render(<Toaster />)
    showToast("old-toast", "Old message")
    showToast("exiting-toast", "Exiting message")
    await getToastElement("Old message")

    mockToastDismiss.mockImplementation((id) => {
      realSonner.toast.dismiss(id as ToastId)
    })
    fireEvent.click(await screen.findByText("Exiting message"))
    showToast("arriving-toast", "Arriving message")
    fireEvent.click(await screen.findByText("Arriving message"))

    expect(mockToastDismiss.mock.calls.map(([id]) => id)).toEqual([
      "exiting-toast",
      "arriving-toast",
    ])
    expect(activeToastIds()).toEqual(["old-toast"])
  })

  test("retains the clicked identity after a programmatic dismissal", async () => {
    render(<Toaster />)
    showToast("first-toast", "First message")
    showToast("second-toast", "Second message")
    showToast("third-toast", "Third message")
    await getToastElement("First message")
    const thirdToast = await getToastElement("Third message")

    act(() => {
      realSonner.toast.dismiss("third-toast")
    })
    await waitFor(() => expect(thirdToast.dataset.removed).toBe("true"))
    fireEvent.click(await screen.findByText("Second message"))

    expect(mockToastDismiss).toHaveBeenCalledWith("second-toast")
    expect(mockToastDismiss).not.toHaveBeenCalledWith("first-toast")
  })

  test("dismisses a persistent non-dismissible toast when it is clicked", async () => {
    render(<Toaster />)
    showToast("persistent-toast", "Persistent message", { dismissible: false })

    fireEvent.click(await screen.findByText("Persistent message"))

    expect(mockToastDismiss).toHaveBeenCalledWith("persistent-toast")
  })

  test("runs a toast action and still dismisses the toast", async () => {
    const onAction = mock(() => {})
    render(<Toaster />)
    showToast("action-toast", "Connection failed", {
      action: { label: "Retry", onClick: onAction },
    })

    fireEvent.click(await screen.findByRole("button", { name: "Retry" }))

    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1))
    expect(mockToastDismiss).toHaveBeenCalledWith("action-toast")
  })

  test("supports Enter and Space without hijacking nested controls", async () => {
    const onAction = mock(() => {})
    render(<Toaster />)
    showToast("enter-toast", "Enter message")
    showToast("space-toast", "Space message")
    showToast("keyboard-action-toast", "Action message", {
      action: { label: "Retry", onClick: onAction },
    })

    const enterToast = await getToastElement("Enter message")
    enterToast.focus()
    fireEvent.keyDown(enterToast, { key: "Enter" })

    const spaceToast = await getToastElement("Space message")
    spaceToast.focus()
    const spaceEventAccepted = fireEvent.keyDown(spaceToast, { key: " " })

    const retry = await screen.findByRole("button", { name: "Retry" })
    fireEvent.keyDown(retry, { key: "Enter" })
    fireEvent.keyDown(await getToastElement("Action message"), { key: "Enter", repeat: true })
    fireEvent.keyDown(await getToastElement("Action message"), { key: "Escape" })

    expect(spaceEventAccepted).toBe(false)
    expect(mockToastDismiss.mock.calls.map(([id]) => id)).toEqual([
      "enter-toast",
      "space-toast",
    ])
    expect(onAction).not.toHaveBeenCalled()
  })

  test("scopes identical stacks to their owning toaster IDs", async () => {
    render(
      <>
        <Toaster id="global" position="top-right" />
        <Toaster id="canvas" position="bottom-left" />
      </>,
    )
    showToast("global-old", "Global old", { toasterId: "global" })
    showToast("global-new", "Global new", { toasterId: "global" })
    showToast("canvas-old", "Canvas old", { toasterId: "canvas" })
    showToast("canvas-new", "Canvas new", { toasterId: "canvas" })

    fireEvent.click(await screen.findByText("Global old"))
    fireEvent.click(await screen.findByText("Canvas new"))

    expect(mockToastDismiss.mock.calls.map(([id]) => id)).toEqual([
      "global-old",
      "canvas-new",
    ])
  })

  test("maps both the toaster default and an explicit per-toast position", async () => {
    render(<Toaster position="top-left" />)
    showToast("default-position", "Default position")
    showToast("explicit-position", "Explicit position", { position: "bottom-right" })

    fireEvent.click(await screen.findByText("Default position"))
    fireEvent.click(await screen.findByText("Explicit position"))

    expect(mockToastDismiss.mock.calls.map(([id]) => id)).toEqual([
      "default-position",
      "explicit-position",
    ])
  })

  test("targets supported nonzero numeric IDs", async () => {
    render(<Toaster />)
    showToast(17, "Numeric message")

    fireEvent.click(await screen.findByText("Numeric message"))

    expect(mockToastDismiss).toHaveBeenCalledWith(17)
  })

  test("fails closed for ID zero instead of dismissing every toast", async () => {
    const { container } = render(<Toaster />)
    const toaster = container.querySelector<HTMLElement>("section[aria-live]")
    if (!toaster) throw new Error("Toaster was not rendered")

    mockedToast.getToasts = () => [
      { id: 18, title: "Other message" } as ToastT,
      { id: 0, title: "Zero message" } as ToastT,
    ]
    const zeroToast = document.createElement("li")
    zeroToast.dataset.sonnerToast = ""
    zeroToast.dataset.index = "0"
    zeroToast.dataset.xPosition = "right"
    zeroToast.dataset.yPosition = "bottom"
    const otherToast = document.createElement("li")
    otherToast.dataset.sonnerToast = ""
    otherToast.dataset.index = "1"
    otherToast.dataset.xPosition = "right"
    otherToast.dataset.yPosition = "bottom"
    toaster.append(zeroToast)
    toaster.append(otherToast)

    fireEvent.click(zeroToast)
    expect(mockToastDismiss).not.toHaveBeenCalled()

    fireEvent.click(otherToast)
    expect(mockToastDismiss).toHaveBeenCalledWith(18)
  })

  test("ignores dismissal commands and malformed or unmatched DOM nodes", async () => {
    const { container } = render(<Toaster />)
    const toaster = container.querySelector<HTMLElement>("section[aria-live]")
    if (!toaster) throw new Error("Toaster was not rendered")

    const originalGetToasts = mockedToast.getToasts
    mockedToast.getToasts = () => [
      { id: "already-dismissing", dismiss: true } satisfies ToastToDismiss,
    ]

    const invalidElements: Array<{ index?: string; x: string; y: string }> = [
      { x: "right", y: "bottom" },
      { index: "invalid", x: "right", y: "bottom" },
      { index: "-1", x: "right", y: "bottom" },
      { index: "0", x: "", y: "bottom" },
      { index: "0", x: "right", y: "" },
      { index: "999", x: "right", y: "bottom" },
    ]

    for (const { index, x, y } of invalidElements) {
      const element = document.createElement("li")
      element.dataset.sonnerToast = ""
      if (index !== undefined) element.dataset.index = index
      if (x) element.dataset.xPosition = x
      if (y) element.dataset.yPosition = y
      toaster.append(element)
      fireEvent.click(element)
    }
    fireEvent.click(toaster)
    fireEvent.keyDown(toaster, { key: "Enter" })

    expect(mockToastDismiss).not.toHaveBeenCalled()
    mockedToast.getToasts = originalGetToasts
  })

  test("rebinds once when position changes and removes listeners on unmount", async () => {
    const { rerender, unmount } = render(<Toaster position="bottom-right" />)
    rerender(<Toaster position="top-right" />)
    showToast("after-rerender", "After rerender")
    const afterRerender = await screen.findByText("After rerender")
    fireEvent.click(afterRerender)

    expect(mockToastDismiss).toHaveBeenCalledTimes(1)
    expect(mockToastDismiss).toHaveBeenCalledWith("after-rerender")

    const detachedToast = await getToastElement("After rerender")
    unmount()
    mockToastDismiss.mockClear()
    fireEvent.click(detachedToast)
    fireEvent.keyDown(detachedToast, { key: "Enter" })
    expect(mockToastDismiss).not.toHaveBeenCalled()
  })

  test("renders the default theme, icons, classes, and CSS variables", async () => {
    const { container } = render(<Toaster />)
    showTypedToast("success", "success-toast", "Success message")
    showTypedToast("info", "info-toast", "Info message")
    showTypedToast("warning", "warning-toast", "Warning message")
    showTypedToast("error", "error-toast", "Error message")
    showTypedToast("loading", "loading-toast", "Loading message")
    await screen.findByText("Loading message")

    const toaster = container.querySelector<HTMLElement>("[data-sonner-toaster]")
    expect(toaster?.dataset.sonnerTheme).toBe("dark")
    expect(toaster?.classList.contains("toaster")).toBe(true)
    expect(toaster?.classList.contains("group")).toBe(true)
    expect(toaster?.style.getPropertyValue("--normal-bg")).toBe("var(--color-popover)")
    expect(toaster?.style.getPropertyValue("--normal-text")).toBe(
      "var(--color-popover-foreground)",
    )
    expect(toaster?.style.getPropertyValue("--normal-border")).toBe("var(--color-border)")
    expect(toaster?.style.getPropertyValue("--border-radius")).toBe("var(--radius-md)")
    expect(container.querySelector(".lucide-circle-check")).not.toBeNull()
    expect(container.querySelector(".lucide-info")).not.toBeNull()
    expect(container.querySelector(".lucide-triangle-alert")).not.toBeNull()
    expect(container.querySelector(".lucide-octagon-x")).not.toBeNull()
    expect(container.querySelector(".lucide-loader-circle")).not.toBeNull()
  })

  test("forwards caller props and preserves all toast options", async () => {
    const style = { "--normal-bg": "pink" } as CSSProperties
    const { container } = render(
      <Toaster
        theme="light"
        className="caller-toaster"
        containerAriaLabel="Custom notifications"
        style={style}
        toastOptions={{
          className: "custom-toast",
          classNames: { title: "custom-title" },
          style: { color: "red" },
          closeButton: true,
        }}
      />,
    )
    showToast("styled-toast", "Styled message")

    const toastElement = await getToastElement("Styled message")
    const toaster = container.querySelector<HTMLElement>("[data-sonner-toaster]")
    expect(container.querySelector("section")?.getAttribute("aria-label")).toContain(
      "Custom notifications",
    )
    expect(toaster?.dataset.sonnerTheme).toBe("light")
    expect(toaster?.className).toContain("caller-toaster")
    expect(toaster?.style.getPropertyValue("--normal-bg")).toBe("pink")
    expect(toastElement.classList.contains("cursor-pointer")).toBe(true)
    expect(toastElement.classList.contains("custom-toast")).toBe(true)
    expect(toastElement.style.color).toBe("red")
    expect(toastElement.querySelector(".custom-title")).not.toBeNull()
    expect(toastElement.querySelector("[data-close-button]")).not.toBeNull()
  })
})
