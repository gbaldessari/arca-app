import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { applyTheme, savedTheme } from "./theme";

// The window starts hidden so it never flashes the wrong theme before the UI is painted.
applyTheme(savedTheme())
  .catch(() => {})
  .finally(() => {
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
    requestAnimationFrame(() => requestAnimationFrame(() => getCurrentWindow().show()));
  });
