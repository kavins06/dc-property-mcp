import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/ai/request-input";
import { titleFromMessages } from "./workspaces";

describe("titleFromMessages", () => {
  it("uses and bounds the first user message", () => {
    const messages = [{
      id: "one",
      role: "user",
      parts: [{ type: "text", text: "Tell me everything Quoin knows about 555 12th Street Northwest" }],
    }] as ChatMessage[];
    expect(titleFromMessages(messages)).toBe("Tell me everything Quoin knows about 555…");
  });

  it("keeps an empty workspace recognizable", () => {
    expect(titleFromMessages([])).toBe("New property");
  });
});
