import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const base = env.VITE_BASE_PATH || "/";
  return {
    base: base.endsWith("/") ? base : `${base}/`,
    server: {
      port: 5173,
    },
  };
});
