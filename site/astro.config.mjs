// @ts-check
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// Deployed to GitHub Pages at https://niieani.github.io/caara/
export default defineConfig({
  site: "https://niieani.github.io",
  base: "/caara",
  trailingSlash: "ignore",
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
