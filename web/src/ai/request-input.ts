import { tool, type InferUITools, type UIMessage } from "ai";
import { z } from "zod";

const field = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  label: z.string().min(1).max(80),
  type: z.enum(["text", "number", "date", "select", "boolean"]),
  required: z.boolean().default(false),
  placeholder: z.string().max(120).optional(),
  options: z
    .array(z.object({ label: z.string().max(60), value: z.string().max(80) }))
    .max(12)
    .optional(),
});

export const requestUserInputTool = tool({
  description:
    "Ask for a small set of missing user-provided facts. Use only when those facts materially improve the requested output.",
  inputSchema: z.object({
    title: z.string().min(1).max(100),
    description: z.string().max(240).optional(),
    fields: z.array(field).min(1).max(8),
  }),
  outputSchema: z.object({
    source: z.literal("user-provided"),
    values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  }),
});

const localTools = { request_user_input: requestUserInputTool };
export type ChatMessage = UIMessage<unknown, never, InferUITools<typeof localTools>>;
