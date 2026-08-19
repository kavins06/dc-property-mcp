"use client";

import { useState } from "react";
import type { ChatMessage } from "@/ai/request-input";
import { artifactFromMessages, exportArtifact, type ArtifactFormat } from "@/lib/artifacts";

export function ExportMenu({ title, messages }: { title: string; messages: ChatMessage[] }) {
  const [format, setFormat] = useState<ArtifactFormat>("pdf");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const run = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await exportArtifact(format, artifactFromMessages(messages, title));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="export-menu print-hide">
      <label className="sr-only" htmlFor="export-format">Export format</label>
      <select id="export-format" value={format} onChange={(event) => setFormat(event.target.value as ArtifactFormat)}>
        <option value="pdf">PDF</option>
        <option value="xlsx">Excel</option>
        <option value="docx">Word</option>
        <option value="markdown">Markdown</option>
      </select>
      <button className="button" type="button" disabled={busy || messages.length === 0} onClick={run}>
        {busy ? "Preparing…" : "Export"}
      </button>
      {failed && <span className="export-error" role="alert">Export failed</span>}
    </div>
  );
}
