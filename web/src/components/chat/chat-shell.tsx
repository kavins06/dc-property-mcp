"use client";

import { useCallback, useEffect, useState } from "react";
import type { ChatMessage } from "@/ai/request-input";
import {
  deleteWorkspace,
  listWorkspaces,
  newWorkspace,
  saveWorkspace,
  titleFromMessages,
  type WorkspaceRecord,
} from "@/lib/workspaces";
import { ChatSession } from "./chat-session";
import { WorkspaceSidebar } from "./workspace-sidebar";

export function ChatShell({ userLabel }: { userLabel: string }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [activeId, setActiveId] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [storageWarning, setStorageWarning] = useState(false);

  useEffect(() => {
    listWorkspaces()
      .then(async (saved) => {
        if (saved.length) {
          setWorkspaces(saved);
          setActiveId(saved[0].id);
          return;
        }
        const workspace = newWorkspace();
        await saveWorkspace(workspace);
        setWorkspaces([workspace]);
        setActiveId(workspace.id);
      })
      .catch(() => {
        const workspace = newWorkspace();
        setStorageWarning(true);
        setWorkspaces([workspace]);
        setActiveId(workspace.id);
      });
  }, []);

  const create = useCallback(() => {
    const workspace = newWorkspace();
    setWorkspaces((current) => [workspace, ...current]);
    setActiveId(workspace.id);
    setSidebarOpen(false);
    saveWorkspace(workspace).catch(() => setStorageWarning(true));
  }, []);

  const update = useCallback((id: string, messages: ChatMessage[]) => {
    setWorkspaces((current) => {
      const next = current.map((workspace) => workspace.id === id ? {
        ...workspace,
        title: titleFromMessages(messages),
        messages,
        updatedAt: new Date().toISOString(),
      } : workspace);
      const changed = next.find((workspace) => workspace.id === id);
      if (changed) saveWorkspace(changed).catch(() => setStorageWarning(true));
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    const target = workspaces.find((workspace) => workspace.id === id);
    if (!target || !window.confirm(`Delete “${target.title}”? This cannot be undone.`)) return;
    const remaining = workspaces.filter((workspace) => workspace.id !== id);
    deleteWorkspace(id).catch(() => setStorageWarning(true));
    if (remaining.length) {
      setWorkspaces(remaining);
      if (activeId === id) setActiveId(remaining[0].id);
    } else {
      create();
    }
  }, [activeId, create, workspaces]);

  const active = workspaces.find((workspace) => workspace.id === activeId);
  if (!active) return <div className="app-loading" role="status">Opening your property workspaces…</div>;

  return (
    <div className="app-shell">
      <WorkspaceSidebar
        workspaces={workspaces}
        activeId={activeId}
        userLabel={userLabel}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onCreate={create}
        onSelect={(id) => { setActiveId(id); setSidebarOpen(false); }}
        onDelete={remove}
      />
      {sidebarOpen && <button className="sidebar-scrim" type="button" aria-label="Close workspaces" onClick={() => setSidebarOpen(false)} />}
      <ChatSession key={active.id} workspace={active} sidebarOpen={sidebarOpen} onChange={(messages) => update(active.id, messages)} onOpenSidebar={() => setSidebarOpen(true)} />
      {storageWarning && <div className="storage-warning" role="status">This browser blocked local workspace storage. Keep this tab open to avoid losing the conversation.</div>}
    </div>
  );
}
