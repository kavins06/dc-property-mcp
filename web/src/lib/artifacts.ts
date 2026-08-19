import type { ChatMessage } from "@/ai/request-input";

export type ArtifactFormat = "markdown" | "xlsx" | "docx" | "pdf";

export interface ArtifactSection {
  role: "Quoin" | "User";
  text: string;
}

export interface ArtifactToolResult {
  tool: string;
  input: string;
  output: string;
}

export interface ArtifactDocument {
  title: string;
  generatedAt: string;
  sections: ArtifactSection[];
  tools: ArtifactToolResult[];
  userInputs: Record<string, string | number | boolean | null>[];
}

function printable(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[Unserializable value]";
  }
}

export function artifactFromMessages(
  messages: ChatMessage[],
  title: string,
): ArtifactDocument {
  const artifact: ArtifactDocument = {
    title,
    generatedAt: new Date().toISOString(),
    sections: [],
    tools: [],
    userInputs: [],
  };

  for (const message of messages) {
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text && message.role !== "system") {
      artifact.sections.push({ role: message.role === "user" ? "User" : "Quoin", text });
    }

    for (const part of message.parts) {
      if (part.type === "dynamic-tool" && part.state === "output-available") {
        artifact.tools.push({
          tool: part.toolName,
          input: printable(part.input),
          output: printable(part.output),
        });
      }
      if (part.type === "tool-request_user_input" && part.state === "output-available") {
        artifact.userInputs.push(part.output.values);
      }
    }
  }
  return artifact;
}

function safeFilename(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "quoin-property";
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function asMarkdown(artifact: ArtifactDocument): string {
  const lines = [`# ${artifact.title}`, "", `Generated ${artifact.generatedAt}`, ""];
  for (const section of artifact.sections) {
    lines.push(`## ${section.role}`, "", section.text, "");
  }
  if (artifact.userInputs.length) {
    lines.push("## User-provided inputs", "", "```json", printable(artifact.userInputs), "```", "");
  }
  if (artifact.tools.length) {
    lines.push("## Quoin source data", "");
    for (const result of artifact.tools) {
      lines.push(`### ${result.tool}`, "", "```json", result.output, "```", "");
    }
  }
  return lines.join("\n");
}

async function exportDocx(artifact: ArtifactDocument, name: string) {
  const { Document, HeadingLevel, Packer, Paragraph } = await import("docx");
  const children = [
    new Paragraph({ text: artifact.title, heading: HeadingLevel.TITLE }),
    new Paragraph({ text: `Generated ${artifact.generatedAt}` }),
    ...artifact.sections.flatMap((section) => [
      new Paragraph({ text: section.role, heading: HeadingLevel.HEADING_1 }),
      ...section.text.split("\n").map((text) => new Paragraph({ text })),
    ]),
    new Paragraph({ text: "User-provided inputs", heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ text: printable(artifact.userInputs) }),
    new Paragraph({ text: "Quoin source data", heading: HeadingLevel.HEADING_1 }),
    ...artifact.tools.flatMap((result) => [
      new Paragraph({ text: result.tool, heading: HeadingLevel.HEADING_2 }),
      new Paragraph({ text: result.output }),
    ]),
  ];
  const blob = await Packer.toBlob(new Document({ sections: [{ children }] }));
  download(blob, `${name}.docx`);
}

async function exportXlsx(artifact: ArtifactDocument, name: string) {
  const { default: writeXlsxFile } = await import("write-excel-file/browser");
  const header = (values: string[]) => values.map((value) => ({ value, fontWeight: "bold" as const }));
  const userInputRows = artifact.userInputs.flatMap((group) =>
    Object.entries(group).map(([field, value]) => [field, String(value ?? "")]),
  );

  await writeXlsxFile([
    {
      sheet: "Conversation",
      stickyRowsCount: 1,
      columns: [{ width: 16 }, { width: 100 }],
      data: [header(["Speaker", "Content"]), ...artifact.sections.map(({ role, text }) => [role, text])],
    },
    {
      sheet: "Quoin source data",
      stickyRowsCount: 1,
      columns: [{ width: 42 }, { width: 55 }, { width: 100 }],
      data: [
        header(["Tool", "Input", "Output"]),
        ...artifact.tools.map(({ tool, input, output }) => [
          tool,
          input.slice(0, 32_000),
          output.slice(0, 32_000),
        ]),
      ],
    },
    {
      sheet: "User-provided inputs",
      stickyRowsCount: 1,
      columns: [{ width: 40 }, { width: 60 }],
      data: [header(["Field", "Value"]), ...userInputRows],
    },
  ]).toFile(`${name}.xlsx`);
}

export async function exportArtifact(format: ArtifactFormat, artifact: ArtifactDocument) {
  const name = safeFilename(artifact.title);
  if (format === "pdf") {
    window.print();
    return;
  }
  if (format === "markdown") {
    download(new Blob([asMarkdown(artifact)], { type: "text/markdown;charset=utf-8" }), `${name}.md`);
    return;
  }
  if (format === "docx") return exportDocx(artifact, name);
  return exportXlsx(artifact, name);
}
