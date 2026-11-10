import type { ComponentType, SVGProps } from "react";
import { ArrowUpRight, Sparkles, TrendingUp, Wrench, History } from "lucide-react";
import {
  RELEASES,
  RELEASES_REPOSITORY_URL,
  releaseNotesUrl,
  type ReleaseChannel,
  type ReleaseSummary,
} from "./releases-data";
import { SiteFooter, SiteHeader } from "./SiteChrome";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

const CHANGE_GROUPS: Array<{
  key: "new" | "improved" | "fixed";
  label: string;
  icon: Icon;
}> = [
  { key: "new", label: "New", icon: Sparkles },
  { key: "improved", label: "Improved", icon: TrendingUp },
  { key: "fixed", label: "Fixed", icon: Wrench },
];

const CHANNEL_LABELS: Record<ReleaseChannel, string> = {
  stable: "Stable",
  beta: "Beta",
  unstable: "Unstable",
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** `2026-11-10` → `10 November 2026`, the same for every visitor's locale and time zone. */
export function formatReleaseDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const monthName = month ? MONTHS[month - 1] : undefined;
  if (!year || !monthName || !day) return date;
  return `${day} ${monthName} ${year}`;
}

function releaseHeadingId(release: ReleaseSummary): string {
  return `release-${release.version.replace(/[^a-z0-9]+/gi, "-")}`;
}

function ReleaseCard({ release }: { release: ReleaseSummary }) {
  const headingId = releaseHeadingId(release);
  const groups = CHANGE_GROUPS.filter((group) => release[group.key].length > 0);
  return (
    <li>
      <article className="release-card" aria-labelledby={headingId}>
        <header className="release-card__head">
          <div className="release-card__title">
            <h2 id={headingId}>{release.version}</h2>
            <span className={`release-channel release-channel--${release.channel}`}>
              {CHANNEL_LABELS[release.channel]}
            </span>
          </div>
          <time dateTime={release.date}>{formatReleaseDate(release.date)}</time>
        </header>
        {release.intro && <p className="release-card__intro">{release.intro}</p>}
        <div className="release-groups">
          {groups.map(({ key, label, icon: GroupIcon }) => (
            <section
              key={key}
              className={`release-group release-group--${key}`}
              aria-label={`${label} in ${release.version}`}
            >
              <h3>
                <GroupIcon aria-hidden="true" />
                {label}
              </h3>
              <ul>
                {release[key].map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <a className="release-card__notes" href={releaseNotesUrl(release)} rel="noreferrer">
          Full release notes for {release.version}
          <ArrowUpRight aria-hidden="true" />
        </a>
      </article>
    </li>
  );
}

export function ReleasesPage({ releases = RELEASES }: { releases?: readonly ReleaseSummary[] }) {
  return (
    <div className="landing">
      <SiteHeader current="releases" />

      <main className="releases" aria-labelledby="releases-title">
        <div className="landing-section__intro releases__intro">
          <p className="landing-eyebrow">
            <History aria-hidden="true" /> Releases
          </p>
          <h1 id="releases-title">What’s new in Orkestrator</h1>
          <p className="landing-lead">
            The last five releases in plain language: what was added, what got better and what was
            fixed. The in-app updater installs them for you on the channel you choose.
          </p>
        </div>

        <ol className="release-list" aria-label="Recent releases, newest first">
          {releases.map((release) => (
            <ReleaseCard key={release.tag} release={release} />
          ))}
        </ol>

        <p className="releases__more">
          Looking for an older version?{" "}
          <a href={`${RELEASES_REPOSITORY_URL}/releases`} rel="noreferrer">
            See every release on GitHub
            <ArrowUpRight aria-hidden="true" />
          </a>
        </p>
      </main>

      <SiteFooter />
    </div>
  );
}
