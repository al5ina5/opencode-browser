import { expect, test } from "@playwright/test"

const inferenceURL = "https://mock-inference.test/v1/chat/completions"

const projectFiles = [
  {
    name: "write_file",
    arguments: {
      path: "package.json",
      content: JSON.stringify({
        name: "browser-react-smoke",
        version: "1.0.0",
        type: "module",
        scripts: { dev: "vite --host 0.0.0.0", build: "vite build" },
        dependencies: { react: "19.1.0", "react-dom": "19.1.0", vite: "6.3.5" },
      }, null, 2),
    },
  },
  {
    name: "write_file",
    arguments: {
      path: "index.html",
      content: '<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Browser React Preview</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>',
    },
  },
  {
    name: "write_file",
    arguments: {
      path: "src/main.jsx",
      content: 'import React from "react"; import { createRoot } from "react-dom/client"; function App() { return <main><h1>Browser React app is live</h1><p>Built inside the browser workspace.</p></main> } createRoot(document.getElementById("root")).render(<App />);',
    },
  },
  {
    name: "write_file",
    arguments: { path: "shell-check.js", content: 'console.log("browser-shell-ok")' },
  },
  { name: "install_dependencies", arguments: {} },
  { name: "run_command", arguments: { command: "node shell-check.js" } },
  { name: "build_project", arguments: {} },
  { name: "start_preview", arguments: {} },
]

function toolChunk(index: number) {
  const call = projectFiles[index]!
  return {
    choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } }],
  }
}

function responseBody(value: unknown) {
  return `data: ${JSON.stringify(value)}\n\ndata: [DONE]\n\n`
}

