import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../index.css";
import "./sidepanel.css";
import { SidepanelApp } from "./SidepanelApp";

const container = document.getElementById("sidepanel-root");

if (!container) {
  throw new Error("Side panel root element not found");
}

const root = createRoot(container);

root.render(
  <StrictMode>
    <SidepanelApp />
  </StrictMode>,
);
