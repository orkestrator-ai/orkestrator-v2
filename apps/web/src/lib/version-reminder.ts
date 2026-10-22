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

/** The reminder for a mismatch, or null when the versions match. */
export function describeVersionReminder({
  skew,
  clientVersion,
  backendVersion,
  clientKind,
  hostCanUpdate = false,
}: {
  skew: AppVersionSkew;
  clientVersion: string;
  backendVersion: string;
  clientKind: VersionClientKind;
  /** The backend's host reports an updater that can install an update now. */
  hostCanUpdate?: boolean;
}): VersionReminder | null {
  if (skew === "same") return null;
  if (clientKind === "backend-served") {
    return {
      title: "Orkestrator has been updated",
      description: `This page is Orkestrator ${clientVersion}, but the server now runs ${backendVersion}. Reload to use the matching version.`,
      action: "reload",
    };
  }
  if (skew === "backend-older") {
    return {
      title: "The Orkestrator backend is out of date",
      description: hostCanUpdate
        ? `The backend you're connected to runs Orkestrator ${backendVersion}, older than this app (${clientVersion}). Update it from here; until then some views may not display correctly.`
        : `The backend you're connected to runs Orkestrator ${backendVersion}, older than this app (${clientVersion}). Update Orkestrator on the computer running the backend; until then some views may not display correctly.`,
      action: hostCanUpdate ? "update" : null,
    };
  }
  if (skew === "client-older") {
    return clientKind === "hosted"
      ? {
          title: "This web app is out of date",
          description: `This web app is Orkestrator ${clientVersion}, but the backend runs ${backendVersion}. Reload to get the latest web app.`,
          action: "reload",
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
