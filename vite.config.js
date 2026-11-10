import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    svelte(),
    { name: "dbx-build-signal", closeBundle() { console.log("DBX_UI_BUILD_SUCCESS"); } },
  ],
  // One chunk on purpose: DBX inlines the entry module on hosts without a plugin asset origin, so lazy chunks would not load there.
  build: { outDir: "ui", emptyOutDir: true, chunkSizeWarningLimit: 1024 },
});
