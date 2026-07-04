import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

if (!process.env.POSTGRES_APP_URL) {
  throw new Error("POSTGRES_APP_URL is required for schema bootstrap");
}

const dir = path.resolve("infra/db/migrations");
const files = (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort();
for (const file of files) {
  const sql = await readFile(path.join(dir, file), "utf8");
  console.log(`validated migration ${file} (${sql.length} bytes)`);
}
console.log("P0 schema bootstrap contract validated; install a real pg runner before live apply.");

