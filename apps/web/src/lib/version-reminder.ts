import type { AppVersionSkew } from "@/lib/app-version";

/**
 * Where this renderer came from, which decides how a version mismatch is fixed.
 *
 * - `desktop`: the Electron app's bundled renderer, local or connected to a
 *   remote backend. Fixing a mismatch means updating one of the installs.
 * - `backend-served`: a browser tab or the iOS shell loaded from the backend's
 *   own gateway. The backend serves its matching renderer, so a reload fixes
 *   any mismatch (a tab left open across a backend upgrade or rollback).
 * - `hosted`: a renderer loaded from a separate host (orkestrator.dev) and
 *   pointed at a backend elsewhere.
 */
export type VersionClientKind = "desktop" | "backend-served" | "hosted";

type ClientWindow = Pick<Window, "orkestrator" | "orkestratorGateway">;

export function versionClientKind(target: ClientWindow = window): VersionClientKind {
  if (target.orkestrator?.isolatedViewState === true || target.orkestratorGateway?.desktop) {
    return "desktop";
  }
  return target.orkestratorGateway?.enabled && target.orkestratorGateway.baseUrl
    ? "hosted"
    : "backend-served";
}

export interface VersionReminder {
  title: string;
  description: string;
  /**
   * `reload` when reloading the page loads a matching renderer; `update` when
   * the backend's host can be updated from here (Settings → Machines).
   */
  action: "reload" | "update" | null;
}

/**
 * The reminder for a mismatch, or null when the versions match.
 *
 * The wording names the side that is older, because that is the side that
 * needs updating. Versions decide only this text, never behaviour.
 */
export function describeVersionReminder({
  skew,
  clientVersion,
  backendVersion,
  clientKind,
  hostCanUpdate = false,
  reloadTried = false,
}: {
  skew: AppVersionSkew;
  clientVersion: string;
  backendVersion: string;
  clientKind: VersionClientKind;
  /** The backend's host reports an updater that can install an update now. */
  hostCanUpdate?: boolean;
  /**
   * The user already reloaded for this exact pair and the page came back with
   * the same versions, so another reload cannot help (a renderer the server
   * does not bundle, such as a development or hosted one).
   */
  reloadTried?: boolean;
}): VersionReminder | null {
  if (skew === "same") return null;
  const olderBackendAction = hostCanUpdate ? ("update" as const) : null;
  if (clientKind === "backend-served") {
    if (skew === "backend-older") {
      return {
        title: "This server runs an older Orkestrator",
        description:
          `It runs Orkestrator ${backendVersion}, and this page is ${clientVersion}; some features are unavailable until the server is updated.` +
          (reloadTried ? "" : " Reload to load the server's own version."),
        action: reloadTried ? olderBackendAction : "reload",
      };
    }
    if (skew === "client-older") {
      return reloadTried
        ? {
            title: "Orkestrator versions differ",
            description: `This page is Orkestrator ${clientVersion}, but the server runs ${backendVersion}, and reloading did not load the matching version.`,
            action: null,
          }
        : {
            title: "Orkestrator has been updated",
            description: `This page is Orkestrator ${clientVersion}, but the server now runs ${backendVersion}. Reload to use the matching version.`,
            action: "reload",
          };
    }
    return {
      title: "Orkestrator versions differ",
      description:
        `This page is Orkestrator ${clientVersion}, but the server runs ${backendVersion}.` +
        (reloadTried ? "" : " Reload to use the server's version."),
      action: reloadTried ? null : "reload",
    };
  }
  if (skew === "backend-older") {
    return {
      title: "The Orkestrator backend is out of date",
      description: hostCanUpdate
        ? `The backend you're connected to runs an older Orkestrator (${backendVersion}) than this app (${clientVersion}); some features are unavailable until it is updated. Update it from here.`
        : `The backend you're connected to runs an older Orkestrator (${backendVersion}) than this app (${clientVersion}); some features are unavailable until it is updated. Update Orkestrator on the computer running the backend.`,
      action: olderBackendAction,
    };
  }
  if (skew === "client-older") {
    return clientKind === "hosted"
      ? {
          title: "This web app is out of date",
          description:
            `This web app is Orkestrator ${clientVersion}, but the backend runs ${backendVersion}.` +
            (reloadTried
              ? " Reloading did not load a newer web app; try again later."
              : " Reload to get the latest web app."),
          action: reloadTried ? null : "reload",
        }
      : {
          title: "Update Orkestrator",
          description: `This app is Orkestrator ${clientVersion}, but the backend runs ${backendVersion}. Update this app (Check for Updates… in the app menu) so the two match.`,
          action: null,
        };
  }
  return {
    title: "Orkestrator versions differ",
    description: `This app (${clientVersion}) and the backend (${backendVersion}) run different Orkestrator versions. Update the older one if something looks wrong.`,
    action: null,
  };
}
