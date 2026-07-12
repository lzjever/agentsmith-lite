import { publicBasePathForUrl } from "./scripts/public-base-url.mjs";

const publicBasePath = publicBasePathForUrl(process.env.APP_PUBLIC_BASE_URL);

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  distDir: process.env.AGENTSMITH_NEXT_DIST_DIR || ".next",
  basePath: publicBasePath === "/" ? "" : publicBasePath,
  env: {
    NEXT_PUBLIC_API_BASE_PATH: `${publicBasePath === "/" ? "" : publicBasePath}/api/v1`
  }
};

export default nextConfig;
