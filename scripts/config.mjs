import { readFile } from "node:fs/promises";

export const configPath = new URL("../wrangler.json", import.meta.url);
export async function readConfig() {
  return JSON.parse(await readFile(configPath, "utf8"));
}
