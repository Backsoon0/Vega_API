<script lang="ts">
	import { marked, type TokenizerAndRendererExtension } from "marked";
	import katex from "katex";
	import "katex/dist/katex.min.css";

	interface Props {
		text: string;
		class?: string;
	}

	let { text: rawText, class: cls = "" }: Props = $props();

	// Preprocess: normalize LaTeX delimiters before markdown parsing.
	// Many models output \[...\] / \(...\) instead of $$...$$ / $...$.
	function normalizeLatex(input: string): string {
		// \[...\] → display math (block level)
		let out = input.replace(/\\\[([\s\S]*?)\\\]/g, (_m: string, math: string) => {
			return `\n\n$$\n${math.trim()}\n$$\n\n`;
		});
		// \(...\) → inline math
		out = out.replace(/\\\(([\s\S]*?)\\\)/g, (_m: string, math: string) => {
			return `$${math.trim()}$`;
		});
		return out;
	}

	let text = $derived(normalizeLatex(rawText));

	// LaTeX extension for marked
	const latexBlock: TokenizerAndRendererExtension = {
		name: "latexBlock",
		level: "block",
		start(src: string) {
			return src.indexOf("$$");
		},
		tokenizer(src: string) {
			const match = src.match(/^\$\$([\s\S]*?)\$\$/);
			if (match) {
				return {
					type: "latexBlock",
					raw: match[0],
					text: match[1].trim(),
				};
			}
		},
		renderer(token: any) {
			try {
				return katex.renderToString(token.text, {
					displayMode: true,
					throwOnError: false,
				});
			} catch {
				return `<pre>${token.text}</pre>`;
			}
		},
	};

	const latexInline: TokenizerAndRendererExtension = {
		name: "latexInline",
		level: "inline",
		start(src: string) {
			return src.indexOf("$");
		},
		tokenizer(src: string) {
			if (src.startsWith("$$")) return;
			const match = src.match(/^\$([^\$\n]+?)\$/);
			if (match) {
				return {
					type: "latexInline",
					raw: match[0],
					text: match[1].trim(),
				};
			}
		},
		renderer(token: any) {
			try {
				return katex.renderToString(token.text, {
					throwOnError: false,
				});
			} catch {
				return token.text;
			}
		},
	};

	marked.use({ extensions: [latexBlock, latexInline] });

	let html = $derived(marked.parse(text, { breaks: true }) as string);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="markdown-body {cls}">{@html html}</div>

<style>
	.markdown-body {
		line-height: 1.7;
		word-break: break-word;
	}
	.markdown-body :global(h1) {
		font-size: 1.4em;
		font-weight: 700;
		margin: 1em 0 0.5em;
		color: var(--color-primary);
	}
	.markdown-body :global(h2) {
		font-size: 1.2em;
		font-weight: 600;
		margin: 0.8em 0 0.4em;
		color: var(--color-primary);
	}
	.markdown-body :global(h3) {
		font-size: 1.05em;
		font-weight: 600;
		margin: 0.6em 0 0.3em;
		color: var(--color-secondary);
	}
	.markdown-body :global(p) {
		margin: 0.5em 0;
	}
	.markdown-body :global(ul),
	.markdown-body :global(ol) {
		padding-left: 1.5em;
		margin: 0.4em 0;
	}
	.markdown-body :global(li) {
		margin: 0.15em 0;
	}
	.markdown-body :global(code) {
		background: var(--color-surface-elevated);
		padding: 0.15em 0.4em;
		border-radius: 4px;
		font-size: 0.85em;
		font-family: var(--font-family-mono);
		color: #fbbf24;
	}
	.markdown-body :global(pre) {
		background: var(--color-surface-elevated);
		padding: 0.75em 1em;
		border-radius: 8px;
		overflow-x: auto;
		margin: 0.5em 0;
		border: 1px solid rgba(255, 255, 255, 0.06);
	}
	.markdown-body :global(pre code) {
		background: none;
		padding: 0;
		color: inherit;
	}
	.markdown-body :global(blockquote) {
		border-left: 3px solid var(--color-cta);
		padding-left: 0.75em;
		margin: 0.5em 0;
		color: var(--color-muted);
	}
	.markdown-body :global(a) {
		color: var(--color-cta);
		text-decoration: underline;
	}
	.markdown-body :global(strong) {
		font-weight: 600;
		color: var(--color-primary);
	}
	.markdown-body :global(table) {
		border-collapse: collapse;
		margin: 0.5em 0;
		font-size: 0.85em;
	}
	.markdown-body :global(th),
	.markdown-body :global(td) {
		border: 1px solid rgba(255, 255, 255, 0.08);
		padding: 0.4em 0.75em;
		text-align: left;
	}
	.markdown-body :global(th) {
		background: var(--color-surface-elevated);
	}
	.markdown-body :global(hr) {
		border: none;
		border-top: 1px solid rgba(255, 255, 255, 0.08);
		margin: 1em 0;
	}
</style>
