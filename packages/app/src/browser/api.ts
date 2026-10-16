import type { BrowserMessage, BrowserSession, InferenceProvider } from "./runtime"
import { browserRuntime } from "./runtime"
import { readValue, writeValue, deleteValue } from "./storage"

type Subscriber = { controller: ReadableStreamDefaultController<Uint8Array>; signal?: AbortSignal; timer?: ReturnType<typeof setInterval> }
type PendingPermission = { resolve: (allowed: boolean) => void; sessionID: string; action: string }
type AgentWorker = Worker & { __runID?: string }

const sessions = new Map<string, BrowserSession>()
const workers = new Map<string, AgentWorker>()
const subscribers = new Set<Subscriber>()
const pendingPermissions = new Map<string, PendingPermission>()
const allowAlways = new Set<string>()
let eventCount = 0
let initialized: Promise<void> | undefined

const now = () => Date.now()
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`

async function initialize() {
  initialized ??= (async () => {
    await browserRuntime.ready()
    const values = await browserRuntime.sessions()
    values.forEach((session) => sessions.set(session.id, session))
  })()
  await initialized
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } })
}

function error(message: string, status = 400) {
  return json({ _tag: "InvalidRequestError", message }, status)
}

function projectShape(project: { id: string; name: string; directory: string; created: number }) {
  return { id: project.id, worktree: project.directory, name: project.name, time: { created: project.created, updated: project.created }, sandboxes: [] }
}

function sessionShape(session: BrowserSession) {
  return {
    id: session.id,
    projectID: session.projectID,
    agent: session.agent,
    model: { id: session.model.id, providerID: session.model.providerID },
    directory: session.directory,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: session.time,
    title: session.title,
    location: { directory: session.directory },
  }
}

function event(name: string, data: Record<string, unknown>, location?: { directory: string }) {
  const value = {
    id: id("evt"),
    created: now(),
    type: name,
    data,
    ...(location ? { location } : {}),
  }
  eventCount++
  const frame = new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)
  for (const subscriber of [...subscribers]) {
    try { subscriber.controller.enqueue(frame) } catch { subscribers.delete(subscriber) }
  }
}

function sse(signal?: AbortSignal) {
  const encoder = new TextEncoder()
  let subscriber: Subscriber
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      subscriber = { controller, signal }
      subscribers.add(subscriber)
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "evt_browser_connected", created: now(), type: "server.connected", data: {} })}\n\n`))
      subscriber.timer = setInterval(() => {
        try { controller.enqueue(encoder.encode(": keepalive\n\n")) } catch { remove() }
      }, 20_000)
      signal?.addEventListener("abort", remove, { once: true })
    },
    cancel() { remove() },
  })
  function remove() {
    if (!subscriber) return
    subscribers.delete(subscriber)
    if (subscriber.timer) clearInterval(subscriber.timer)
    signal?.removeEventListener("abort", remove)
    try { subscriber.controller.close() } catch {}
  }
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } })
}

async function requestBody(request: Request, init?: RequestInit) {
  const value = init?.body ?? (request.method === "GET" ? undefined : await request.clone().text())
  if (!value) return {}
  if (typeof value === "string") return JSON.parse(value || "{}")
  if (value instanceof Blob) return JSON.parse(await value.text())
  return {}
}

function queryDirectory(url: URL, fallback = "/home/projects/workspace") {
  return url.searchParams.get("directory") ?? url.searchParams.get("location[directory]") ?? fallback
}

async function resolvePermission(session: BrowserSession, requestID: string, reply: string) {
  const pending = pendingPermissions.get(requestID)
  if (!pending) return false
  pendingPermissions.delete(requestID)
  const allowed = reply === "once" || reply === "always"
  if (reply === "always") allowAlways.add(`${pending.sessionID}:${pending.action}`)
  pending.resolve(allowed)
  event("permission.v2.replied", { sessionID: session.id, requestID, reply }, { directory: session.directory })
  return true
}

