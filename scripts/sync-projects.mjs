import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { configPath } from "./config.mjs";

export function selectProjects(registry) {
  const projects = {};
  const groups = [];
  for (const [key, project] of Object.entries(registry)) {
    if (key.startsWith("_") || key.startsWith("$")) continue;
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key) ||
      key.length > 64 ||
      typeof project.name !== "string" ||
      (project.remote_cache !== undefined &&
        typeof project.remote_cache !== "boolean")
    )
      throw new Error(`Invalid project definition: ${key}`);
    const group = `Project: ${project.display_name ?? project.name}`;
    if (group.length > 128 || groups.includes(group))
      throw new Error(`Invalid or duplicate project group: ${key}`);
    groups.push(group);
    if (project.remote_cache === true) projects[key] = group;
  }
  // The shared Okta claim contains all Project groups, including disabled caches.
  // Bound the worst case, rather than assuming each user has few memberships.
  if (groups.length > 64 || Buffer.byteLength(JSON.stringify({ groups })) > 700)
    throw new Error(
      "Project groups exceed the Access custom-claim budget (700 bytes / 64 groups)",
    );
  return projects;
}

export async function syncProjects(file) {
  const registry = JSON.parse(
    file
      ? await readFile(file, "utf8")
      : execFileSync(
          "gh",
          [
            "api",
            "repos/tractorbeamai/infra/contents/data/projects.json?ref=main",
            "-H",
            "Accept: application/vnd.github.raw+json",
          ],
          { encoding: "utf8" },
        ),
  );
  const projects = selectProjects(registry);
  const source = await readFile(configPath, "utf8");
  const section =
    /# BEGIN GENERATED PROJECTS[^\n]*\n[\s\S]*?# END GENERATED PROJECTS/;
  if (!section.test(source))
    throw new Error("Missing generated project section in wrangler.toml");
  await writeFile(
    configPath,
    source.replace(
      section,
      [
        "# BEGIN GENERATED PROJECTS — npm run sync-projects",
        "[vars.PROJECTS]",
        ...Object.entries(projects)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, group]) => `${key} = ${JSON.stringify(group)}`),
        "# END GENERATED PROJECTS",
      ].join("\n"),
    ),
  );
  return projects;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const projects = await syncProjects(process.argv[2]);
  console.log(
    `Synced ${Object.keys(projects).length} enabled projects into wrangler.toml`,
  );
}
