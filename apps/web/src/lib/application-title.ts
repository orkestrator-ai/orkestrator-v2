export function getApplicationTitle(
  activeProjectName: string | null,
  isMobile: boolean,
  activeEnvironmentName: string | null = null,
): string {
  if (!activeProjectName) return "Orkestrator AI";
  if (!isMobile) return `Orkestrator AI - ${activeProjectName}`;
  return activeEnvironmentName
    ? `${activeProjectName} - ${activeEnvironmentName}`
    : activeProjectName;
}