async function requestToolPermission(session: BrowserSession, call: { requestID: string; callID: string; assistantMessageID: string; name: string; input: Record<string, unknown> }) {
  const action = call.name === "write_file" || call.name === "edit_file" ? "file.write" : call.name === "run_command" ? "shell.exec" : call.name === "install_dependencies" ? "npm.install" : call.name === "build_project" ? "project.build" : "preview.start"
  if (allowAlways.has(`${session.id}:${action}`)) return true
  const resource = typeof call.input.path === "string" ? call.input.path : typeof call.input.command === "string" ? call.input.command : session.directory
  const permissionID = id("perm")
  event("permission.v2.asked", {
    id: permissionID,
    sessionID: session.id,
    action,
    resources: [resource],
    metadata: {},
    source: { type: "tool", messageID: call.assistantMessageID, callID: call.callID },
  }, { directory: session.directory })
  return new Promise<boolean>((resolve) => {
    pendingPermissions.set(permissionID, { resolve, sessionID: session.id, action })
  })
}

function toolNeedsPermission(name: string) {
  return name !== "list_files" && name !== "read_file"
}

function attachWorker(session: BrowserSession, workerID: string, provider: InferenceProvider | undefined, prompt: string, history: BrowserMessage[]) {
  const worker = new Worker(new URL("./agent.worker.ts", import.meta.url), { type: "module" }) as AgentWorker
  worker.__runID = workerID
  workers.set(session.id, worker)
  const previous: Array<{ role: "user" | "assistant"; content: string }> = []
  for (const item of history) {
    if (item.type === "user" && item.text) previous.push({ role: "user", content: item.text })
    if (item.type === "assistant") {
      for (const part of item.content) {
        if (part.type === "text" && typeof part.text === "string" && part.text) previous.push({ role: "assistant", content: part.text })
      }
    }
  }
  worker.addEventListener("message", async (message: MessageEvent) => {
    const value = message.data
    if (value.id !== workerID) return
    if (value.type === "event") {
      event(value.eventType, value.data, { directory: session.directory })
      return
    }
    if (value.type === "tool-request") {
      event("session.tool.called", {
        sessionID: session.id,
        assistantMessageID: value.assistantMessageID,
        callID: value.callID,
        input: value.input,
        executed: true,
      }, { directory: session.directory })
      const approve = !toolNeedsPermission(value.name) || await requestToolPermission(session, value)
      if (!approve) {
        worker.postMessage({ type: "tool-result", requestID: value.requestID, result: { ok: false, output: "The user denied this operation." } })
        return
      }
      try {
        const output = await browserRuntime.runTool(value.name, value.input, session.directory)
        worker.postMessage({ type: "tool-result", requestID: value.requestID, result: { ok: true, output } })
      } catch (cause) {
        worker.postMessage({ type: "tool-result", requestID: value.requestID, result: { ok: false, output: cause instanceof Error ? cause.message : String(cause) } })
      }
      return
    }
    if (value.type === "complete") {
      const messages = await browserRuntime.messages(session.id)
      const assistant: BrowserMessage = {
        id: value.assistantMessageID,
        type: "assistant",
        agent: session.agent,
        model: session.model,
        content: [...(value.tools ?? []), { id: `${value.assistantMessageID}:text:0`, type: "text", text: value.text }],
        time: { created: now(), completed: now() },
      }
      await browserRuntime.saveMessages(session.id, [...messages, assistant])
      session.time.updated = now()
      await browserRuntime.saveSession(session)
      sessions.set(session.id, session)
      event("session.updated", { info: sessionShape(session) }, { directory: session.directory })
      event("session.status", { sessionID: session.id, status: { type: "idle" } }, { directory: session.directory })
      event("session.idle", { sessionID: session.id }, { directory: session.directory })
      worker.terminate()
      workers.delete(session.id)
    }
  })
  worker.addEventListener("error", (error) => {
    console.error("Browser agent worker failed", error)
  })
  worker.postMessage({ type: "start", id: workerID, session, provider, prompt, history: previous })
}

