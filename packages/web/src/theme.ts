import { useState } from "react";

/**
 * Colour theme. Dark is the default; the viewer's choice is remembered per
 * browser. The theme is a `data-theme` attribute on <html> that switches the
 * CSS custom properties in styles.css.
 */
export type Theme = "dark" | "light";

const THEME_KEY = "mechflow:theme";

/** The stored theme, or dark when nothing (or nothing readable) is stored. */
export function storedTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/** Current theme plus a toggle that applies and remembers the other one. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const toggle = (): void => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    applyTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Storage blocked: the theme still applies for this page.
    }
    setTheme(next);
  };
  return [theme, toggle];
}
