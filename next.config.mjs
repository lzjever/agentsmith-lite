import { publicBasePathForUrl } from "./scripts/public-base-url.mjs";

const publicBasePath = publicBasePathForUrl(process.env.APP_PUBLIC_BASE_URL);
const localApiBaseUrl = process.env.LOCAL_API_BASE_URL?.trim().replace(/\/+$/, "");

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  distDir: process.env.AGENTSMITH_NEXT_DIST_DIR || ".next",
  basePath: publicBasePath === "/" ? "" : publicBasePath,
  experimental: {
    cpus: 1
  },
  async rewrites() {
    if (!localApiBaseUrl) return [];
    const sourceBasePath = publicBasePath === "/" ? "" : publicBasePath;
    return [{
      source: `${sourceBasePath}/api/v1/:path*`,
      destination: `${localApiBaseUrl}/:path*`,
      basePath: false
    }];
  },
  env: {
    NEXT_PUBLIC_API_BASE_PATH: `${publicBasePath === "/" ? "" : publicBasePath}/api/v1`
  }
};

export default nextConfig;