test("OpenCode runs the agent and a React workspace in the browser", async ({ page, context }) => {
  test.setTimeout(240_000)
  let inferenceRequests = 0

  await context.route("https://mock-inference.test/**", async (route) => {
    const request = route.request()
    if (request.method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "authorization, content-type",
        },
      })
      return
    }

    const body = request.postDataJSON() as { model?: string; messages?: Array<{ role: string; content?: string }> }
    expect(body.model).toBe("mock-model")
    expect(request.headers().authorization).toBe("Bearer playwright-test-token")
    inferenceRequests++
    const toolMessages = body.messages?.filter((item) => item.role === "tool") ?? []
    const toolsUsed = toolMessages.length
    const lastUser = [...(body.messages ?? [])].reverse().find((item) => item.role === "user")?.content ?? ""
    const toolOutput = toolMessages.map((item) => item.content ?? "")
    const successfulWorkspace =
      toolMessages.length === projectFiles.length &&
      toolOutput.some((value) => value.includes("browser-shell-ok")) &&
      !toolOutput.some((value) => /\bfailed\b|Process exited with code [1-9]|Maximum call stack/i.test(value))
    const chunk = lastUser.includes("second conversation")
      ? { choices: [{ delta: { content: "Second conversation stayed separate." } }] }
      : toolsUsed < projectFiles.length
        ? toolChunk(toolsUsed)
        : { choices: [{ delta: { content: successfulWorkspace ? "The React app was installed, built, and started in the browser." : `Workspace execution failed: ${toolOutput.filter((value) => /\bfailed\b|Process exited with code [1-9]|Maximum call stack/i.test(value)).join("; ")}` } }] }

    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "access-control-allow-origin": "*",
        "cache-control": "no-cache",
      },
      body: responseBody(chunk),
    })
  })

  const consoleErrors: string[] = []
  const failedRequests: string[] = []
  const previewResponses: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("pageerror", (error) => consoleErrors.push(error.message))
  page.on("requestfailed", (request) => failedRequests.push(`${request.url()} ${request.failure()?.errorText ?? ""}`))
  page.on("response", (response) => {
    if (response.url().includes("/__bn_preview/")) previewResponses.push(`${response.status()} ${response.url()}`)
  })
  page.on("dialog", async (dialog) => {
    if (dialog.type() === "prompt") await dialog.accept("browser-react-smoke")
  })

  await page.goto("/")
  const runtime = page.getByRole("button", { name: "Browser runtime" })
  await expect(runtime).toContainText("Ready")
  await expect(runtime).toHaveAttribute("title", /agent worker/)
  expect(await page.evaluate(() => crossOriginIsolated && !!SharedArrayBuffer)).toBe(true)

  await runtime.click()
  await page.getByRole("button", { name: "Configure model" }).click()
  const providerFields = page.locator("form input")
  for (const [index, value] of [
    "mock",
    "Playwright mock",
    "https://mock-inference.test/v1",
    "playwright-test-token",
    "mock-model",
    "Mock model",
  ].entries()) await providerFields.nth(index).fill(value)
  await page.getByRole("button", { name: "Save" }).click()
  await expect(page.getByRole("button", { name: "Browser runtime" })).toContainText("Ready")

  await page.getByRole("button", { name: "Browser runtime" }).click()
  await page.getByRole("button", { name: "New project" }).click()
  await expect(page).toHaveURL(/new-session\?draftId=/)
  const prompt = page.getByRole("textbox", { name: "Prompt" })
  await prompt.fill("Create and run a small React application in this project.")
  await page.getByRole("button", { name: "Send" }).click()

  for (let index = 0; index < projectFiles.length; index++) {
    const permission = page.getByRole("button", { name: "Allow once" })
    await expect(permission).toBeVisible({ timeout: 60_000 })
    await permission.click()
    if (index < projectFiles.length - 1) {
      const next = projectFiles[index + 1]!
      const nextAction = next.name === "write_file" ? String(next.arguments.path) : next.name
      await expect(page.getByText(nextAction, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
    } else await expect(permission).toBeHidden({ timeout: 60_000 })
  }

  await expect(page.getByText("The React app was installed, built, and started in the browser.")).toBeVisible({ timeout: 60_000 })
  await expect(page.locator("pre").filter({ hasText: "browser-shell-ok" })).toBeVisible()
  const preview = page.frameLocator("iframe[title='Project preview']")
  await expect(preview.getByRole("heading", { name: "Browser React app is live" })).toBeVisible({ timeout: 60_000 })
  expect(previewResponses.some((response) => response.includes("bundle.js") && response.startsWith("200 "))).toBe(true)
  expect(inferenceRequests).toBeGreaterThanOrEqual(projectFiles.length + 1)

  const persistedText = () => page.evaluate(() => new Promise<string[]>((resolve, reject) => {
    const request = indexedDB.open("opencode-browser", 1)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const tx = request.result.transaction("messages", "readonly")
      const messages = tx.objectStore("messages").getAll()
      tx.oncomplete = () => resolve((messages.result as any[]).flatMap((entry) => entry.data.flatMap((message: any) =>
        message.type === "assistant" ? message.content.filter((part: any) => part.type === "text").map((part: any) => part.text) : [],
      )))
      tx.onerror = () => reject(tx.error)
    }
  }))
  await expect.poll(persistedText, { timeout: 10_000 }).toContain("The React app was installed, built, and started in the browser.")
  await page.reload()
  await expect(page.getByText("The React app was installed, built, and started in the browser.")).toBeVisible({ timeout: 10_000 })
  await page.getByRole("button", { name: "New session" }).click()
  await expect(page).toHaveURL(/new-session\?draftId=/)
  await page.getByRole("textbox", { name: "Prompt" }).fill("Start a second conversation in this workspace.")
  await page.getByRole("button", { name: "Send" }).click()
  await expect(page.getByText("Second conversation stayed separate.")).toBeVisible({ timeout: 60_000 })

  const stored = await page.evaluate(() => new Promise<{ sessions: unknown[]; messages: unknown[] }>((resolve, reject) => {
    const request = indexedDB.open("opencode-browser", 1)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction(["sessions", "messages"], "readonly")
      const sessions = tx.objectStore("sessions").getAll()
      const messages = tx.objectStore("messages").getAll()
      tx.oncomplete = () => resolve({ sessions: sessions.result, messages: messages.result })
      tx.onerror = () => reject(tx.error)
    }
  }))
  expect(stored.sessions).toHaveLength(2)
  expect(stored.messages).toHaveLength(2)
  expect(consoleErrors).toEqual([])
  expect(failedRequests).toEqual([])
})
