import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    proxy:
      mode === "gateway"
        ? { "/api": "http://127.0.0.1:8090", "/healthz": "http://127.0.0.1:8090" }
        : undefined,
  },
}));