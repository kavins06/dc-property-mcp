"use client";

import { useState } from "react";
import type { ChatMessage } from "@/ai/request-input";

type InputPart = Extract<ChatMessage["parts"][number], { type: "tool-request_user_input" }>;

export function InputRequest({
  part,
  onSubmit,
}: {
  part: InputPart;
  onSubmit: (toolCallId: string, values: Record<string, string | number | boolean | null>) => void;
}) {
  const [values, setValues] = useState<Record<string, string | boolean>>(Object.create(null));

  if (part.state === "output-available") {
    return (
      <section className="input-card input-card-complete" aria-label="User-provided information">
        <span className="eyebrow">User-provided</span>
        <dl className="input-summary">
          {Object.entries(part.output.values).map(([key, value]) => (
            <div key={key}><dt>{key.replaceAll("_", " ")}</dt><dd>{String(value ?? "Not provided")}</dd></div>
          ))}
        </dl>
      </section>
    );
  }

  if (part.state === "output-error" || part.state === "output-denied") {
    return <p className="inline-error">Those inputs could not be submitted.</p>;
  }

  if (part.state !== "input-available") {
    return <div className="tool-status"><span className="status-pulse" /> Preparing a few relevant fields…</div>;
  }

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const output: Record<string, string | number | boolean | null> = {};
    for (const field of part.input.fields) {
      const value = values[field.id];
      output[field.id] = field.type === "number" && typeof value === "string" && value !== ""
        ? Number(value)
        : value ?? null;
    }
    onSubmit(part.toolCallId, output);
  };

  return (
    <form className="input-card" onSubmit={submit}>
      <span className="eyebrow">Optional context</span>
      <h3>{part.input.title}</h3>
      {part.input.description && <p>{part.input.description}</p>}
      <div className="input-grid">
        {part.input.fields.map((field) => (
          <label key={field.id} className={field.type === "boolean" ? "checkbox-field" : undefined}>
            {field.type === "boolean" ? (
              <>
                <input
                  type="checkbox"
                  checked={Boolean(values[field.id])}
                  onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.checked }))}
                />
                <span>{field.label}</span>
              </>
            ) : (
              <>
                <span>{field.label}{field.required ? " *" : ""}</span>
                {field.type === "select" ? (
                  <select
                    required={field.required}
                    value={String(values[field.id] ?? "")}
                    onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))}
                  >
                    <option value="">Select…</option>
                    {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                ) : (
                  <input
                    type={field.type}
                    required={field.required}
                    placeholder={field.placeholder}
                    value={String(values[field.id] ?? "")}
                    onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))}
                  />
                )}
              </>
            )}
          </label>
        ))}
      </div>
      <button className="button button-dark" type="submit">Add to this analysis</button>
      <small>These values are labeled as user-provided in every answer and export.</small>
    </form>
  );
}
