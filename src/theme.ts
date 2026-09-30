import { getCurrentWindow } from "@tauri-apps/api/window";

export type ThemePref = "system" | "light" | "dark";

const KEY = "arca-theme";

export function savedTheme(): ThemePref {
  const value = localStorage.getItem(KEY);
  return value === "light" || value === "dark" ? value : "system";
}

/** The window theme drives both the title bar and the webview's prefers-color-scheme, which the CSS follows. */
export function applyTheme(pref: ThemePref) {
  localStorage.setItem(KEY, pref);
  return getCurrentWindow().setTheme(pref === "system" ? null : pref);
}
