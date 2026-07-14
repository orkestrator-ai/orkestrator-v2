import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import "./public.css";
import { PublicApp } from "./PublicApp";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PublicApp />
  </React.StrictMode>,
);
