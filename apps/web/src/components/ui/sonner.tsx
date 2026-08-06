import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { useEffect, useRef } from "react"
import { Toaster as Sonner, toast, type ToasterProps, type ToastT } from "sonner"

import { cn } from "@/lib/utils"

const DEFAULT_POSITION = "bottom-right"

function getClickedToastId(
  toastElement: HTMLElement,
  toasterId: string | undefined,
  defaultPosition: NonNullable<ToasterProps["position"]>,
): ToastT["id"] | undefined {
  const index = Number(toastElement.dataset.index)
  const { xPosition, yPosition } = toastElement.dataset

  if (!Number.isSafeInteger(index) || index < 0 || !xPosition || !yPosition) {
    return undefined
  }

  const position = `${yPosition}-${xPosition}`
  const matchingToasts = toast
    .getToasts()
    .filter((item): item is ToastT => !("dismiss" in item))
    .filter((item) => (toasterId ? item.toasterId === toasterId : !item.toasterId))
    .filter((item) => (item.position ?? defaultPosition) === position)
    .reverse()

  return matchingToasts[index]?.id
}

const Toaster = ({ ...props }: ToasterProps) => {
  const toasterRef = useRef<HTMLElement>(null)
  const defaultPosition = props.position ?? DEFAULT_POSITION

  useEffect(() => {
    const toaster = toasterRef.current
    if (!toaster) return

    const dismissClickedToast = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return

      const toastElement = event.target.closest<HTMLElement>("[data-sonner-toast]")
      if (!toastElement || !toaster.contains(toastElement)) return

      const toastId = getClickedToastId(toastElement, props.id, defaultPosition)
      if (toastId !== undefined) toast.dismiss(toastId)
    }

    // Capture the click so custom toast content cannot accidentally prevent the
    // tap-to-dismiss behavior. Nested actions still receive and handle the click.
    toaster.addEventListener("click", dismissClickedToast, true)
    return () => toaster.removeEventListener("click", dismissClickedToast, true)
  }, [defaultPosition, props.id])

  return (
    <Sonner
      ref={toasterRef}
      theme="dark"
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--color-popover)",
          "--normal-text": "var(--color-popover-foreground)",
          "--normal-border": "var(--color-border)",
          "--border-radius": "var(--radius-md)",
        } as React.CSSProperties
      }
      {...props}
      toastOptions={{
        ...props.toastOptions,
        className: cn("cursor-pointer", props.toastOptions?.className),
      }}
    />
  )
}

export { Toaster }
