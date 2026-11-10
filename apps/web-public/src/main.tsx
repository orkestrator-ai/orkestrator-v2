import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import "./public.css";
import "./landing.css";
import "./releases.css";
import { LandingPage } from "./LandingPage";
import { ReleasesPage } from "./ReleasesPage";
import { publicPageFor } from "./routes";

// The landing and Releases pages stay light; the connection screen and the app
// behind it load only when the visitor asks for them.
const PublicApp = lazy(() =>
  import("./PublicApp").then((module) => ({ default: module.PublicApp })),
);

const page = publicPageFor(window.location.pathname);
if (page === "connect") document.title = "Orkestrator · Connect";
if (page === "releases") document.title = "Orkestrator · Releases";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {page === "connect" ? (
      <Suspense fallback={<div className="public-app-loading" />}>
        <PublicApp />
      </Suspense>
    ) : page === "releases" ? (
      <ReleasesPage />
    ) : (
      <LandingPage />
    )}
  </React.StrictMode>,
);
