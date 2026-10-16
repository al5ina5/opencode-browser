type StoreName = "kv" | "sessions" | "messages"

const DB_NAME = "opencode-browser"
const DB_VERSION = 1
let database: Promise<IDBDatabase> | undefined

function open() {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv")
      if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "id" })
      if (!db.objectStoreNames.contains("messages")) db.createObjectStore("messages", { keyPath: "sessionID" })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("Could not open browser storage"))
  })
  return database
}

export async function readValue<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const request = db.transaction(store, "readonly").objectStore(store).get(key)
    request.onsuccess = () => resolve(request.result as T | undefined)
    request.onerror = () => reject(request.error)
  })
}

export async function writeValue(store: StoreName, value: unknown, key?: IDBValidKey) {
  const db = await open()
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(store, "readwrite")
    if (key === undefined) transaction.objectStore(store).put(value)
    else transaction.objectStore(store).put(value, key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error ?? new Error("Browser storage write was aborted"))
  })
}

export async function deleteValue(store: StoreName, key: IDBValidKey) {
  const db = await open()
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(store, "readwrite")
    transaction.objectStore(store).delete(key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}

export async function listValues<T>(store: StoreName): Promise<T[]> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const request = db.transaction(store, "readonly").objectStore(store).getAll()
    request.onsuccess = () => resolve(request.result as T[])
    request.onerror = () => reject(request.error)
  })
}
