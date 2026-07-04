import { spawn } from "node:child_process";

export interface StartBotifiedServeInput {
  binaryPath?: string;
  configPath: string;
  env?: NodeJS.ProcessEnv;
}

export function startBotifiedServe(input: StartBotifiedServeInput): ReturnType<typeof spawn> {
  const binary = input.binaryPath ?? "botified";
  return spawn(binary, ["serve", "--config", input.configPath], {
    stdio: "inherit",
    env: input.env ?? process.env
  });
}

