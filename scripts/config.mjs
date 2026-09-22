import { readFile } from "node:fs/promises";
import { parse } from "jsonc-parser";

export async function readConfig() {
  const errors = [];
  const config = parse(
    await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    errors,
    { allowTrailingComma: true },
  );
  if (errors.length) throw new Error("Invalid wrangler.jsonc");
  return config;
}
