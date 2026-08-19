import type { ChatMessage } from "@/ai/request-input";

const DB_NAME = "quoin-property-chat";
const STORE_NAME = "workspaces";

export interface WorkspaceRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export function titleFromMessages(messages: ChatMessage[]): string {
  const first = messages.find((message) => message.role === "user");
  const text = first?.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join(" ")
    .trim();
  if (!text) return "New property";
  if (text.length <= 44) return text;
  const shortened = text.slice(0, 44);
  const wordBoundary = shortened.lastIndexOf(" ");
  return `${shortened.slice(0, wordBoundary > 24 ? wordBoundary : 43).trimEnd()}…`;
}

export function newWorkspace(): WorkspaceRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: "New property",
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, mode);
    const request = action(tx.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => database.close();
    tx.onerror = () => reject(tx.error);
  });
}

export async function listWorkspaces(): Promise<WorkspaceRecord[]> {
  const records = await transaction("readonly", (store) => store.getAll());
  return records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function saveWorkspace(workspace: WorkspaceRecord): Promise<void> {
  await transaction("readwrite", (store) => store.put(structuredClone(workspace)));
}

export async function deleteWorkspace(id: string): Promise<void> {
  await transaction("readwrite", (store) => store.delete(id));
}
