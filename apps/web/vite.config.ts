import { defineConfig } from "vite";
// Development/preview HTTP routing only. Production hosting must route /api
// to the Portal API separately from the frontend's SPA fallback.
const proxy = {
  "/api": {
    target: process.env.PORTAL_API_PROXY_TARGET ?? "http://127.0.0.1:3000",
    changeOrigin: false,
  },
};
export default defineConfig({ server: { proxy }, preview: { proxy } });
