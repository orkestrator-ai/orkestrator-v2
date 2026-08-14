export function getApplicationTitle(
  activeProjectName: string | null,
  isMobile: boolean,
  activeEnvironmentName: string | null = null,
  runtimeProfile: string | null = null,
): string {
  const productName = runtimeProfile
    ? `Orkestrator AI — DEV [${runtimeProfile}]`
    : "Orkestrator AI";
  if (!activeProjectName) return productName;
  if (runtimeProfile || !isMobile) {
    return activeEnvironmentName && isMobile
      ? `${productName} - ${activeProjectName} - ${activeEnvironmentName}`
      : `${productName} - ${activeProjectName}`;
  }
  return activeEnvironmentName
    ? `${activeProjectName} - ${activeEnvironmentName}`
    : activeProjectName;
}
