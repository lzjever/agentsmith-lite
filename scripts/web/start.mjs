import { spawn } from "node:child_process";
import { publicBaseUrl } from "../public-base-url.mjs";

const builtPublicBaseUrl = publicBaseUrl(process.env.APP_BUILD_PUBLIC_BASE_URL);
const runtimePublicBaseUrl = publicBaseUrl(process.env.APP_PUBLIC_BASE_URL);
if (builtPublicBaseUrl !== runtimePublicBaseUrl) {
  throw new Error(`APP_PUBLIC_BASE_URL (${runtimePublicBaseUrl}) does not match the image build URL (${builtPublicBaseUrl})`);
}

const server = spawn("node", [".next/standalone/server.js"], { stdio: "inherit" });
server.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
