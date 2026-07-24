import assert from "node:assert/strict";
import test from "node:test";
import {
  agentSmithThemeName,
  parseThemeMode,
  serializeThemeModeCookie,
  themeCookieName,
  themeHtmlAttributes,
} from "../../src/components/theme/theme.js";

test("parses every supported Astryx theme mode", () => {
  assert.equal(parseThemeMode("light"), "light");
  assert.equal(parseThemeMode("dark"), "dark");
  assert.equal(parseThemeMode("system"), "system");
});

test("defaults missing and invalid cookie values to system", () => {
  assert.equal(parseThemeMode(undefined), "system");
  assert.equal(parseThemeMode(""), "system");
  assert.equal(parseThemeMode("sepia"), "system");
});

test("persists explicit modes and deletes the cookie for system mode", () => {
  assert.equal(
    serializeThemeModeCookie("light"),
    `${themeCookieName}=light; Path=/; Max-Age=31536000; SameSite=Lax`,
  );
  assert.equal(
    serializeThemeModeCookie("dark"),
    `${themeCookieName}=dark; Path=/; Max-Age=31536000; SameSite=Lax`,
  );
  assert.equal(
    serializeThemeModeCookie("system"),
    `${themeCookieName}=; Path=/; Max-Age=0; SameSite=Lax`,
  );
});

test("SSR always names the theme and leaves system color mode implicit", () => {
  assert.deepEqual(themeHtmlAttributes("system"), {
    "data-astryx-theme": agentSmithThemeName,
  });
  assert.deepEqual(themeHtmlAttributes("light"), {
    "data-astryx-theme": agentSmithThemeName,
    "data-theme": "light",
  });
  assert.deepEqual(themeHtmlAttributes("dark"), {
    "data-astryx-theme": agentSmithThemeName,
    "data-theme": "dark",
  });
});
