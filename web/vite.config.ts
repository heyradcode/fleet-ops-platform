import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The board imports the backend directly from ../src, so Vite has to be
  // allowed to serve files from above the web/ root.
  server: { fs: { allow: ['..'] } },
  build: { outDir: 'dist', sourcemap: true },
});
