"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";
const KEY = "hw_theme";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  // read current theme on mount
  useEffect(() => {
    const saved = (localStorage.getItem(KEY) as Theme | null) ?? null;
    const initial: Theme =
      saved ??
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    setTheme(initial);
  }, []);

  // apply on change
  useEffect(() => {
    if (!theme) return;
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
    localStorage.setItem(KEY, theme);
  }, [theme]);

  if (!theme) return null; // avoid hydration mismatch

  return (
    <button
      aria-label="Toggle theme"
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-background text-foreground transition-colors hover:bg-accent"
    >
      {theme === "dark" ? "☀️" : "🌙"}
    </button>
  );
}
