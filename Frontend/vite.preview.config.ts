import { defineConfig, mergeConfig } from 'vite'
import base from './vite.config'

// Local preview only: serve on all interfaces and proxy /api to dev:local so the browser needs one port.
export default mergeConfig(base, defineConfig({
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api/, '') } },
  },
}))
