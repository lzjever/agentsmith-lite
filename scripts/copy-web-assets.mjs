import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/src", { recursive: true });
await cp("src/web", "dist/src/web", { recursive: true });

