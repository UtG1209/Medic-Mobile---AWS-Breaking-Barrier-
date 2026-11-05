/** Light or dark. The page opens in light (the designed look) until the person picks dark; the choice is remembered. */
export type Theme = "light" | "dark";
const KEY = "theme";

/** The saved choice, or null (private mode, blocked storage and "never chosen" all read as null). */
export function savedTheme(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "dark" || v === "light" ? v : null;
  } catch {
    return null;
  }
}

/** The theme on the page right now (index.html sets it before the first paint). */
export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function setTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* private mode: the choice lasts until the page closes */
  }
}
