import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { readFileSync } from "node:fs";

// Single source of truth for the version shown in the admin UI:
// the root package.json version (kept in sync with admin-ui/package.json).
const rootPkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** @type {import('@sveltejs/kit').Config} */
export default {
  preprocess: vitePreprocess(),
  kit: {
    version: { name: rootPkg.version },
    adapter: adapter({
      fallback: "index.html",
      pages: "build",
      assets: "build",
    }),
    alias: {
      $lib: "./src/lib",
    },
  },
};
