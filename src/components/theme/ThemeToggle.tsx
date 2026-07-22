"use client";

import { Moon, Sun } from "lucide-react";
import { useAppTheme } from "../../app/providers";

const options = [{ id: "light" as const, label: "Light", Icon: Sun }, { id: "dark" as const, label: "Dark", Icon: Moon }];

export function ThemeToggle({ mobile = false }: { mobile?: boolean }) {
  const { theme, setTheme } = useAppTheme();
  return <div className={mobile ? "border-t border-border/20 px-4 py-4" : "hidden shrink-0 items-center md:flex"}>{mobile ? <p className="mb-2 text-xs font-medium text-tertiary">Appearance</p> : null}<div role="group" aria-label="Theme" className="theme-switch-shell" data-density={mobile ? "comfortable" : "compact"}>{options.map(({ id, label, Icon }) => <button key={id} type="button" className="theme-switch-option" data-active={theme === id} data-density={mobile ? "comfortable" : "compact"} aria-label={mobile ? label : `Use ${id} theme`} aria-pressed={theme === id} title={label} onClick={() => setTheme(id)}><Icon className="size-4 shrink-0" /><span className={mobile ? "" : "sr-only"}>{label}</span></button>)}</div></div>;
}