async function dispatch(request: Request, init?: RequestInit): Promise<Response> {
  await initialize()
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/$/, "") || "/"
  const method = (init?.method ?? request.method).toUpperCase()

  if (path === "/api/health") return json({ pid: 1, version: "1.19.2" })
  if (path === "/api/event") return sse(init?.signal ?? request.signal)
  if (path === "/api/location") {
    const directory = queryDirectory(url)
    const project = await browserRuntime.projectsAt(directory)
    return json({ directory, project: { id: project?.id ?? "project_browser_workspace", directory: project?.directory ?? directory } })
  }
  if (path === "/api/path" || path === "/path") return json({ directory: queryDirectory(url), home: "/home", worktree: "/home", state: "/home/.opencode/state", config: "/home/.opencode/config" })
  if (path === "/api/project" && method === "GET") return json((await browserRuntime.listProjects()).map(projectShape))
  if (path === "/api/project/current") {
    const project = await browserRuntime.projectsAt(queryDirectory(url))
    return json(project ? projectShape(project) : projectShape((await browserRuntime.listProjects())[0]!))
  }
  if (path === "/api/project/directories") return json([])

  if (path === "/api/global/config" || path === "/global/config" || path === "/api/config" || path === "/config") {
    const config = await readValue<Record<string, unknown>>("kv", "config") ?? { provider: {}, disabled_providers: [], model: undefined }
    if (method === "GET") return json(config)
    if (method === "PATCH" || method === "PUT" || method === "POST") {
      const body = await requestBody(request, init)
      const next = { ...config, ...(body.config && typeof body.config === "object" ? body.config : body) }
      await writeValue("kv", next, "config")
      return json(next)
    }
  }
  if (/^\/auth\/[^/]+$/.test(path) && (method === "PUT" || method === "DELETE")) {
    const providerID = decodeURIComponent(path.split("/").at(-1)!)
    if (method === "DELETE") {
      const provider = await browserRuntime.provider()
      if (provider?.providerID === providerID) await browserRuntime.configureProvider({ ...provider, apiKey: undefined })
      return new Response(null, { status: 204 })
    }
    const body = await requestBody(request, init)
    await browserRuntime.setProviderKey(providerID, String(body.auth?.key ?? ""))
    return json(true)
  }

  if (path === "/api/provider" || path === "/api/providers") {
    const provider = await browserRuntime.provider()
    if (!provider) return json({ location: { directory: queryDirectory(url), project: { id: "project_browser_workspace", directory: "/home/projects/workspace" } }, data: [] })
    return json({ location: { directory: queryDirectory(url), project: { id: "project_browser_workspace", directory: "/home/projects/workspace" } }, data: [{ id: provider.providerID, name: provider.name, api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: provider.baseURL, settings: {} }, request: { headers: provider.headers ?? {}, body: {} } }] })
  }
  if (path === "/api/provider/auth") return json({ data: [] })
  if (path === "/api/model" || path === "/api/models") {
    const provider = await browserRuntime.provider()
    const data = provider ? Object.entries(provider.models).map(([id, model]) => ({
      id,
      providerID: provider.providerID,
      name: model.name,
      api: { id: "openai-compatible", type: "aisdk", package: "@ai-sdk/openai-compatible", url: provider.baseURL, settings: {} },
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      request: { headers: provider.headers ?? {}, body: {} },
      variants: [],
      time: { released: now() },
      cost: [],
      status: "active",
      enabled: true,
      limit: { context: 128000, output: 8192 },
    })) : []
    return json({ location: { directory: queryDirectory(url), project: { id: "project_browser_workspace", directory: "/home/projects/workspace" } }, data })
  }
  if (path === "/api/model/default") {
    const provider = await browserRuntime.provider()
    const first = provider && Object.keys(provider.models)[0]
    return json({ data: provider && first ? { providerID: provider.providerID, id: first } : undefined })
  }

  if (path === "/api/agent") {
    const data = [
      { id: "build", request: { settings: {}, headers: {}, body: {} }, system: "You are an AI coding agent.", description: "General purpose coding agent", mode: "primary", hidden: false, permissions: [{ action: "file.write", resource: "*", effect: "ask" }, { action: "shell.exec", resource: "*", effect: "ask" }] },
      { id: "plan", request: { settings: {}, headers: {}, body: {} }, description: "Plan changes without tools", mode: "primary", hidden: false, permissions: [] },
    ]
    return json({ location: { directory: queryDirectory(url), project: { id: "project_browser_workspace", directory: "/home/projects/workspace" } }, data })
  }
  if (path === "/api/command" || path === "/api/skill" || path === "/api/reference" || path === "/api/mcp" || path === "/api/mcp/resource" || path === "/api/lsp" || path === "/api/permission/request" || path === "/api/question/request") {
    return json({ location: { directory: queryDirectory(url), project: { id: "project_browser_workspace", directory: "/home/projects/workspace" } }, data: [] })
  }
  if (path === "/api/session/active") return json({ data: {} })

  if (path === "/api/fs/list" || path === "/api/file/list") {
    const directory = url.searchParams.get("location[directory]") ?? queryDirectory(url)
    const nodes = await browserRuntime.listDirectory(directory)
    return json({ location: { directory, project: { id: "project_browser_workspace", directory } }, data: nodes.map(({ name, type }) => ({ path: name, type })) })
  }
  if (path === "/api/fs/find" || path === "/api/file/find") {
    const directory = url.searchParams.get("location[directory]") ?? queryDirectory(url)
    const query = url.searchParams.get("location[query]") ?? ""
    const type = url.searchParams.get("location[type]")
    const found = (await browserRuntime.listFiles(directory)).filter((entry) => entry.path.toLowerCase().includes(query.toLowerCase()) && (!type || entry.type === type)).slice(0, 100)
    return json({ location: { directory, project: { id: "project_browser_workspace", directory } }, data: found })
  }
  const fileRead = path.match(/^\/api\/fs\/read\/(.+)$/)
  if (fileRead && method === "GET") {
    const file = decodeURIComponent(fileRead[1]!)
    const target = file.startsWith("/") ? file : `${queryDirectory(url)}/${file}`
    const value = await (await browserRuntime.ready()).fs.readFile(target, "utf8")
    return new Response(value, { headers: { "Content-Type": "text/plain; charset=utf-8" } })
  }

  if (path === "/api/session" && method === "GET") {
    const directory = url.searchParams.get("directory")
    const values = (await browserRuntime.sessions()).filter((session) => !directory || session.directory === directory)
    return json({ data: values.map(sessionShape), cursor: {} })
  }
  if (path === "/api/session" && method === "POST") {
    const body = await requestBody(request, init)
    const location = body.location?.directory ?? queryDirectory(url)
    const project = await browserRuntime.projectsAt(location)
    if (!project) return error(`No browser workspace exists at ${location}`, 404)
    const provider = await browserRuntime.provider()
    const firstModel = provider ? Object.keys(provider.models)[0] : undefined
    const model = body.model ?? { providerID: provider?.providerID ?? "openai", id: firstModel ?? "gpt-4o-mini" }
    const session: BrowserSession = {
      id: body.id ?? id("ses"), slug: `session-${Date.now()}`, projectID: project.id, directory: location,
      title: "New session", agent: body.agent ?? "build", model: { id: model.id, providerID: model.providerID },
      version: "1.19.2", time: { created: now(), updated: now() },
    }
    await browserRuntime.saveSession(session)
    sessions.set(session.id, session)
    await browserRuntime.saveMessages(session.id, [])
    event("session.created", { info: sessionShape(session) }, { directory: location })
    return json({ data: sessionShape(session) })
  }
  const sessionRoute = path.match(/^\/api\/session\/([^/]+)(?:\/(.*))?$/)
  if (sessionRoute) {
    const sessionID = decodeURIComponent(sessionRoute[1]!)
    const suffix = sessionRoute[2] ?? ""
    const session = sessions.get(sessionID)
    if (!session) return error(`Session not found: ${sessionID}`, 404)
    if (!suffix && method === "GET") return json({ data: sessionShape(session) })
    if (!suffix && method === "DELETE") {
      await deleteValue("sessions", sessionID)
      await deleteValue("messages", sessionID)
      sessions.delete(sessionID)
      event("session.deleted", { sessionID }, { directory: session.directory })
      return new Response(null, { status: 204 })
    }
    if (suffix === "message" && method === "GET") {
      const order = url.searchParams.get("order")
      const messages = await browserRuntime.messages(sessionID)
      const ordered = order === "desc" || url.searchParams.has("cursor") ? messages.slice().reverse() : messages
      const rawCursor = url.searchParams.get("cursor")
      const offset = rawCursor?.startsWith("browser:") ? Math.max(0, Number(rawCursor.slice("browser:".length)) || 0) : 0
      const limit = Math.max(0, Number(url.searchParams.get("limit")) || 0)
      const data = limit ? ordered.slice(offset, offset + limit) : ordered.slice(offset)
      const nextOffset = offset + data.length
      const cursor = limit && nextOffset < ordered.length ? { next: `browser:${nextOffset}` } : {}
      return json({ data, cursor })
    }
    if (suffix.startsWith("message/") && method === "GET") {
      const messageID = decodeURIComponent(suffix.slice("message/".length))
      const message = (await browserRuntime.messages(sessionID)).find((item) => item.id === messageID)
      return message ? json({ data: message }) : error(`Message not found: ${messageID}`, 404)
    }
    if (suffix.startsWith("message/") && method === "GET") {
      const messageID = decodeURIComponent(suffix.slice("message/".length))
      const message = (await browserRuntime.messages(sessionID)).find((item) => item.id === messageID)
      return message ? json({ data: message }) : error(`Message not found: ${messageID}`, 404)
    }
    if (suffix === "prompt" && method === "POST") {
      const body = await requestBody(request, init)
      const text = String(body.prompt?.text ?? body.text ?? "")
      const messages = await browserRuntime.messages(sessionID)
      const messageID = body.id ?? id("msg")
      const user: BrowserMessage = { id: messageID, type: "user", text, time: { created: now() } }
      await browserRuntime.saveMessages(sessionID, [...messages, user])
      if (session.title === "New session") session.title = text.trim().split(/\s+/).slice(0, 7).join(" ") || "New session"
      session.time.updated = now()
      if (body.prompt?.model) session.model = { id: body.prompt.model.modelID ?? body.prompt.model.id, providerID: body.prompt.model.providerID }
      if (body.prompt?.agent) session.agent = body.prompt.agent
      await browserRuntime.saveSession(session)
      sessions.set(sessionID, session)
      event("session.input.admitted", { sessionID, inputID: messageID, input: { type: "user", data: { text }, delivery: body.delivery ?? "steer" } }, { directory: session.directory })
      event("session.input.promoted", { sessionID, inputID: messageID }, { directory: session.directory })
      event("session.status", { sessionID, status: { type: "busy" } }, { directory: session.directory })
      const provider = await browserRuntime.provider()
      const workerID = id("run")
      attachWorker(session, workerID, provider, text, messages)
      return json({ data: { admittedSeq: 1, id: messageID, sessionID, prompt: { text }, delivery: body.delivery ?? "steer", timeCreated: now() } })
    }
    if (suffix === "interrupt" && method === "POST") {
      workers.get(sessionID)?.postMessage({ type: "cancel", id: workers.get(sessionID)?.__runID })
      return new Response(null, { status: 204 })
    }
    if (suffix === "permission" && method === "GET") return json({ data: [] })
    const permissionReply = suffix.match(/^permission\/([^/]+)\/reply$/)
    if (permissionReply && method === "POST") {
      const body = await requestBody(request, init)
      const ok = await resolvePermission(session, decodeURIComponent(permissionReply[1]!), String(body.reply ?? "reject"))
      return ok ? new Response(null, { status: 204 }) : error("Permission request not found", 404)
    }
    if (suffix === "agent" && method === "POST") {
      const body = await requestBody(request, init)
      session.agent = String(body.agent ?? session.agent)
      await browserRuntime.saveSession(session)
      return new Response(null, { status: 204 })
    }
    if (suffix === "model" && method === "POST") {
      const body = await requestBody(request, init)
      session.model = { id: body.model?.id ?? session.model.id, providerID: body.model?.providerID ?? session.model.providerID }
      await browserRuntime.saveSession(session)
      return new Response(null, { status: 204 })
    }
  }

  if (path.startsWith("/api/")) return error(`Browser OpenCode API route not implemented: ${method} ${path}`, 404)
  return error(`Browser OpenCode API route not implemented: ${method} ${path}`, 404)
}

export const browserFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = input instanceof Request ? input : new Request(input, init)
  const url = new URL(request.url)
  if (!url.hostname.endsWith("opencode-browser.local")) return fetch(input, init)
  try {
    return await dispatch(request, init)
  } catch (cause) {
    console.error("Browser OpenCode API request failed", { url: url.pathname, cause })
    return error(cause instanceof Error ? cause.message : String(cause), 500)
  }
}) as unknown as typeof fetch

export function createProject(name: string) {
  return browserRuntime.createProject(name)
}

export function importProject(name: string, bytes: Uint8Array) {
  return browserRuntime.importProject(name, bytes)
}

export function exportProject(directory: string) {
  return browserRuntime.exportProject(directory)
}

export function browserConfig(): Promise<InferenceProvider | undefined> {
  return browserRuntime.provider()
}

export function configureBrowserProvider(provider: InferenceProvider) {
  return browserRuntime.configureProvider(provider)
}
