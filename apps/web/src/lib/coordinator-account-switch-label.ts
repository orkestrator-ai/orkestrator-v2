/** The switch service appends this role to the project name in stored records. */
export function formatCoordinatorAccountSwitchName(name: string): string {
  return name.replace(/ coordinator$/, " Coordinator");
}
