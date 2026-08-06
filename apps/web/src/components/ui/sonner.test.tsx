import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, mock, test } from "bun:test"

import { mockToastDismiss } from "../../../../../tests/mocks/sonner"
import * as realSonner from "../../../node_modules/sonner"
import { Toaster } from "./sonner"

const createdToastIds = new Set<string>()

function showToast(id: string, message: string, options: realSonner.ExternalToast = {}) {
  createdToastIds.add(id)
  act(() => {
    realSonner.toast(message, { ...options, id, duration: Infinity })
  })
}

describe("Toaster", () => {
  afterEach(() => {
    for (const id of createdToastIds) realSonner.toast.dismiss(id)
    createdToastIds.clear()
    cleanup()
  })

  test("dismisses the specific toast that is clicked", async () => {
    render(<Toaster />)
    showToast("older-toast", "Older message")
    showToast("newer-toast", "Newer message")

    const olderMessage = await screen.findByText("Older message")
    fireEvent.click(olderMessage)

    expect(mockToastDismiss).toHaveBeenCalledWith("older-toast")
    expect(mockToastDismiss).not.toHaveBeenCalledWith("newer-toast")
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

    const retry = await screen.findByRole("button", { name: "Retry" })
    fireEvent.click(retry)

    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1))
    expect(mockToastDismiss).toHaveBeenCalledWith("action-toast")
  })

  test("preserves caller toast classes while marking toasts as clickable", async () => {
    render(<Toaster toastOptions={{ className: "custom-toast" }} />)
    showToast("styled-toast", "Styled message")

    const toastElement = (await screen.findByText("Styled message")).closest(
      "[data-sonner-toast]",
    )

    expect(toastElement?.classList.contains("cursor-pointer")).toBe(true)
    expect(toastElement?.classList.contains("custom-toast")).toBe(true)
  })
})
