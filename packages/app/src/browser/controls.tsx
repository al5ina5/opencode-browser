import { useLanguage } from "@/context/language"
import { browserRuntime } from "./runtime"
import { createProject, exportProject, importProject } from "./api"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { decode64 } from "@/utils/base64"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import { showToast } from "@/utils/toast"

const buttonClass = "rounded-md border border-border-weak-base bg-surface-base px-3 py-1.5 text-12-medium text-text-strong hover:bg-surface-raised"

export function BrowserControls() {
  const language = useLanguage()
  const navigate = useNavigate()
  const location = useLocation()
  const [expanded, setExpanded] = createSignal(false)
  const [ready, setReady] = createSignal(false)
  const [supported, setSupported] = createSignal(true)
  const [runtime, setRuntime] = createSignal("")
  const [output, setOutput] = createSignal("")
  const [showTerminal, setShowTerminal] = createSignal(false)
  const [preview, setPreview] = createSignal("")
  const [providerDialog, setProviderDialog] = createSignal(false)
  const [providerID, setProviderID] = createSignal("openai-compatible")
  const [providerName, setProviderName] = createSignal("OpenAI-compatible")
  const [providerURL, setProviderURL] = createSignal("https://api.openai.com/v1")
  const [providerKey, setProviderKey] = createSignal("")
  const [modelID, setModelID] = createSignal("gpt-4o-mini")
  const [modelName, setModelName] = createSignal("GPT-4o mini")
  let upload: HTMLInputElement | undefined
  let detach: (() => void) | undefined

  const projectDirectory = () => decode64(location.pathname.split("/")[1]) ?? "/home/projects/workspace"
  const openProject = (directory: string) => navigate(`/${base64Encode(directory)}/session`)
  const reportError = (cause: unknown) => showToast({
    title: language.t("common.requestFailed"),
    description: cause instanceof Error ? cause.message : String(cause),
  })

  const create = async () => {
    const name = window.prompt(language.t("browser.project.prompt"), "my-app")
    if (!name) return
    try {
      const project = await createProject(name)
      openProject(project.directory)
      setExpanded(false)
    } catch (cause) { reportError(cause) }
  }

  const importZip = async (file?: File) => {
    if (!file) return
    try {
      const name = file.name.replace(/\.zip$/i, "") || "imported-project"
      const result = await importProject(name, new Uint8Array(await file.arrayBuffer()))
      openProject(result.project.directory)
      setExpanded(false)
      showToast({ title: language.t("browser.project.imported", { name: result.project.name }) })
    } catch (cause) { reportError(cause) }
    if (upload) upload.value = ""
  }

  const download = async () => {
    try {
      const directory = projectDirectory()
      const bytes = await exportProject(directory)
      const blob = new Blob([bytes], { type: "application/zip" })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = `${directory.split("/").at(-1) || "workspace"}.zip`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (cause) { reportError(cause) }
  }

  const saveProvider = async (event: SubmitEvent) => {
    event.preventDefault()
    try {
      await browserRuntime.configureProvider({
        providerID: providerID().trim(),
        name: providerName().trim(),
        baseURL: providerURL().trim(),
        apiKey: providerKey().trim() || undefined,
        models: { [modelID().trim()]: { name: modelName().trim() } },
      })
      setProviderDialog(false)
      setExpanded(false)
      window.location.reload()
    } catch (cause) { reportError(cause) }
  }

  onMount(() => {
    setSupported(/Chrome|Chromium/.test(navigator.userAgent) && !/Mobile/.test(navigator.userAgent))
    void browserRuntime.capabilities().then((value) => {
      setReady(true)
      setRuntime(`${value.runtime}${value.worker ? " · runtime worker" : " · runtime on page"} · agent worker${value.sabStdio ? " · shared memory" : ""}`)
    }).catch(reportError)
    void browserRuntime.provider().then((value) => {
      if (!value) return
      setProviderID(value.providerID)
      setProviderName(value.name)
      setProviderURL(value.baseURL)
      setProviderKey(value.apiKey ?? "")
      const first = Object.entries(value.models)[0]
      if (first) {
        setModelID(first[0])
        setModelName(first[1].name)
      }
    }).catch(reportError)
    detach = browserRuntime.on((name, value) => {
      if (name === "terminal-output") {
        const chunk = (value as { output?: string }).output ?? ""
        setOutput((current) => (current + chunk).slice(-24000))
        setShowTerminal(true)
      }
      if (name === "preview-ready") setPreview((value as { url?: string }).url ?? "")
      if (name === "runtime-error") reportError(value)
    })
  })
  onCleanup(() => detach?.())

  return (
    <>
      <div class="fixed bottom-4 right-4 z-[100] flex max-w-[min(92vw,720px)] flex-col items-end gap-2">
        <Show when={preview()}>
          <section class="flex h-[min(66vh,620px)] w-[min(76vw,920px)] flex-col overflow-hidden rounded-xl border border-border-weak-base bg-background-base shadow-2xl">
            <div class="flex items-center justify-between border-b border-border-weak-base px-3 py-2 text-12-medium text-text-strong">
              <span>{language.t("browser.preview.title")}</span>
              <button class={buttonClass} onClick={() => setPreview("")}>{language.t("browser.preview.close")}</button>
            </div>
            <iframe class="min-h-0 flex-1 bg-white" src={preview()} title={language.t("browser.preview.title")} />
          </section>
        </Show>
        <Show when={showTerminal()}>
          <section class="fixed right-4 top-20 z-[100] w-[min(76vw,720px)] overflow-hidden rounded-xl border border-border-weak-base bg-background-base shadow-2xl">
            <div class="flex items-center justify-between border-b border-border-weak-base px-3 py-2 text-12-medium text-text-strong">
              <span>{language.t("browser.terminal.title")}</span>
              <button class={buttonClass} onClick={() => setShowTerminal(false)}>{language.t("browser.preview.close")}</button>
            </div>
            <pre class="max-h-60 overflow-auto whitespace-pre-wrap p-3 font-mono text-11-regular text-text-base">{output()}</pre>
          </section>
        </Show>
        <Show when={expanded()}>
          <section class="flex max-w-full flex-wrap items-center justify-end gap-2 rounded-xl border border-border-weak-base bg-background-base/95 p-2 shadow-xl backdrop-blur">
            <button class={buttonClass} onClick={() => void create()}>{language.t("browser.project.create")}</button>
            <button class={buttonClass} onClick={() => upload?.click()}>{language.t("browser.project.import")}</button>
            <button class={buttonClass} onClick={() => void download()}>{language.t("browser.project.export")}</button>
            <button class={buttonClass} onClick={() => setProviderDialog(true)}>{language.t("browser.provider.configure")}</button>
            <button class={buttonClass} onClick={() => setShowTerminal((value) => !value)}>{language.t("browser.terminal.title")}</button>
          </section>
        </Show>
        <button
          type="button"
          class="rounded-full border border-border-weak-base bg-background-base px-4 py-2 text-12-medium text-text-strong shadow-xl"
          aria-label={language.t("browser.controls.title")}
          title={ready() ? runtime() : language.t("browser.runtime.starting")}
          onClick={() => setExpanded((value) => !value)}
        >
          {language.t("browser.controls.title")} · {ready() ? (supported() ? language.t("browser.runtime.ready") : language.t("browser.runtime.limited")) : language.t("browser.runtime.starting")}
        </button>
        <Show when={ready() && !supported()}>
          <p class="max-w-64 rounded-md bg-background-base p-2 text-11-regular text-text-weak">{language.t("browser.runtime.chromiumOnly")}</p>
        </Show>
      </div>
      <input ref={upload} class="hidden" type="file" accept=".zip,application/zip" onChange={(event) => void importZip(event.currentTarget.files?.[0])} />
      <Show when={providerDialog()}>
        <div class="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 p-4" role="presentation" onClick={(event) => event.target === event.currentTarget && setProviderDialog(false)}>
          <form class="flex w-full max-w-lg flex-col gap-4 rounded-xl border border-border-weak-base bg-background-base p-5 shadow-2xl" onSubmit={(event) => void saveProvider(event)}>
            <h2 class="text-16-medium text-text-strong">{language.t("browser.provider.configure")}</h2>
            <label class="flex flex-col gap-1 text-12-medium text-text-strong">{language.t("provider.custom.field.providerID.label")}<input required class="rounded-md border border-border-weak-base bg-surface-base px-3 py-2 text-14-regular" value={providerID()} onInput={(event) => setProviderID(event.currentTarget.value)} /></label>
            <label class="flex flex-col gap-1 text-12-medium text-text-strong">{language.t("provider.custom.field.name.label")}<input required class="rounded-md border border-border-weak-base bg-surface-base px-3 py-2 text-14-regular" value={providerName()} onInput={(event) => setProviderName(event.currentTarget.value)} /></label>
            <label class="flex flex-col gap-1 text-12-medium text-text-strong">{language.t("provider.custom.field.baseURL.label")}<input required type="url" class="rounded-md border border-border-weak-base bg-surface-base px-3 py-2 text-14-regular" value={providerURL()} onInput={(event) => setProviderURL(event.currentTarget.value)} /></label>
            <label class="flex flex-col gap-1 text-12-medium text-text-strong">{language.t("provider.custom.field.apiKey.label")}<input type="password" autocomplete="off" class="rounded-md border border-border-weak-base bg-surface-base px-3 py-2 text-14-regular" value={providerKey()} onInput={(event) => setProviderKey(event.currentTarget.value)} /></label>
            <label class="flex flex-col gap-1 text-12-medium text-text-strong">{language.t("provider.custom.models.id.label")}<input required class="rounded-md border border-border-weak-base bg-surface-base px-3 py-2 text-14-regular" value={modelID()} onInput={(event) => setModelID(event.currentTarget.value)} /></label>
            <label class="flex flex-col gap-1 text-12-medium text-text-strong">{language.t("provider.custom.models.name.label")}<input required class="rounded-md border border-border-weak-base bg-surface-base px-3 py-2 text-14-regular" value={modelName()} onInput={(event) => setModelName(event.currentTarget.value)} /></label>
            <p class="text-12-regular text-text-weak">{language.t("browser.provider.description")}</p>
            <div class="flex justify-end gap-2"><button type="button" class={buttonClass} onClick={() => setProviderDialog(false)}>{language.t("common.cancel")}</button><button type="submit" class={buttonClass}>{language.t("common.save")}</button></div>
          </form>
        </div>
      </Show>
    </>
  )
}
