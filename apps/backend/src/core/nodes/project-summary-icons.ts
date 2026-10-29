/** Inline raster data URLs are ASCII, so their lengths equal their byte counts. */
export const MAX_SUMMARY_ICON_BYTES = 256 * 1024;

/** Keep optional icons within one node's budget, in project order. Never mutate storage. */
export function boundSummaryIcons<T extends { icon?: string | null }>(projects: T[]): T[] {
  let remaining = MAX_SUMMARY_ICON_BYTES;
  return projects.map((project) => {
    if (!project.icon) return project;
    if (project.icon.length <= remaining) {
      remaining -= project.icon.length;
      return project;
    }
    const { icon: _icon, ...rest } = project;
    return rest as T;
  });
}
