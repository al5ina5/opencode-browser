type Provider = {
  providerID: string
  baseURL: string
  apiKey?: string
  headers?: Record<string, string>
}

type ChatMessage = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }
type ToolCall = { id: string; name: string; arguments: string }

const definitions = [
  { type: "function", function: { name: "list_files", description: "List project files recursively.", parameters: { type: "object", properties: { path: { type: "string", description: "Optional path relative to the project root." } }, additionalProperties: false } } },
  { type: "function", function: { name: "read_file", description: "Read a UTF-8 text file from the project.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } },
  { type: "function", function: { name: "write_file", description: "Create or replace a project file.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false } } },
  { type: "function", function: { name: "edit_file", description: "Replace one exact, unique text range in a project file.", parameters: { type: "object", properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" } }, required: ["path", "find", "replace"], additionalProperties: false } } },
  { type: "function", function: { name: "run_command", description: "Run a shell command in the project directory.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false } } },
  { type: "function", function: { name: "install_dependencies", description: "Install package.json dependencies from the public npm registry.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "build_project", description: "Build the current JavaScript project using the browser runtime's Vite subset.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "start_preview", description: "Start a browser preview of the current JavaScript project.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
]

const pending = new Map<string, (value: { ok: boolean; output: string }) => void>()
const controllers = new Map<string, AbortController>()

self.addEventListener("message", (raw: MessageEvent) => {
  const message = raw.data
  if (message?.type === "tool-result") {
    pending.get(message.requestID)?.(message.result)
    pending.delete(message.requestID)
  }
  if (message?.type === "cancel") {
    controllers.get(message.id)?.abort()
  }
  if (message?.type === "start") void run(message)
})

async function callTool(id: string, assistantMessageID: string, callID: string, name: string, input: Record<string, unknown>, signal: AbortSignal) {
  const requestID = crypto.randomUUID()
  const result = new Promise<{ ok: boolean; output: string }>((resolve) => pending.set(requestID, resolve))
  self.postMessage({ type: "tool-request", id, requestID, assistantMessageID, callID, name, input })
  signal.addEventListener("abort", () => {
    pending.get(requestID)?.({ ok: false, output: "Stopped" })
    pending.delete(requestID)
  }, { once: true })
  return result
}

function emit(id: string, type: string, data: Record<string, unknown>) {
  self.postMessage({ type: "event", id, eventType: type, data })
}

async function run(input: {
  id: string
  session: { id: string; directory: string; agent: string; model: { id: string; providerID: string } }
  provider?: Provider
  prompt: string
  history: Array<{ role: "user" | "assistant"; content: string }>
}) {
  const { id, session } = input
  const controller = new AbortController()
  controllers.set(id, controller)
  const model = session.model
  const started = Date.now()
  const assistantMessageID = `msg_${crypto.randomUUID().replaceAll("-", "")}`
  const location = { directory: session.directory }
  const url = input.provider?.baseURL?.replace(/\/$/, "")
  const endpoint = url ? `${url}/chat/completions` : ""
  let fullText = ""
  const toolContents: unknown[] = []
  let turnError: string | undefined
  emit(id, "session.step.started", { sessionID: session.id, assistantMessageID, agent: session.agent, model })
  emit(id, "session.text.started", { sessionID: session.id, assistantMessageID, ordinal: 0 })

  try {
    if (!input.provider || !endpoint) throw new Error("Configure an OpenAI-compatible provider in OpenCode Settings before sending a prompt.")
    const messages: ChatMessage[] = [
      { role: "system", content: "You are OpenCode, an AI coding agent running locally in the user's browser. Work only within the given project. Use tools for file changes and code execution; never claim a tool ran unless its result confirms it. Ask before editing files, running commands, installing dependencies, building, or starting a preview because the user will approve those actions in the app." },
      ...input.history.map((item) => ({ role: item.role, content: item.content } as ChatMessage)),
      { role: "user", content: input.prompt },
    ]
    const maxSteps = 12

    for (let step = 0; step < maxSteps; step++) {
      if (controller.signal.aborted) throw new DOMException("Request stopped", "AbortError")
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(input.provider.apiKey ? { Authorization: `Bearer ${input.provider.apiKey}` } : {}),
          ...input.provider.headers,
        },
        body: JSON.stringify({ model: model.id, messages, tools: definitions, tool_choice: "auto", stream: true }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`Inference request failed (${response.status}): ${(await response.text()).slice(0, 800)}`)
      if (!response.body) throw new Error("The inference provider did not return a streaming response.")
      const calls = new Map<number, ToolCall>()
      let streamedText = ""
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffered = ""
      let done = false
      while (!done) {
        const next = await reader.read()
        done = next.done
        buffered += decoder.decode(next.value, { stream: !done })
        const lines = buffered.split("\n")
        buffered = lines.pop() ?? ""
        for (const line of lines) {
          const value = line.trim()
          if (!value.startsWith("data:")) continue
          const raw = value.slice(5).trim()
          if (!raw || raw === "[DONE]") continue
          let chunk: any
          try { chunk = JSON.parse(raw) } catch { continue }
          const delta = chunk.choices?.[0]?.delta
          if (typeof delta?.content === "string") {
            streamedText += delta.content
            fullText += delta.content
            emit(id, "session.text.delta", { sessionID: session.id, assistantMessageID, ordinal: 0, delta: delta.content })
          }
          for (const item of delta?.tool_calls ?? []) {
            const index = Number(item.index ?? 0)
            const current = calls.get(index) ?? { id: item.id ?? `call_${crypto.randomUUID()}`, name: "", arguments: "" }
            if (item.id) current.id = item.id
            if (item.function?.name) current.name += item.function.name
            if (item.function?.arguments) current.arguments += item.function.arguments
            calls.set(index, current)
          }
        }
      }
      const toolCalls = [...calls.values()]
      messages.push({
        role: "assistant",
        content: streamedText || null,
        ...(toolCalls.length ? { tool_calls: toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) } : {}),
      })
      if (!toolCalls.length) break

      for (const call of toolCalls) {
        let args: Record<string, unknown>
        try { args = JSON.parse(call.arguments || "{}") } catch { args = {} }
        emit(id, "session.tool.input.started", { sessionID: session.id, assistantMessageID, callID: call.id, name: call.name })
        emit(id, "session.tool.input.ended", { sessionID: session.id, assistantMessageID, callID: call.id, text: JSON.stringify(args) })
        const result = await callTool(id, assistantMessageID, call.id, call.name, args, controller.signal)
        toolContents.push({
          type: "tool", id: call.id, name: call.name, executed: result.ok,
          state: result.ok
            ? { status: "completed", input: args, content: [{ type: "text", text: result.output }], metadata: {} }
            : { status: "error", input: args, error: { type: "unknown", message: result.output }, content: [{ type: "text", text: result.output }], metadata: {} },
          time: { created: Date.now(), ran: Date.now(), completed: Date.now() },
        })
        if (result.ok) {
          emit(id, "session.tool.success", {
            sessionID: session.id,
            assistantMessageID,
            callID: call.id,
            content: [{ type: "text", text: result.output }],
            executed: true,
            metadata: {},
          })
        } else {
          emit(id, "session.tool.failed", {
            sessionID: session.id,
            assistantMessageID,
            callID: call.id,
            executed: false,
            content: [{ type: "text", text: result.output }],
            error: { type: "unknown", message: result.output },
            metadata: {},
          })
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: result.output })
      }
    }
  } catch (error) {
    turnError = error instanceof Error ? error.message : String(error)
  } finally {
    emit(id, "session.text.ended", { sessionID: session.id, assistantMessageID, ordinal: 0, text: fullText })
    if (turnError) {
      emit(id, "session.step.failed", {
        sessionID: session.id,
        assistantMessageID,
        error: { type: "unknown", message: turnError },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      if (!fullText) {
        fullText = `Agent error: ${turnError}`
        emit(id, "session.text.delta", { sessionID: session.id, assistantMessageID, ordinal: 0, delta: fullText })
        emit(id, "session.text.ended", { sessionID: session.id, assistantMessageID, ordinal: 0, text: fullText })
      }
    } else {
      emit(id, "session.step.ended", {
        sessionID: session.id,
        assistantMessageID,
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    }
    self.postMessage({ type: "complete", id, assistantMessageID, text: fullText, tools: toolContents, agent: session.agent, model, started, error: turnError })
    controllers.delete(id)
  }
}
