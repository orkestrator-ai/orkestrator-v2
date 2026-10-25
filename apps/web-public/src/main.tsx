import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import "./public.css";
import "./landing.css";
import { LandingPage } from "./LandingPage";
import { isConnectPath } from "./routes";

// The landing page stays light; the connection screen and the app behind it
// load only when the visitor asks for them.
const PublicApp = lazy(() =>
  import("./PublicApp").then((module) => ({ default: module.PublicApp })),
);

const onConnectPage = isConnectPath(window.location.pathname);
if (onConnectPage) document.title = "Orkestrator · Connect";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {onConnectPage ? (
      <Suspense fallback={<div className="public-app-loading" />}>
        <PublicApp />
      </Suspense>
    ) : (
      <LandingPage />
    )}
  </React.StrictMode>,
);
