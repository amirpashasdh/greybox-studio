import { defineConfig } from 'vite';

// Optional: route the agent through the dev server to avoid CORS with local model servers.
//   GREYBOX_LLM_TARGET=http://localhost:11434/v1 npm run dev
// then tick "Route through the dev server" in the editor's Model settings.
const target = process.env.GREYBOX_LLM_TARGET;

export default defineConfig({
  base: './',
  server: {
    port: 5173,
    proxy: target
      ? { '/llm-proxy': { target, changeOrigin: true, rewrite: (p) => p.replace(/^\/llm-proxy/, '') } }
      : undefined,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
