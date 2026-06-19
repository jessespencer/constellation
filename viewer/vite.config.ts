import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `base` controls the public path the built assets are served from.
// GitHub Pages project sites live under /<repo>/, so default to that for
// production builds; override with BASE_PATH (e.g. "/" for root hosts or a
// custom domain). The dev server always serves from "/".
const base = process.env.BASE_PATH ?? "/constellation/";

export default defineConfig({
  base,
  plugins: [react()],
});
