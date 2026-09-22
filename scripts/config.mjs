import { readFile } from "node:fs/promises";
import { parse } from "smol-toml";

export const configPath = new URL("../wrangler.toml", import.meta.url);
export async function readConfig() {
  return parse(await readFile(configPath, "utf8"));
}
