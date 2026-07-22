"use client";

import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core";
import { Moon, Sun } from "lucide-react";
import { useAppTheme } from "../../app/providers";
import type { Theme } from "./theme";

const options = [{ id: "light" as const, label: "Light", Icon: Sun }, { id: "dark" as const, label: "Dark", Icon: Moon }];

export function ThemeToggle({ mobile = false }: { mobile?: boolean }) {
  const { theme, setTheme } = useAppTheme();
  return <div className={mobile ? "border-t border-border/20 px-4 py-4" : "hidden shrink-0 items-center md:flex"}>{mobile ? <p className="mb-2 text-xs font-medium text-tertiary">Appearance</p> : null}<SegmentedControl value={theme} onChange={(value) => setTheme(value as Theme)} label="Theme" size={mobile ? "md" : "sm"} layout={mobile ? "fill" : "hug"} className={mobile ? "flex w-full" : undefined}>{options.map(({ id, label, Icon }) => <SegmentedControlItem key={id} value={id} label={label} isLabelHidden={!mobile} icon={<Icon className="size-4 shrink-0" />} />)}</SegmentedControl></div>;
}
