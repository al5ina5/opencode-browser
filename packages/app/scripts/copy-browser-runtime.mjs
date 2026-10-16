import { copyFile, mkdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const root = dirname(fileURLToPath(import.meta.url))
const source = resolve(dirname(fileURLToPath(import.meta.resolve("@foisal/nodebrowser"))), "../wasm")
const esbuildWasm = fileURLToPath(import.meta.resolve("esbuild-wasm/esbuild.wasm"))
const target = resolve(root, "../public")
await mkdir(target, { recursive: true })
for (const name of ["browsernode_kernel.js", "browsernode_kernel.wasm"]) {
  await copyFile(resolve(source, name), resolve(target, name))
}
await copyFile(esbuildWasm, resolve(target, "esbuild.wasm"))
