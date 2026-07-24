import type { ITheme } from "@xterm/xterm";

type TerminalPaletteToken =
  | "--color-syntax-background"
  | "--color-text-primary"
  | "--color-accent"
  | "--color-accent-muted"
  | "--color-background-body"
  | "--color-syntax-constant"
  | "--color-syntax-string"
  | "--color-syntax-number"
  | "--color-syntax-function"
  | "--color-syntax-keyword"
  | "--color-syntax-type"
  | "--color-text-secondary"
  | "--color-syntax-comment"
  | "--color-error"
  | "--color-success"
  | "--color-warning"
  | "--color-syntax-property";

const terminalPaletteTokens: readonly TerminalPaletteToken[] = [
  "--color-syntax-background",
  "--color-text-primary",
  "--color-accent",
  "--color-accent-muted",
  "--color-background-body",
  "--color-syntax-constant",
  "--color-syntax-string",
  "--color-syntax-number",
  "--color-syntax-function",
  "--color-syntax-keyword",
  "--color-syntax-type",
  "--color-text-secondary",
  "--color-syntax-comment",
  "--color-error",
  "--color-success",
  "--color-warning",
  "--color-syntax-property",
];

function terminalTokenResolver(tokens: Readonly<Record<string, string>>): (key: TerminalPaletteToken) => string {
  for (const key of terminalPaletteTokens) {
    if (tokens[key] === undefined) {
      throw new Error(`Missing required terminal theme token: ${key}`);
    }
  }

  return (key) => {
    const value = tokens[key];
    if (value === undefined) {
      throw new Error(`Missing required terminal theme token: ${key}`);
    }
    return value;
  };
}

export function xtermThemeFromTokens(tokens: Readonly<Record<string, string>>): ITheme {
  const token = terminalTokenResolver(tokens);

  return {
    background: token("--color-syntax-background"),
    foreground: token("--color-text-primary"),
    cursor: token("--color-accent"),
    cursorAccent: token("--color-syntax-background"),
    selectionBackground: token("--color-accent-muted"),
    selectionForeground: token("--color-text-primary"),
    black: token("--color-background-body"),
    red: token("--color-syntax-constant"),
    green: token("--color-syntax-string"),
    yellow: token("--color-syntax-number"),
    blue: token("--color-syntax-function"),
    magenta: token("--color-syntax-keyword"),
    cyan: token("--color-syntax-type"),
    white: token("--color-text-secondary"),
    brightBlack: token("--color-syntax-comment"),
    brightRed: token("--color-error"),
    brightGreen: token("--color-success"),
    brightYellow: token("--color-warning"),
    brightBlue: token("--color-accent"),
    brightMagenta: token("--color-syntax-keyword"),
    brightCyan: token("--color-syntax-property"),
    brightWhite: token("--color-text-primary"),
  };
}
