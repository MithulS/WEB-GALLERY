import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyRequest) => {
            proxyRequest.setHeader('Origin', 'http://localhost:5173')
          })
          proxy.on('error', (err, _req, _res) => {
            console.error('[Vite Proxy Error] Unable to connect to backend at http://localhost:5000. Make sure the backend server is running (`npm run dev:local`).', err.message)
          })
        },
      },
    },
  },
})
