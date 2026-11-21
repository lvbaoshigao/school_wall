import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_')
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
  if (backendPort === clientPort) throw new Error('VITE_PORT and VITE_BACKEND_PORT must use different ports')
  const backendTarget = 'http://127.0.0.1:' + backendPort
  return {
    plugins: [vue()],
    server: {
      host: '127.0.0.1',
      port: clientPort,
      strictPort: true,
      proxy: {
        '/api': {
          target: backendTarget,
          changeOrigin: true,
        },
        '/rele': {
          target: backendTarget,
          changeOrigin: true,
        },
        '/uploads': {
          target: backendTarget,
          changeOrigin: true,
        },
        '/dashboard': {
          target: backendTarget,
          changeOrigin: true,
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
