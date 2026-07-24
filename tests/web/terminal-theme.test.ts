import assert from "node:assert/strict";
import test from "node:test";
import { resolveThemeTokens } from "@astryxdesign/core/theme/tokens";
import { xtermThemeFromTokens } from "../../src/components/tasks/terminal-theme.js";
import { agentSmithTheme } from "../../src/theme/agentSmithTheme.js";

test("maps the AgentSmith light and dark theme source to concrete Xterm palettes", () => {
  const light = xtermThemeFromTokens(resolveThemeTokens(agentSmithTheme, { mode: "light" }));
  const dark = xtermThemeFromTokens(resolveThemeTokens(agentSmithTheme, { mode: "dark" }));

  assert.equal(light.background, "#f8fafc");
  assert.equal(light.foreground, "#20262c");
  assert.equal(dark.background, "#171a1d");
  assert.equal(dark.foreground, "#edf1f4");

  assert.notEqual(light.background, dark.background);
  assert.notEqual(light.foreground, dark.foreground);
  assert.ok(
    [...Object.values(light), ...Object.values(dark)].every(
      (color) => typeof color === "string" && color.length > 0 && !color.includes("var(") && !color.includes("light-dark("),
    ),
  );
});

test("fails fast when a required terminal palette token is missing", () => {
  const tokens = { ...resolveThemeTokens(agentSmithTheme, { mode: "light" }) };
  delete tokens["--color-accent"];

  assert.throws(
    () => xtermThemeFromTokens(tokens),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("--color-accent"),
  );
});
