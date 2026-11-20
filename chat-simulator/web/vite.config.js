/** @file Dev server: relative `/api` calls are proxied to the local key proxy. */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
    plugins: [react(), tailwindcss()],
    server: {
        proxy: {
            "/api": {
                target: "http://127.0.0.1:8787",
                changeOrigin: false,
            },
        },
    },
});
