import { LogIn } from "lucide-react";
import orkLogo from "../../../logos/ork-logo2.png";
import { CONNECT_PATH, RELEASES_PATH } from "./routes";

export const GITHUB_URL = "https://github.com/orkestrator-ai/orkestrator-v2";

export function Brand() {
  return (
    <a className="landing-brand" href="/" aria-label="Orkestrator home">
      <img src={orkLogo} alt="" width={36} height={36} />
      <span>Orkestrator</span>
    </a>
  );
}

/**
 * The sticky header shared by the landing and Releases pages. The section
 * links point into the landing page, so on any other page they carry its path.
 */
export function SiteHeader({ current }: { current: "landing" | "releases" }) {
  const section = (id: string) => (current === "landing" ? `#${id}` : `/#${id}`);
  return (
    <header className="landing-nav">
      <div className="landing-nav__inner">
        <Brand />
        <nav aria-label="Sections">
          <a href={section("security")}>Security</a>
          <a href={section("graphs")}>Pipelines</a>
          <a href={section("multi-review")}>Multi Review</a>
          <a href={RELEASES_PATH} aria-current={current === "releases" ? "page" : undefined}>
            Releases
          </a>
          <a href={GITHUB_URL} rel="noreferrer">
            GitHub
          </a>
        </nav>
        <a className="landing-button landing-button--quiet landing-nav__login" href={CONNECT_PATH}>
          <LogIn aria-hidden="true" />
          Log in
        </a>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="landing-footer">
      <Brand />
      <nav aria-label="Footer">
        <a href={GITHUB_URL} rel="noreferrer">
          GitHub
        </a>
        <a href={RELEASES_PATH}>Releases</a>
        <a href={CONNECT_PATH}>Connect</a>
      </nav>
    </footer>
  );
}
