"use client";

import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "@/ai/request-input";
import type { WorkspaceRecord } from "@/lib/workspaces";
import { ExportMenu } from "./export-menu";
import { MessageItem } from "./message-item";

const PROMPTS = [
  "Show me everything Quoin knows about 555 12th St NW",
  "Find this property's assessment and sale history",
  "What permits, licenses, or enforcement records are linked to this address?",
];

export function ChatSession({
  workspace,
  sidebarOpen,
  onChange,
  onOpenSidebar,
}: {
  workspace: WorkspaceRecord;
  sidebarOpen: boolean;
  onChange: (messages: ChatMessage[]) => void;
  onOpenSidebar: () => void;
}) {
  const transport = useMemo(() => new DefaultChatTransport({ api: "/api/chat" }), []);
  const { messages, sendMessage, addToolOutput, status, error, stop, regenerate } = useChat<ChatMessage>({
    id: workspace.id,
    messages: workspace.messages,
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
  });
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => onChange(messages), 250);
    return () => clearTimeout(timer);
  }, [messages, onChange]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: status === "streaming" ? "auto" : "smooth" });
  }, [messages, status]);

  const submitText = (text: string) => {
    const value = text.trim();
    if (!value || status !== "ready") return;
    sendMessage({ text: value });
    setInput("");
  };

  return (
    <main className="chat-main">
      <header className="chat-topbar print-hide">
        <button className="icon-button menu-button" type="button" onClick={onOpenSidebar} aria-label="Open workspaces" aria-controls="property-workspaces" aria-expanded={sidebarOpen}>☰</button>
        <div><span className="eyebrow">Property workspace</span><h1>{workspace.title}</h1></div>
        <ExportMenu title={workspace.title} messages={messages} />
      </header>

      <section className="conversation" aria-live="polite" aria-busy={status === "submitted" || status === "streaming"}>
        {messages.length === 0 ? (
          <div className="empty-state">
            <span className="empty-index">01 / Start with a property</span>
            <h2>Research the property,<br />not the paperwork.</h2>
            <p>Enter an address or ask a property question. Quoin will resolve the record, retrieve only relevant source-linked facts, and show its work.</p>
            <div className="prompt-list">
              {PROMPTS.map((prompt) => <button type="button" key={prompt} onClick={() => submitText(prompt)}>{prompt}<span aria-hidden="true">→</span></button>)}
            </div>
            <small>Washington, D.C. property records · Sources and record dates included</small>
          </div>
        ) : messages.map((message) => (
          <MessageItem
            key={message.id}
            message={message}
            onInput={(toolCallId, values) => addToolOutput({
              tool: "request_user_input",
              toolCallId,
              output: { source: "user-provided", values },
            })}
          />
        ))}
        {status === "submitted" && <div className="thinking"><span className="status-pulse" /> Reading Quoin records…</div>}
        {error && (
          <div className="error-banner" role="alert">
            Quoin could not complete that request.
            <button type="button" onClick={() => regenerate()}>Try again</button>
          </div>
        )}
        <div ref={endRef} />
      </section>

      <div className="composer-wrap print-hide">
        <form className="composer" onSubmit={(event) => { event.preventDefault(); submitText(input); }}>
          <label className="sr-only" htmlFor="property-question">Ask about a property</label>
          <textarea
            id="property-question"
            rows={1}
            value={input}
            onChange={(event) => setInput(event.target.value.slice(0, 4_000))}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submitText(input);
              }
            }}
            placeholder="Enter an address or ask about a property…"
            disabled={status === "submitted"}
          />
          {status === "streaming" ? (
            <button className="send-button" type="button" onClick={stop} aria-label="Stop response">■</button>
          ) : (
            <button className="send-button" type="submit" disabled={!input.trim() || status !== "ready"} aria-label="Send question">↑</button>
          )}
        </form>
        <p>Quoin reports public records with provenance. Verify consequential decisions with the original source.</p>
      </div>
    </main>
  );
}
