import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useRef } from "react";
import {
  Toaster as Sonner,
  toast,
  type ToasterProps,
  type ToastT,
  type ToastToDismiss,
} from "sonner";

import { cn } from "@/lib/utils";

const DEFAULT_POSITION = "bottom-right";
const TOAST_SELECTOR = "[data-sonner-toast]";

type ToastId = ToastT["id"];

function isToast(toastItem: ToastT | ToastToDismiss): toastItem is ToastT {
  return !("dismiss" in toastItem);
}

function belongsToToaster(toastItem: ToastT, toasterId: string | undefined): boolean {
  return toasterId ? toastItem.toasterId === toasterId : !toastItem.toasterId;
}

function getToastElementPosition(toastElement: HTMLElement): string | undefined {
  const index = Number(toastElement.dataset.index);
  const { xPosition, yPosition } = toastElement.dataset;

  if (!Number.isSafeInteger(index) || index < 0 || !xPosition || !yPosition) {
    return undefined;
  }

  return `${yPosition}-${xPosition}`;
}

function associateRenderedToasts(
  toaster: HTMLElement,
  toasterId: string | undefined,
  defaultPosition: NonNullable<ToasterProps["position"]>,
  toastIdsByElement: WeakMap<HTMLElement, ToastId>,
): void {
  const elementsByPosition = new Map<string, HTMLElement[]>();

  for (const toastElement of toaster.querySelectorAll<HTMLElement>(TOAST_SELECTOR)) {
    const position = getToastElementPosition(toastElement);
    if (!position) continue;

    const elements = elementsByPosition.get(position) ?? [];
    elements.push(toastElement);
    elementsByPosition.set(position, elements);
  }

  const toastIdsByPosition = new Map<string, ToastId[]>();
  const activeToasts = toast
    .getToasts()
    .filter(isToast)
    .filter((toastItem) => belongsToToaster(toastItem, toasterId))
    .reverse();

  for (const toastItem of activeToasts) {
    const position = toastItem.position ?? defaultPosition;
    const toastIds = toastIdsByPosition.get(position) ?? [];
    toastIds.push(toastItem.id);
    toastIdsByPosition.set(position, toastIds);
  }

  for (const [position, elements] of elementsByPosition) {
    elements.sort((left, right) => Number(left.dataset.index) - Number(right.dataset.index));

    const alreadyAssociatedIds = new Set(
      elements
        .map((toastElement) => toastIdsByElement.get(toastElement))
        .filter((toastId): toastId is ToastId => toastId !== undefined),
    );
    const unassociatedIds = (toastIdsByPosition.get(position) ?? []).filter(
      (toastId) => !alreadyAssociatedIds.has(toastId),
    );
    const unassociatedElements = elements.filter(
      (toastElement) =>
        toastElement.dataset.removed !== "true" && !toastIdsByElement.has(toastElement),
    );

    // ToastState is updated synchronously while Sonner renders subscriber
    // updates on timers. Wait until this position's DOM has caught up rather
    // than attaching a newer store ID to an older element from a partial render.
    if (unassociatedElements.length !== unassociatedIds.length) continue;

    for (const [index, toastElement] of unassociatedElements.entries()) {
      const toastId = unassociatedIds[index];
      if (toastId !== undefined) toastIdsByElement.set(toastElement, toastId);
    }
  }
}

const Toaster = ({ ...props }: ToasterProps) => {
  const toasterRef = useRef<HTMLElement>(null);
  const toastIdsByElement = useRef(new WeakMap<HTMLElement, ToastId>());
  const defaultPosition = props.position ?? DEFAULT_POSITION;

  useEffect(() => {
    const toaster = toasterRef.current;
    if (!toaster) return;

    const synchronizeToastIds = () => {
      associateRenderedToasts(toaster, props.id, defaultPosition, toastIdsByElement.current);
    };

    const dismissToastElement = (toastElement: HTMLElement) => {
      synchronizeToastIds();
      const toastId = toastIdsByElement.current.get(toastElement);

      // Sonner 2.0.7 treats dismiss(0) as dismiss-all. Until that upstream API
      // can target zero safely, leave this one toast in place instead of
      // removing every notification.
      if (toastId === undefined || toastId === 0) return;
      toast.dismiss(toastId);
    };

    const dismissClickedToast = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;

      const toastElement = event.target.closest<HTMLElement>(TOAST_SELECTOR);
      if (!toastElement || !toaster.contains(toastElement)) return;

      dismissToastElement(toastElement);
    };

    const dismissToastWithKeyboard = (event: KeyboardEvent) => {
      if (event.repeat || (event.key !== "Enter" && event.key !== " ")) return;
      if (!(event.target instanceof HTMLElement) || !event.target.matches(TOAST_SELECTOR)) return;
      if (!toaster.contains(event.target)) return;

      event.preventDefault();
      dismissToastElement(event.target);
    };

    // Capture the click so custom toast content cannot accidentally prevent the
    // tap-to-dismiss behavior. Nested actions still receive and handle the click.
    synchronizeToastIds();
    const observer = new MutationObserver(synchronizeToastIds);
    observer.observe(toaster, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-index", "data-x-position", "data-y-position", "data-removed"],
    });
    toaster.addEventListener("click", dismissClickedToast, true);
    toaster.addEventListener("keydown", dismissToastWithKeyboard, true);
    return () => {
      observer.disconnect();
      toaster.removeEventListener("click", dismissClickedToast, true);
      toaster.removeEventListener("keydown", dismissToastWithKeyboard, true);
    };
  }, [defaultPosition, props.id]);

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
  );
};

export { Toaster };
