import { defineConfig } from 'electron-vite';
import { resolve } from 'path';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      lib: { entry: resolve(__dirname, 'src/main/index.ts') },
      rollupOptions: {
        external: ['electron', 'ws', 'koffi'],
      },
    },
    resolve: {
      alias: { '@main': resolve(__dirname, 'src/main') },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      lib: { entry: resolve(__dirname, 'src/preload/index.ts') },
    },
  },
  renderer: {
    root: 'src/renderer',
    // Equivalent to passing `--host` on the Vite CLI: binds to 0.0.0.0
    // (all interfaces) instead of just localhost. On Windows this avoids a
    // family of failures where binding to a specific loopback address gets
    // refused — typical culprits are firewall hooks, VPN adapters, or the
    // Node 17+ IPv6-first localhost resolution disagreeing with Vite's
    // IPv4 bind. With `host: true`, the server answers on any local
    // address Electron asks for.
    // strictPort makes a port conflict fail loudly instead of silently
    // moving to 5174 and leaving ELECTRON_RENDERER_URL stale.
    server: {
      host: true,
      port: 5173,
      strictPort: true,
    },
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
    plugins: [react()],
    resolve: {
      alias: { '@renderer': resolve(__dirname, 'src/renderer/src') },
    },
  },
});
