import { createContext, useContext, type ReactNode } from "react";

const DockerAvailabilityContext = createContext(true);

export function DockerAvailabilityProvider({
  available,
  children,
}: {
  available: boolean;
  children: ReactNode;
}) {
  return (
    <DockerAvailabilityContext.Provider value={available}>
      {children}
    </DockerAvailabilityContext.Provider>
  );
}

/**
 * Whether Docker-backed UI may perform work. The default keeps isolated
 * component renders usable; the application root always supplies the live
 * daemon status.
 */
export function useDockerAvailability(): boolean {
  return useContext(DockerAvailabilityContext);
}
