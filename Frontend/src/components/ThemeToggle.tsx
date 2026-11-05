import { useState } from "react";
import { currentTheme, setTheme, type Theme } from "../theme";
import { Icon } from "./Icon";

/** Top bar button: switches between the light and the dark theme. The icon shows what a click switches to. */
export function ThemeToggle() {
  const [theme, setT] = useState<Theme>(currentTheme);
  const next: Theme = theme === "dark" ? "light" : "dark";
  const label = next === "dark" ? "Switch to dark mode" : "Switch to light mode";
  return (
    <button type="button" className="tb-theme" aria-label={label} title={label} onClick={() => { setTheme(next); setT(next); }}>
      <Icon name={next === "dark" ? "dark_mode" : "light_mode"} size={20} />
    </button>
  );
}
