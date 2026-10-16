const PREFIX = "/__bn_preview/"

self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()))
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()))
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url)
  if (!url.pathname.startsWith(PREFIX)) return
  event.respondWith((async () => {
    const [, , rawPort, ...segments] = url.pathname.split("/")
    const port = Number(rawPort)
    if (!Number.isInteger(port)) return new Response("Invalid preview port", { status: 400 })
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
    const client = windows.find((windowClient) => windowClient.frameType === "top-level") ?? windows[0]
    if (!client) return new Response("Preview client is not available", { status: 503 })
    const body = event.request.method === "GET" || event.request.method === "HEAD" ? undefined : await event.request.text()
    return new Promise((resolve) => {
      const channel = new MessageChannel()
      const id = crypto.randomUUID()
      const timeout = setTimeout(() => resolve(new Response("Preview runtime did not respond", { status: 504 })), 15_000)
      channel.port1.onmessage = (message) => {
        clearTimeout(timeout)
        const value = message.data
        resolve(new Response(value.body ?? "", { status: value.status ?? 200, headers: value.headers ?? {} }))
      }
      client.postMessage({ type: "bn-http-request", id, port, method: event.request.method, path: `/${segments.join("/")}${url.search}`, headers: Object.fromEntries(event.request.headers), body }, [channel.port2])
    })
  })())
})
