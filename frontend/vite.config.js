import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // Emit the built site into the REPO-ROOT public/ directory. On Vercel,
    // whichever framework preset wins (Vite or auto-detected FastAPI), files
    // in root public/** are served statically ahead of the Python function.
    outDir: '../public',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // Optional convenience: proxy API calls so the frontend can call
    // "/api/process-image" without hardcoding the backend origin.
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
});
