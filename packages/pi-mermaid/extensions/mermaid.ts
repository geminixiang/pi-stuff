import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { extractMermaidBlocks, renderDiagram } from "./render.ts";

const ENTRY_TYPE = "pi-mermaid-diagram";

interface MermaidEntryData {
	source: string;
	diagram?: string;
	error?: string;
}

interface MermaidToolDetails {
	source: string;
	ascii: boolean;
	error?: string;
}

const parameters = Type.Object({
	source: Type.String({ description: "Mermaid diagram source" }),
	ascii: Type.Optional(Type.Boolean({ description: "Use pure ASCII instead of Unicode box drawing" })),
});

function assistantText(message: { content: unknown }): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";

	return message.content
		.filter((part): part is { type: "text"; text: string } => {
			if (typeof part !== "object" || part === null) return false;
			const value = part as { type?: unknown; text?: unknown };
			return value.type === "text" && typeof value.text === "string";
		})
		.map((part) => part.text)
		.join("\n");
}

function entryFor(source: string, useAscii = false): MermaidEntryData {
	try {
		return { source, diagram: renderDiagram(source, useAscii) };
	} catch (error) {
		return {
			source,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export default function mermaidExtension(pi: ExtensionAPI) {
	pi.registerEntryRenderer<MermaidEntryData>(ENTRY_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data;
		if (!data) return new Text(theme.fg("error", "Mermaid: missing diagram data"), 0, 0);

		if (data.error) {
			return new Text(
				theme.fg("error", "Mermaid render failed: ") + data.error +
					(expanded ? `\n\n${theme.fg("dim", data.source)}` : ""),
				0,
				0,
			);
		}

		const heading = theme.fg("accent", theme.bold("Mermaid"));
		const source = expanded ? `\n\n${theme.fg("dim", data.source)}` : "";
		return {
			render(width: number) {
				return `${heading}\n${data.diagram ?? ""}${source}`
					.split("\n")
					.map((line) => truncateToWidth(line, Math.max(1, width)));
			},
			invalidate() {},
		};
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;

		for (const block of extractMermaidBlocks(assistantText(event.message))) {
			pi.appendEntry<MermaidEntryData>(ENTRY_TYPE, entryFor(block.source));
		}
	});

	pi.registerCommand("mermaid", {
		description: "Render Mermaid source (example: /mermaid graph LR; A --> B)",
		handler: async (args, ctx) => {
			const source = args.trim();
			if (!source) {
				ctx.ui.notify("Usage: /mermaid graph LR; A --> B", "warning");
				return;
			}

			const data = entryFor(source);
			pi.appendEntry<MermaidEntryData>(ENTRY_TYPE, data);
			if (data.error) ctx.ui.notify(`Mermaid render failed: ${data.error}`, "error");
		},
	});

	pi.registerTool<typeof parameters, MermaidToolDetails>({
		name: "render_mermaid",
		label: "Render Mermaid",
		description: "Render Mermaid source as a Unicode or plain ASCII terminal diagram",
		promptSnippet: "Render a Mermaid diagram directly in the terminal",
		promptGuidelines: [
			"Use render_mermaid when the user explicitly asks to preview or render a Mermaid diagram in the terminal.",
		],
		parameters,
		async execute(_toolCallId, params) {
			try {
				const diagram = renderDiagram(params.source, params.ascii ?? false);
				return {
					content: [{ type: "text" as const, text: diagram }],
					details: { source: params.source, ascii: params.ascii ?? false },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `Mermaid render failed: ${message}` }],
					details: { source: params.source, ascii: params.ascii ?? false, error: message },
					isError: true,
				};
			}
		},
		renderCall(args, theme) {
			const firstLine = args.source.trim().split(/\r?\n/, 1)[0] ?? "";
			return new Text(theme.fg("accent", "◇ Mermaid ") + theme.fg("dim", firstLine), 0, 0);
		},
		renderResult(result, _options, theme, context) {
			const text = result.content
				.filter((item): item is { type: "text"; text: string } => item.type === "text")
				.map((item) => item.text)
				.join("\n");
			return new Text(context.isError ? theme.fg("error", text) : text, 0, 0);
		},
	});
}
