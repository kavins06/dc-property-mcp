"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "@/ai/request-input";
import { InputRequest } from "./input-request";

const TOOL_LABELS: Record<string, string> = {
  resolve_property: "Resolving property identity",
  resolve_properties_batch: "Resolving properties",
  search_properties: "Searching property records",
  get_complete_property_record: "Retrieving the complete record",
  get_property_snapshot: "Retrieving the property snapshot",
  get_assessment_history: "Retrieving assessment history",
  get_tax_and_balance_history: "Retrieving tax history",
  get_ownership_and_sale: "Retrieving ownership and sale records",
  get_latest_sale_and_deed: "Retrieving the latest deed",
  get_permit_history: "Retrieving permits",
  get_license_history: "Retrieving licenses",
  get_inspection_and_enforcement_history: "Retrieving inspections",
  get_building_and_land_profile: "Retrieving building and land data",
  get_source_evidence: "Retrieving source evidence",
  describe_data: "Checking Quoin data coverage",
};

export function MessageItem({
  message,
  onInput,
}: {
  message: ChatMessage;
  onInput: (toolCallId: string, values: Record<string, string | number | boolean | null>) => void;
}) {
  const assistant = message.role === "assistant";
  return (
    <article className={`message ${assistant ? "message-assistant" : "message-user"}`}>
      <header>{assistant ? "Quoin" : "You"}</header>
      <div className="message-content">
        {message.parts.map((part, index) => {
          if (part.type === "text") {
            return <ReactMarkdown key={index} remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown>;
          }
          if (part.type === "tool-request_user_input") {
            return <InputRequest key={part.toolCallId} part={part} onSubmit={onInput} />;
          }
          if (part.type === "dynamic-tool") {
            const label = TOOL_LABELS[part.toolName] ?? "Checking Quoin records";
            if (part.state === "output-error") {
              return <p key={part.toolCallId} className="inline-error">{label} failed. {part.errorText}</p>;
            }
            const complete = part.state === "output-available";
            return (
              <details key={part.toolCallId} className="tool-status" open={!complete}>
                <summary><span className={complete ? "status-check" : "status-pulse"} /> {complete ? label.replace(/^Retrieving/, "Retrieved").replace(/^Resolving/, "Resolved").replace(/^Searching/, "Searched").replace(/^Checking/, "Checked") : label}</summary>
                {complete && <pre>{JSON.stringify(part.output, null, 2).slice(0, 12_000)}</pre>}
              </details>
            );
          }
          return null;
        })}
      </div>
    </article>
  );
}
