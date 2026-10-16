# Browser Port: Research and Architecture

Research date: 2026-10-16. Source baseline: OpenCode `v1.19.2` (`7901b7d`).

## Research findings

The reviewed projects do not provide a mature, permissively licensed browser-only OpenCode implementation that can be deployed as static assets:

- [OpenCode](https://github.com/anomalyco/opencode) is the source to preserve. Its SolidJS application lives in `packages/app` and shared session UI in `packages/session-ui`. Its production web UI normally connects to the OpenCode server. The server-side agent path depends on Effect services, server state/SQLite, filesystem and shell services, plugins, and process/PTY behavior; bundling that server as-is into a browser runtime is not viable.
- [pawelhajduk/opencode-web](https://github.com/pawelhajduk/opencode-web) is a web/desktop interface that installs or connects to an OpenCode server. It does not run the agent harness and project commands in the visitor's browser.
- [deloreyj/opencode-web](https://github.com/deloreyj/opencode-web) uses a frontend and Cloudflare proxy in front of an existing OpenCode server. It is not a browser-local execution environment.
- [OpenCode's web command](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/web.mdx) serves the UI from an OpenCode server; it is not static hosting with a local browser agent.
- [bolt.diy](https://github.com/stackblitz-labs/bolt.diy) demonstrates browser-based project execution using StackBlitz WebContainers, but it is a separate agent/UI. WebContainers require a separate production/commercial license; their open-source documentation does not grant that right. See [WebContainers licensing](https://webcontainers.io/enterprise) and [WebContainer quick start](https://webcontainers.io/guides/quickstart).
- [BrowserPod](https://github.com/leaningtech/browserpod-meta) is another browser runtime product, not a permissively licensed runtime suitable for unrestricted redistribution. Its terms describe non-commercial/personal/open-source grants and additional paid use; see [BrowserPod licensing](https://browserpod.io/docs/more/licensing).
- npm package [`@foisal/nodebrowser`](https://www.npmjs.com/package/@foisal/nodebrowser) and its [source](https://github.com/foisalislambd/NodeBrowser) are MIT-licensed. It supplies a browser-local WASM kernel with a QuickJS guest, virtual filesystem, limited Node-shaped commands, package installation, OPFS persistence, and an esbuild-WASM preview path. It is not V8 or full Node.js, has no native addons or full `libuv`, and describes isolation as best-effort rather than a hardened untrusted-code boundary. It is young and experimental, but is the most usable permissively licensed option found for this initial port.
- Searches of GitHub, npm, OpenCode discussions, and the wider web for browser-only forks, WebAssembly/runtime ports, WebContainers integrations, and browser-native OpenCode harnesses found no other project that substantially eliminates this port.

## Decision

Keep the OpenCode `v1.19.2` source and its real `packages/app` interface. Adapt the app's existing `Platform.fetch` seam to a browser-local API implementation, preserving its server client, session components, and event-driven UI. A dedicated web worker handles OpenAI-compatible streaming, function/tool calls, multi-step orchestration, and cancellation. The tools call into NodeBrowser's virtual filesystem/runtime. Workspace files persist in OPFS; conversation, project metadata, and provider settings persist in IndexedDB. No project files are sent to this repository's infrastructure.

NodeBrowser is selected instead of WebContainers because its published license is MIT and does not require a separate commercial runtime license. Its QuickJS Node-shaped subset is not described as full Node.js. A compatibility patch fixes the package installer for exact-pinned dependencies and its browser esbuild/WASM loading path.

The NodeBrowser kernel currently runs on the page thread. Running its Node.js guest in a second worker caused a QuickJS stack overflow in this app, so only the OpenCode-compatible model/agent loop runs in a dedicated worker. A long-running guest script can temporarily freeze the UI. This is a known runtime constraint, not full process isolation.

## Preserved and replaced components

Preserved from OpenCode: the original SolidJS application, styling, routing and navigation, session/message presentation, shared session UI, provider/model concepts where their browser-side contracts fit, and the OpenCode client/event shapes consumed by the app.

Replaced/adapted: the remote OpenCode server connection, server persistence, filesystem/shell/process services, API endpoints, and agent execution. A browser-local adapter implements the HTTP, message paging, permissions, session status, and event contracts used by the original UI. The browser agent loop and tools are new adapters; they do not import the Bun server runner. OpenCode's server-side Effect agent runtime, plugins, server database, and PTY/process model are not in the browser bundle.

## Implemented and verified feature surface

The deterministic Chromium end-to-end test uses a controlled OpenAI-compatible streaming endpoint and verifies that real tool results drive the agent loop. It creates a workspace and conversation, writes multiple files, performs a real browser-local npm install, executes a JavaScript script, builds a React/Vite project, serves it through the local preview service worker, renders it in the preview iframe, refreshes and restores the conversation, and creates a second conversation. The test checks the browser's IndexedDB, console errors, failed requests, and preview asset responses.

The supported tools are file listing/reading/writing/editing, a limited set of shell and Node commands, npm dependency installation, project build, and preview startup. Every tool call goes through the browser runtime and OpenCode permission UI. Model calls go directly from the agent worker to the configured provider; the provider must allow browser CORS requests. There is no inference relay or privileged model credential in the static bundle.

## Runtime and deployment constraints

- Static hosting must serve `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` to enable NodeBrowser's shared-memory stdio path. The production Playwright test checks `crossOriginIsolated` and `SharedArrayBuffer`.
- The first supported environment is desktop Chromium. The app detects other browsers and reports a limited/unsupported state.
- Workspace files live in browser OPFS; conversations and settings are local IndexedDB data. Browser storage can be cleared or evicted, so export/import checkpoints are provided as ZIP archives.
- npm registry traffic and model requests originate in the user's browser. There is no remote shell, build, agent, or project filesystem service.
- The guest is a constrained QuickJS environment. Packages needing native addons, unsupported Node APIs, arbitrary binaries, or unsupported lifecycle behavior will not work. Shell compatibility is a small subset, not a Linux terminal. Long guest executions can block UI rendering.
- Browser JavaScript is not a security boundary against hostile project code. Only open trusted projects. Browser-managed OS files and native tools are not available.
- Direct provider requests may fail if the provider does not permit CORS. Users can configure a compatible endpoint and their own API key; keys are stored locally in the browser. API credentials should only be entered on a deployment the user trusts.
- Server-only OpenCode features such as server plugins, remote account access, provider discovery from server credentials, PTYs, and server-side persistence are not available in this port.

## Reproduction, deployment, and licensing

Install the repository's pinned Bun version, run `bun install --frozen-lockfile`, then use `bun run dev` or `bun run build` from `packages/app`. Run `bun run typecheck`, `bun run typecheck:e2e`, and `bun run test:e2e -- browser-port.spec.ts` there for the browser port checks. Set `PLAYWRIGHT_BASE_URL` to an HTTPS deployment URL to run the same E2E test against production without starting a local server.

Cloudflare Pages configuration is in `packages/app/wrangler.toml`; `_redirects` provides SPA fallback and `_headers` applies isolation, security, and cache headers. The GitHub workflow builds, tests, and deploys the `browser-port` production branch. Configure repository Actions secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` to enable future automated deploys; no credentials are committed or copied into this repository.

OpenCode is MIT-licensed; retain its existing notices. NodeBrowser and `fflate` are MIT-licensed direct dependencies. `esbuild-wasm` is used for the browser bundle path. Do not add StackBlitz WebContainers or BrowserPod runtime code without the required commercial authorization. Runtime package notices and upstream licenses remain included with dependencies.
