import { NodeBrowser } from "@foisal/nodebrowser"
import { zipSync } from "fflate"
import { listValues, readValue, writeValue } from "./storage"

export type BrowserProject = {
  id: string
  name: string
  directory: string
  created: number
}

export type InferenceProvider = {
  providerID: string
  name: string
  baseURL: string
  apiKey?: string
  headers?: Record<string, string>
  models: Record<string, { name: string }>
}

export type BrowserSession = {
  id: string
  slug: string
  projectID: string
  directory: string
  title: string
  agent: string
  model: { id: string; providerID: string }
  version: string
  time: { created: number; updated: number }
}

export type BrowserMessage =
  | { id: string; type: "user"; text: string; time: { created: number } }
  | {
      id: string
      type: "assistant"
      agent: string
      model: { id: string; providerID: string }
      content: Array<{ id: string; type: "text"; text: string } | Record<string, unknown>>
      time: { created: number; completed?: number }
    }

export class BrowserRuntime {
  private instance: NodeBrowser | undefined
  private readyPromise: Promise<NodeBrowser> | undefined
  private projectsCache: BrowserProject[] = []
  private detachServiceWorker: (() => void) | undefined

  ready() {
    this.readyPromise ??= this.boot()
    return this.readyPromise
  }

  private async boot() {
    if ("serviceWorker" in navigator && location.protocol !== "file:") {
      try {
        await navigator.serviceWorker.register("/browser-preview-sw.js", { scope: "/" })
        await navigator.serviceWorker.ready
        if (!navigator.serviceWorker.controller) {
          await Promise.race([
            new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true })),
            new Promise<void>((resolve) => setTimeout(resolve, 1500)),
          ])
        }
      } catch (error) {
        this.emit("runtime-error", error)
      }
    }
    // NodeBrowser 1.3.3's worker kernel overflows its stack when running guest JS scripts.
    // The OpenCode agent loop still runs in agent.worker.ts; use the working same-thread guest runtime.
    const scope = globalThis as typeof globalThis & { __BN_KERNEL_THREAD__?: boolean }
    const previousKernelThread = scope.__BN_KERNEL_THREAD__
    scope.__BN_KERNEL_THREAD__ = true
    let runtime: NodeBrowser
    try {
      runtime = await NodeBrowser.boot({ wasmUrl: new URL("/browsernode_kernel.js", location.href).href, persist: true, previewBase: "/__bn_preview" })
    } finally {
      if (previousKernelThread === undefined) delete scope.__BN_KERNEL_THREAD__
      else scope.__BN_KERNEL_THREAD__ = previousKernelThread
    }
    this.instance = runtime
    this.detachServiceWorker = runtime.attachServiceWorkerBridge("/__bn_preview")
    await runtime.fs.mkdir("/home/projects", { recursive: true })
    await runtime.fs.mkdir("/home/projects/workspace", { recursive: true })
    this.projectsCache = await readValue<BrowserProject[]>("kv", "projects") ?? []
    const workspace = this.projectsCache.find((item) => item.directory === "/home/projects/workspace")
    if (!workspace) {
      this.projectsCache.push({ id: "project_browser_workspace", name: "workspace", directory: "/home/projects/workspace", created: Date.now() })
      await this.persistProjects()
    }
    await runtime.fs.mkdir("/home/projects/workspace", { recursive: true })
    runtime.on("install-progress", (progress) => this.emit("install-progress", progress))
    runtime.on("server-ready", (port, url) => this.emit("server-ready", { port, url }))
    runtime.on("error", (error) => this.emit("runtime-error", error))
    return runtime
  }

  private listeners = new Set<(name: string, value: unknown) => void>()
  on(listener: (name: string, value: unknown) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private emit(name: string, value: unknown) {
    for (const listener of this.listeners) listener(name, value)
  }

  async capabilities() {
    const runtime = await this.ready()
    return { worker: runtime.worker, sabStdio: runtime.sabStdio, runtime: runtime.runtime, isolated: globalThis.crossOriginIsolated === true }
  }

  async listProjects() {
    await this.ready()
    const projects = await readValue<BrowserProject[]>("kv", "projects")
    this.projectsCache = projects ?? this.projectsCache
    return this.projectsCache.slice()
  }

  async createProject(rawName: string) {
    const name = rawName.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || `project-${Date.now()}`
    const directory = `/home/projects/${name}`
    const runtime = await this.ready()
    if (await runtime.fs.exists(directory)) throw new Error(`A project named ${name} already exists`)
    await runtime.fs.mkdir(directory, { recursive: true })
    const project: BrowserProject = { id: `project_${crypto.randomUUID().replaceAll("-", "")}`, name, directory, created: Date.now() }
    this.projectsCache = [project, ...await this.listProjects()]
    await this.persistProjects()
    return project
  }

  private async persistProjects() {
    await writeValue("kv", this.projectsCache, "projects")
  }

  async importProject(name: string, bytes: Uint8Array) {
    const project = await this.createProject(name)
    const runtime = await this.ready()
    const result = await runtime.importZip(bytes, project.directory)
    return { project, files: result.files }
  }

  async exportProject(directory: string) {
    const runtime = await this.ready()
    const files: Record<string, Uint8Array> = {}
    const visit = async (path: string, relative: string) => {
      for (const name of await runtime.fs.readdir(path)) {
        if (name === "node_modules" || name === ".git" || name === ".next") continue
        const child = `${path}/${name}`
        const rel = relative ? `${relative}/${name}` : name
        const stat = await runtime.fs.stat(child)
        if (stat.isDirectory()) await visit(child, rel)
        else files[rel] = await runtime.fs.readFile(child, "buffer")
      }
    }
    await visit(directory, "")
    return zipSync(files)
  }

  async projectsAt(directory: string) {
    const projects = await this.listProjects()
    return projects.find((project) => directory === project.directory || directory.startsWith(project.directory + "/")) ?? projects[0]
  }

  async listDirectory(directory: string) {
    const runtime = await this.ready()
    if (!(await runtime.fs.exists(directory))) return []
    const names = await runtime.fs.readdir(directory)
    return Promise.all(names.map(async (name) => {
      const path = `${directory}/${name}`
      const stat = await runtime.fs.stat(path)
      return { name, type: stat.isDirectory() ? "directory" as const : "file" as const, path }
    }))
  }

  async listFiles(directory: string) {
    const runtime = await this.ready()
    const results: Array<{ path: string; type: "file" | "directory" }> = []
    const visit = async (path: string) => {
      if (!(await runtime.fs.exists(path))) return
      for (const name of await runtime.fs.readdir(path)) {
        if (name === "node_modules" || name === ".git" || name === ".next") continue
        const child = `${path}/${name}`
        const stat = await runtime.fs.stat(child)
        results.push({ path: name, type: stat.isDirectory() ? "directory" : "file" })
        if (stat.isDirectory()) await visit(child)
      }
    }
    await visit(directory)
    return results
  }

  async messages(sessionID: string) {
    const items = await readValue<{ sessionID: string; data: BrowserMessage[] }>("messages", sessionID)
    return items?.data ?? []
  }

  async saveMessages(sessionID: string, data: BrowserMessage[]) {
    await writeValue("messages", { sessionID, data })
  }

  async sessions() {
    return listValues<BrowserSession>("sessions")
  }

  async saveSession(session: BrowserSession) {
    await writeValue("sessions", session)
  }

  async provider() {
    return readValue<InferenceProvider>("kv", "inference-provider")
  }

  async configureProvider(provider: InferenceProvider) {
    await writeValue("kv", provider, "inference-provider")
  }

  async setProviderKey(providerID: string, apiKey: string) {
    const provider = await this.provider()
    if (provider?.providerID !== providerID) return
    await this.configureProvider({ ...provider, apiKey })
  }

  async runTool(name: string, input: Record<string, unknown>, cwd: string) {
    const runtime = await this.ready()
    const relative = typeof input.path === "string" ? input.path.replace(/^\/+/, "") : ""
    const target = relative ? safeProjectPath(cwd, relative) : cwd
    switch (name) {
      case "list_files": {
        const directory = typeof input.path === "string" ? target : cwd
        return JSON.stringify(await this.listFiles(directory), null, 2)
      }
      case "read_file":
        return runtime.fs.readFile(target, "utf8")
      case "write_file":
        if (typeof input.content !== "string") throw new Error("write_file requires string content")
        await runtime.fs.mkdir(target.slice(0, target.lastIndexOf("/")) || cwd, { recursive: true })
        await runtime.fs.writeFile(target, input.content)
        return `Wrote ${target}`
      case "edit_file": {
        const source = await runtime.fs.readFile(target, "utf8")
        const find = String(input.find ?? "")
        const replace = String(input.replace ?? "")
        if (!find) throw new Error("edit_file requires non-empty find text")
        const at = source.indexOf(find)
        if (at < 0) throw new Error(`Text not found in ${target}`)
        if (source.indexOf(find, at + find.length) >= 0) throw new Error("Text occurs more than once; provide a more specific match")
        await runtime.fs.writeFile(target, source.slice(0, at) + replace + source.slice(at + find.length))
        return `Updated ${target}`
      }
      case "run_command": {
        const command = String(input.command ?? "")
        if (!command.trim()) throw new Error("run_command requires a command")
        const proc = await runtime.spawn("sh", ["-c", command], { cwd })
        let output = ""
        for await (const chunk of proc.output) {
          output += String(chunk)
          this.emit("terminal-output", { cwd, output: String(chunk) })
        }
        const code = await proc.exit
        if (code !== 0) throw new Error(`${output}${output ? "\n" : ""}Process exited with code ${code}`)
        return `${output}${output ? "\n" : ""}Process exited with code ${code}`
      }
      case "install_dependencies": {
        await runtime.install([], cwd, { onLog: (line) => this.emit("terminal-output", { cwd, output: line + "\n" }) })
        return "Dependencies installed"
      }
      case "build_project": {
        const result = await runtime.viteBuild(cwd)
        return JSON.stringify(result, null, 2)
      }
      case "start_preview": {
        const result = await runtime.viteDev(cwd)
        this.emit("preview-ready", { cwd, url: result.url, port: result.port })
        return JSON.stringify(result, null, 2)
      }
      default:
        throw new Error(`Tool is not supported by this browser runtime: ${name}`)
    }
  }

  async exportSnapshot() {
    return (await this.ready()).exportSnapshot()
  }

  teardown() {
    this.detachServiceWorker?.()
    this.detachServiceWorker = undefined
    this.instance?.teardown()
    this.instance = undefined
    this.readyPromise = undefined
  }
}

function safeProjectPath(root: string, relative: string) {
  const parts = root.split("/").filter(Boolean)
  for (const part of relative.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue
    if (part === "..") {
      if (parts.length <= 2) throw new Error("Path escapes the project directory")
      parts.pop()
      continue
    }
    parts.push(part)
  }
  const result = `/${parts.join("/")}`
  if (!result.startsWith(root.replace(/\/$/, "") + "/") && result !== root) throw new Error("Path escapes the project directory")
  return result
}

export const browserRuntime = new BrowserRuntime()
