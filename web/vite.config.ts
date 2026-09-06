import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Bind all interfaces rather than loopback only. A VPN client that proxies
    // or rewrites localhost will otherwise make the dev server unreachable on
    // the very machine running it - the failure looks like the server being
    // down rather than a name-resolution problem.
    //
    // This does expose the dev server to your local network while it runs.
    // Fine for a dev server on a trusted network; do not do it on a hostile one.
    host: true,
    // Pinned, and strict about it. Vite's default is to hunt for a free port
    // when 5173 is taken, which means the URL in the README is a guess and a
    // stale server from an earlier session silently takes over. Failing to
    // start is the more useful behaviour: it tells you something is already
    // running instead of quietly serving you the wrong thing.
    port: 5180,
    strictPort: true,
    // The board imports the backend directly from ../src, so Vite has to be
    // allowed to serve files from above the web/ root.
    fs: { allow: ['..'] },
  },
  build: { outDir: 'dist', sourcemap: true },
});
