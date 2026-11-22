import type { AppImageUpdater } from "electron-updater";

export function createAppImageUpdater(Updater: typeof AppImageUpdater) {
  return new (class extends Updater {
    installForRestart(currentImage: string, quitForUpdate: (image: string) => void): boolean {
      let image = currentImage;
      const onFilename = (destination: string) => {
        image = destination;
      };
      let installed = false;
      this.on("appimage-filename-updated", onFilename);
      try {
        // The pinned updater applies the image with APPIMAGE_EXIT_AFTER_INSTALL
        // when force-run is false. It emits the destination if the name changed.
        installed = this.install(true, false);
      } finally {
        this.removeListener("appimage-filename-updated", onFilename);
        // Match quitAndInstall's retry behaviour when an explicit install fails.
        // On success the flag suppresses the library's install-on-quit.
        if (!installed) this.quitAndInstallCalled = false;
      }
      if (installed) quitForUpdate(image);
      return installed;
    }
  })();
}
