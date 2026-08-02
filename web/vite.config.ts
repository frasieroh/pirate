import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset URLs, so the embedded bundle works from any mount point.
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "esnext",
    // One JS file and one CSS file keep the embedded asset set small and make
    // the precompression step in `cargo xtask web` predictable.
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name].[ext]",
      },
    },
  },
  server: {
    port: 5173,
  },
});
