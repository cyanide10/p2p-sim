import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  // `npm run dev:gateway` proxies the API to a running gateway (GATEWAY_URL).
  const gateway = loadEnv(mode, ".", "").GATEWAY_URL || "http://127.0.0.1:8080";
  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      proxy: mode === "gateway" ? { "/api": gateway, "/healthz": gateway } : undefined,
    },
  };
});
