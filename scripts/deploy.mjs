import { syncProjects } from "./sync-projects.mjs";
import { setup, wrangler } from "./setup.mjs";

// Always consume the main-branch registry, never a stale local allowlist.
await syncProjects();
await setup(true);
wrangler(["deploy", "--minify"]);
