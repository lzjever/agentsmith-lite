"use client";

import {
  RadioList,
  RadioListItem,
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core";
import { Monitor, Moon, Sun } from "lucide-react";
import { useAppTheme } from "../../app/providers";
import type { ThemeMode } from "./theme";

const options = [
  { id: "light" as const, label: "Light", Icon: Sun },
  { id: "dark" as const, label: "Dark", Icon: Moon },
  { id: "system" as const, label: "System", Icon: Monitor },
];

export function ThemeToggle({ mobile = false }: { mobile?: boolean }) {
  const { theme, setTheme } = useAppTheme();
  const changeTheme = (value: string) => setTheme(value as ThemeMode);

  if (mobile) {
    return (
      <div className="border-t border-border px-4 py-4">
        <RadioList
          label="Appearance"
          value={theme}
          onChange={changeTheme}
          orientation="horizontal"
          size="sm"
          width="100%">
          {options.map(({ id, label }) => (
            <RadioListItem key={id} value={id} label={label} />
          ))}
        </RadioList>
      </div>
    );
  }

  return (
    <div className="hidden shrink-0 items-center md:flex">
      <SegmentedControl
        value={theme}
        onChange={changeTheme}
        label="Theme"
        size="sm"
        layout="hug">
        {options.map(({ id, label, Icon }) => (
          <SegmentedControlItem
            key={id}
            value={id}
            label={label}
            isLabelHidden
            icon={<Icon className="size-4 shrink-0" />}
          />
        ))}
      </SegmentedControl>
    </div>
  );
}
