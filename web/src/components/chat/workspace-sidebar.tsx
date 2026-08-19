"use client";

import type { WorkspaceRecord } from "@/lib/workspaces";
import { signOutAction } from "@/app/actions";

export function WorkspaceSidebar({
  workspaces,
  activeId,
  userLabel,
  open,
  onClose,
  onCreate,
  onSelect,
  onDelete,
}: {
  workspaces: WorkspaceRecord[];
  activeId: string;
  userLabel: string;
  open: boolean;
  onClose: () => void;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <aside id="property-workspaces" className={`workspace-sidebar ${open ? "sidebar-open" : ""}`} aria-label="Property workspaces">
      <div className="brand-row">
        <div className="brand-mark" aria-hidden="true">Q</div>
        <div><strong>Quoin</strong><span>Property intelligence</span></div>
        <button className="icon-button sidebar-close" type="button" onClick={onClose} aria-label="Close workspaces">×</button>
      </div>
      <button className="button new-workspace" type="button" onClick={onCreate}>＋ New property</button>
      <nav className="workspace-list" aria-label="Saved workspaces">
        {workspaces.map((workspace) => (
          <div className={`workspace-row ${workspace.id === activeId ? "active" : ""}`} key={workspace.id}>
            <button type="button" onClick={() => onSelect(workspace.id)}>
              <strong>{workspace.title}</strong>
              <span>{new Date(workspace.updatedAt).toLocaleDateString()}</span>
            </button>
            <button className="delete-workspace" type="button" onClick={() => onDelete(workspace.id)} aria-label={`Delete ${workspace.title}`}>×</button>
          </div>
        ))}
      </nav>
      <div className="account-row">
        <span className="account-avatar" aria-hidden="true">{userLabel.slice(0, 1).toUpperCase()}</span>
        <span title={userLabel}>{userLabel}</span>
        <form action={signOutAction}><button type="submit">Sign out</button></form>
      </div>
    </aside>
  );
}
