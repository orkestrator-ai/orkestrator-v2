/** Ask for attention without taking focus away from the user's current app. */
export function createDialogAttention(options: {
  platform: NodeJS.Platform;
  agentTest: boolean;
  productName: string;
  dock(): Pick<Electron.Dock, "bounce"> | undefined;
  Notification: Pick<typeof Electron.Notification, "isSupported"> & {
    new (options: Electron.NotificationConstructorOptions): DialogNotification;
  };
}): (window: AttentionWindow, message: string) => void {
  // Keep notifications alive so a click can restore their window even after
  // the dialog's caller has moved on. Closing or clicking releases the owner.
  const notifications = new Set<DialogNotification>();
  return (window, message) => {
    if (window.isFocused() || options.agentTest) return;
    if (options.platform === "darwin") options.dock()?.bounce("informational");
    if (!options.Notification.isSupported()) return;
    const notification = new options.Notification({ title: options.productName, body: message });
    notifications.add(notification);
    notification.once("close", () => notifications.delete(notification));
    notification.once("click", () => {
      notifications.delete(notification);
      if (window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    });
    notification.show();
  };
}

type DialogNotification = {
  once(event: "close" | "click", listener: () => void): unknown;
  show(): void;
};

type AttentionWindow = Pick<
  Electron.BrowserWindow,
  "isFocused" | "isDestroyed" | "isMinimized" | "restore" | "show" | "focus"
>;
