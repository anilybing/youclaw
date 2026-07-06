import path from "path"
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import http from 'node:http'

const BACKEND_PORT = process.env.PORT || '62601'
const BACKEND_HOST = process.env.BACKEND_HOST || '127.0.0.1'
const BACKEND_ORIGIN = `http://${BACKEND_HOST}:${BACKEND_PORT}`

// https://vite.dev/config/
export default defineConfig({
  base: './',
  build: {
    // Tauri uses system WKWebView; macOS 10.15 ships Safari 13
    target: ['es2020', 'safari13'],
  },
  plugins: [
    // Rewrite named capture groups to numbered groups for older WebKit compat
    // (macOS < 13.4 / Safari < 16.4 doesn't support named groups in regex).
    // marked v17 uses (?<a>...) \k<a> and (?<b>...) \k<b> for backtick matching.
    {
      name: 'regex-compat',
      enforce: 'pre' as const,
      transform(code, id) {
        if (!id.includes('marked')) return
        // Each named group (?<x>...) becomes (...) and \k<x> becomes \1
        // These are self-contained regexes where the named group is group #1
        const result = code
          .replaceAll('(?<a>', '(').replaceAll('\\k<a>', '\\1')
          .replaceAll('(?<b>', '(').replaceAll('\\k<b>', '\\1')
        if (result === code) return
        return { code: result, map: null }
      },
    },
    react(),
    tailwindcss(),
    // SSE proxy plugin: bypass Vite default proxy response buffering
    {
      name: 'sse-proxy',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!req.url?.startsWith('/api/stream/')) return next()

          // Pipe directly to the backend, bypassing http-proxy buffering
          const proxyReq = http.request(
            `${BACKEND_ORIGIN}${req.url}`,
            { method: 'GET', headers: { ...req.headers, host: `${BACKEND_HOST}:${BACKEND_PORT}` } },
            (proxyRes) => {
              res.writeHead(proxyRes.statusCode ?? 200, {
                ...proxyRes.headers,
                'cache-control': 'no-cache',
                'x-accel-buffering': 'no',
              })
              proxyRes.pipe(res)
            },
          )

          proxyReq.on('error', () => {
            if (!res.headersSent) res.writeHead(502)
            res.end()
          })

          req.on('close', () => proxyReq.destroy())
          proxyReq.end()
        })
      },
    },
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: BACKEND_ORIGIN,
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
