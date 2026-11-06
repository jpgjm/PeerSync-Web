import { defineConfig } from "vite";

// GitHub Pages: https://jpgjm.github.io/PeerSync-Web/
export default defineConfig({
  base: "/PeerSync-Web/",
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 4096,
  },
  // main.ts uses top-level await (init)
  esbuild: { target: "es2022" },
});
