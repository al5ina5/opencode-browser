import { sentryVitePlugin } from "@sentry/vite-plugin"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { defineConfig, type Plugin } from "vite"
import desktopPlugin from "./vite"

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./dist/**",
          filesToDeleteAfterUpload: "./dist/**/*.map",
        },
      })
    : false

const browserRuntimeAssets: Plugin = {
  name: "opencode-browser-runtime-assets",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url?.split("?")[0] !== "/browsernode_kernel.js") return next()
      void readFile(resolve(server.config.publicDir, "browsernode_kernel.js")).then((bytes) => {
        response.statusCode = 200
        response.setHeader("Content-Type", "text/javascript")
        response.setHeader("Cache-Control", "no-cache")
        response.end(bytes)
      }, next)
    })
  },
}

export default defineConfig({
  plugins: [browserRuntimeAssets, desktopPlugin, sentry] as any,
  optimizeDeps: {
    exclude: ["@foisal/nodebrowser"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    },
  },
  build: {
    target: "esnext",
    sourcemap: true,
  },
})
