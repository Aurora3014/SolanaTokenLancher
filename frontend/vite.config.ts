import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// The project-wide .env sits one level up; the backend port is read from it for the dev proxy.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '..', '')
  const backend = `http://127.0.0.1:${env.PORT || 4000}`
  return {
    envDir: '..',
    plugins: [react(), nodePolyfills({ include: ['buffer'], globals: { Buffer: true } })],
    // Bind IPv4 explicitly so http://localhost:5173 and http://127.0.0.1:5173 both reach the same server.
    server: { host: '127.0.0.1', port: 5173, proxy: { '/api': backend } },
  }
})
