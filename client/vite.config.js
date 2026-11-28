import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'

export default defineConfig(({ mode }) => {
  // Proxy targets are development-server configuration, never browser API URLs.
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), ['VITE_', 'BACKEND_'])
  const readPort = (name, fallback) => {
    const value = env[name] ?? String(fallback)
    const port = Number(value)
    if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(name + ' must be a port number from 1 to 65535')
    }
    return port
  }
  const backendPort = readPort('VITE_BACKEND_PORT', 3000)
  const clientPort = readPort('VITE_PORT', 5173)
  const rawTarget = env.BACKEND_ORIGIN || env.VITE_BACKEND_ORIGIN || 'http://127.0.0.1:' + backendPort
  let backendUrl
  try { backendUrl = new URL(rawTarget) } catch {
    throw new Error('BACKEND_ORIGIN must be an absolute http(s) origin')
  }
  if (!['http:', 'https:'].includes(backendUrl.protocol) || backendUrl.username || backendUrl.password ||
      backendUrl.pathname !== '/' || backendUrl.search || backendUrl.hash) {
    throw new Error('BACKEND_ORIGIN must be an http(s) origin without credentials, path, query or fragment')
  }
  const targetPort = Number(backendUrl.port || (backendUrl.protocol === 'https:' ? 443 : 80))
  if (['127.0.0.1', 'localhost', '[::1]'].includes(backendUrl.hostname) && targetPort === clientPort) {
    throw new Error('The backend proxy target cannot point to the Vite server itself')
  }
  const backendTarget = backendUrl.origin
  return {
    plugins: [vue()],
    server: {
      host: '127.0.0.1',
      port: clientPort,
      strictPort: true,
      proxy: {
        '/api': {
          target: backendTarget,
          changeOrigin: false,
        },
        '/rele': {
          target: backendTarget,
          changeOrigin: false,
        },
        '/uploads': {
          target: backendTarget,
          changeOrigin: false,
        },
        '/dashboard': {
          target: backendTarget,
          changeOrigin: false,
        }
      }
    },
    build: {
      chunkSizeWarningLimit: 600,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (id.includes('vue') || id.includes('pinia') || id.includes('vue-router')) return 'vendor-vue'
              if (id.includes('axios')) return 'vendor-axios'
              if (id.includes('marked') || id.includes('dompurify')) return 'vendor-md'
              return 'vendor'
            }
          }
        }
      }
    }
  }
})
