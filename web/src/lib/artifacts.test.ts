import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/ai/request-input";
import { artifactFromMessages } from "./artifacts";

describe("artifactFromMessages", () => {
  it("keeps Quoin facts and user inputs in separate collections", () => {
    const messages = [
      { id: "u", role: "user", parts: [{ type: "text", text: "Show 555 12th St NW" }] },
      {
        id: "a",
        role: "assistant",
        parts: [
          { type: "text", text: "The current assessment is source-linked." },
          { type: "dynamic-tool", toolName: "get_property_snapshot", toolCallId: "t", state: "output-available", input: { ssl: "1" }, output: { assessment: 10, source_refs: ["ref"] } },
          { type: "tool-request_user_input", toolCallId: "i", state: "output-available", input: { title: "Context", fields: [] }, output: { source: "user-provided", values: { asking_price: 20 } } },
        ],
      },
    ] as ChatMessage[];
    const artifact = artifactFromMessages(messages, "555 12th St NW");
    expect(artifact.tools[0]?.tool).toBe("get_property_snapshot");
    expect(artifact.tools[0]?.output).toContain("source_refs");
    expect(artifact.userInputs).toEqual([{ asking_price: 20 }]);
  });
});
