import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  build: {
    rollupOptions: {
      output: {
        // ECharts is loaded lazily via dynamic import (see lib/EChart.svelte).
        // Split its zrender base lib from the echarts core/charts/components
        // modules so no single chunk trips the 500 kB build warning — both async
        // chunks are fetched together only when a chart actually renders.
        manualChunks(id) {
          if (id.includes("zrender")) return "zrender";
        },
      },
    },
  },
});