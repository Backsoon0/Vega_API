<script lang="ts">
	import { getProviders, getProviderModels, playgroundChat, type Provider, type PlaygroundChatEvent } from "$lib/api";
	import Spinner from "$lib/Spinner.svelte";
	import Markdown from "$lib/Markdown.svelte";
	import { MessageSquare, Send, Zap, Wifi, Hash, Menu, ChevronRight, Trash2 } from "lucide-svelte";

	const typeLabels: Record<string, string> = {
		vertex_ai: "Vertex AI",
		google_ai_studio: "AI Studio",
		openai: "OpenAI",
		anthropic: "Anthropic",
	};

	const typeTag: Record<string, string> = {
		vertex_ai: "tag-vertex",
		google_ai_studio: "tag-studio",
		openai: "tag-openai",
		anthropic: "tag-anthropic",
	};

	const STORAGE_KEY = "vega_playground_state";

	interface ChatMessage {
		role: "user" | "assistant" | "divider";
		content: string;
		reasoning?: string;
		modelTag?: string;
	}

	interface PlaygroundState {
		messages: ChatMessage[];
		selectedProviderId: string;
		selectedModel: string;
		tokenUsage: { promptTokens: number; completionTokens: number; totalTokens: number };
	}

	function saveState() {
		if (typeof window === "undefined") return;
		try {
			const state: PlaygroundState = {
				messages,
				selectedProviderId,
				selectedModel,
				tokenUsage,
			};
			localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
		} catch { /* storage full or unavailable */ }
	}

	function loadState(): PlaygroundState | null {
		if (typeof window === "undefined") return null;
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (!raw) return null;
			return JSON.parse(raw) as PlaygroundState;
		} catch {
			return null;
		}
	}

	let restoreDone = false;

	let providers = $state<Provider[]>([]);
	let loading = $state(true);
	let error = $state("");

	let selectedProviderId = $state("");
	let selectedModel = $state("");
	let expandedProviders = $state<Set<string>>(new Set());
	let liveModels = $state<Record<string, string[]>>({});
	let modelsLoading = $state<Record<string, boolean>>({});

	let messages = $state<ChatMessage[]>([]);
	let inputText = $state("");
	let streaming = $state(false);
	let tokenUsage = $state({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
	let mobilePanelOpen = $state(false);

	let inputEl = $state<HTMLTextAreaElement>();
	let messagesEl = $state<HTMLDivElement>();
	let abortController: AbortController | null = null;

	const selectedProvider = $derived(providers.find((p) => p.id === selectedProviderId));

	// Load providers
	$effect(() => {
		getProviders()
			.then((p) => {
				providers = p;
				loading = false;
			})
			.catch((err) => {
				error = err.message || "加载提供商失败";
				loading = false;
			});
	});

	// Restore cached state from localStorage on mount
	$effect(() => {
		const saved = loadState();
		if (saved) {
			messages = saved.messages || [];
			selectedProviderId = saved.selectedProviderId || "";
			selectedModel = saved.selectedModel || "";
			tokenUsage = saved.tokenUsage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
		}
		restoreDone = true;
	});

	// Persist state to localStorage on every change (after restore is complete)
	$effect(() => {
		// Subscribe to all tracked state
		void messages.length;
		void selectedProviderId;
		void selectedModel;
		void tokenUsage.totalTokens;
		if (restoreDone) saveState();
	});

	// Auto-scroll on new messages
	$effect(() => {
		if (messages.length && messagesEl) {
			requestAnimationFrame(() => {
				messagesEl.scrollTop = messagesEl.scrollHeight;
			});
		}
	});

	function toggleProvider(id: string) {
		const next = new Set(expandedProviders);
		if (next.has(id)) {
			next.delete(id);
		} else {
			next.add(id);
			// Fetch live models when expanding
			if (!liveModels[id]) {
				modelsLoading = { ...modelsLoading, [id]: true };
				getProviderModels(id)
					.then((models) => {
						liveModels = { ...liveModels, [id]: models };
						modelsLoading = { ...modelsLoading, [id]: false };
					})
					.catch(() => {
						modelsLoading = { ...modelsLoading, [id]: false };
					});
			}
		}
		expandedProviders = next;
	}

	function selectModel(providerId: string, model: string) {
		if (selectedModel && selectedModel !== model && messages.length > 0) {
			messages.push({ role: "divider", content: model });
		}
		selectedProviderId = providerId;
		selectedModel = model;
		mobilePanelOpen = false;
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			sendMessage();
		}
	}

	function clearChat() {
		messages = [];
		tokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
		try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
	}

	async function sendMessage() {
		const text = inputText.trim();
		if (!text || !selectedProviderId || !selectedModel || streaming) return;
		inputText = "";
		if (inputEl) inputEl.style.height = "auto";

		messages.push({ role: "user", content: text });

		// Build messages for API (filter out dividers — they're UI-only)
		const apiMessages = messages
			.filter((m) => m.role !== "divider")
			.map((m) => ({ role: m.role, content: m.content }));

		// Add an empty assistant message for streaming
		const assistantIdx = messages.length;
		messages.push({ role: "assistant", content: "" });

		streaming = true;
		abortController = new AbortController();

		try {
			for await (const event of playgroundChat(
				selectedProviderId,
				selectedModel,
				apiMessages as any,
				abortController.signal,
			)) {
				switch (event.type) {
					case "text-delta":
						if (event.text) {
							messages[assistantIdx].content += event.text;
						}
						break;
					case "reasoning-delta":
						if (event.text) {
							if (!messages[assistantIdx].reasoning) {
								messages[assistantIdx].reasoning = "";
							}
							messages[assistantIdx].reasoning += event.text;
						}
						break;
					case "done":
						if (event.usage) {
							tokenUsage = event.usage;
						}
						break;
					case "error":
						messages[assistantIdx].content += `\n\n⚠️ ${event.message || "未知错误"}`;
						break;
				}
			}
		} catch (err: any) {
			if (err.name !== "AbortError") {
				messages[assistantIdx].content += `\n\n⚠️ ${err.message || "请求失败"}`;
			}
		} finally {
			streaming = false;
			abortController = null;
		}
	}

	function stopStream() {
		if (abortController) {
			abortController.abort();
			abortController = null;
		}
	}

	function adjustHeight(el: HTMLTextAreaElement | undefined) {
		if (!el) return;
		el.style.height = "auto";
		el.style.height = Math.min(el.scrollHeight, 120) + "px";
	}

	function formatTokens(n: number): string {
		if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
		if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
		return String(n);
	}

	// Grouped model list (provider + its models) for the left rail.
	function providerName(id: string): string { return providers.find((p) => p.id === id)?.name || id; }
	const modelLabel = $derived(selectedModel ? `${providerName(selectedProviderId)} · ${selectedModel}` : "未选择模型");
</script>

<svelte:head><title>模型调试 — Vega API</title></svelte:head>

{#if loading}
	<div class="empty" style="min-height:50vh;display:grid;place-items:center">
		<div class="flex items-center justify-center min-h-[50vh]">
			<div class="flex flex-col items-center gap-4">
				<Spinner class="text-cta" />
				<span class="mono" style="font-size:13px;color:var(--muted)">加载提供商列表...</span>
			</div>
		</div>
	</div>
{:else if error}
	<div class="empty" style="min-height:50vh;display:grid;place-items:center">
		<div style="display:flex;align-items:flex-start;gap:8px;background:var(--danger-soft);border:1px solid rgba(239,68,68,.2);border-radius:var(--r-sm);padding:12px 14px;font-size:13px;color:var(--danger)">
			<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="margin-top:1px;flex-shrink:0"><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.2 2.3 18a2 2 0 0 0 1.7 3h16a2 2 0 0 0 1.7-3L13.7 3.2a2 2 0 0 0-3.4 0z" /></svg>
			<span>{error}</span>
		</div>
	</div>
{:else}
	<div class="chat" style="display:flex;flex-direction:row">
		<!-- Left rail: provider & model selector -->
		<div class="chat-side {mobilePanelOpen ? 'open' : ''}" id="chatSide">
			<div style="padding:15px 16px;border-bottom:1px solid var(--b-sub)">
				<div style="font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px;color:var(--fg)">
					<MessageSquare class="w-4 h-4" style="color:var(--cta)" stroke-width={1.5} />
					选择模型
				</div>
				<div style="font-size:11px;color:var(--muted);margin-top:3px">选择一个提供商开始对话</div>
			</div>
			<div class="model-list" id="modelList">
				{#each providers as p (p.id)}
					<div>
						<button
							class="model-prov {selectedProviderId === p.id ? 'sel' : ''}"
							onclick={() => toggleProvider(p.id)}
							aria-expanded={expandedProviders.has(p.id)}
						>
							<span style="width:7px;height:7px;border-radius:50%;background:{p.enabled ? 'var(--success)' : 'var(--muted)'}"></span>
							{p.name}
							<span class="tag {typeTag[p.type]}" style="margin-left:auto">{typeLabels[p.type]}</span>
							<ChevronRight class="w-3.5 h-3.5" style="color:var(--muted)" stroke-width={1.6} />
						</button>
						{#if expandedProviders.has(p.id)}
							{@const models = [...new Set([...(p.models || []), ...(liveModels[p.id] || [])])]}
							<div class="model-group" id="models-{p.id}">
								{#if modelsLoading[p.id]}
									<div class="row" style="padding:8px 12px 8px 24px;font-size:11px;color:var(--muted)">
										<Spinner size="sm" /> 获取中...
									</div>
								{:else if models.length}
									{#each models as model (model)}
										<button
											class="model-item {selectedProviderId === p.id && selectedModel === model ? 'sel' : ''}"
											onclick={() => selectModel(p.id, model)}
										>
											{model}
										</button>
									{/each}
								{:else}
									<p style="font-size:11px;color:var(--muted);padding:8px 12px 8px 24px">未获取到模型</p>
								{/if}
							</div>
						{/if}
					</div>
				{/each}
			</div>
			<div style="padding:12px 14px;border-top:1px solid var(--b-sub);display:flex;flex-direction:column;gap:6px;font-family:var(--font-mono);font-size:11px;color:var(--muted)">
				<div class="between"><span class="row"><Zap class="w-3 h-3" style="color:var(--muted)" /> Prompt</span><span class="secondary" style="font-variant-numeric:tabular-nums">{formatTokens(tokenUsage.promptTokens)}</span></div>
				<div class="between"><span class="row"><Wifi class="w-3 h-3" style="color:var(--muted)" /> Completion</span><span class="secondary" style="font-variant-numeric:tabular-nums">{formatTokens(tokenUsage.completionTokens)}</span></div>
				<div class="between"><span class="row"><Hash class="w-3 h-3" style="color:var(--muted)" /> Total</span><span class="cta" style="font-weight:600;font-variant-numeric:tabular-nums">{formatTokens(tokenUsage.totalTokens)}</span></div>
			</div>
		</div>

		<!-- Right: chat area -->
		<div class="chat-main">
			<div class="chat-hd">
				<button class="btn btn-ghost btn-sm" onclick={() => (mobilePanelOpen = true)}>
					<Menu stroke-width={1.8} />
					选择模型
				</button>
				<span id="hdTag" style="font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{modelLabel}</span>
			</div>

			<div class="chat-scroll" bind:this={messagesEl} id="chatScroll">
				{#if messages.length === 0}
					<div class="empty" id="chatEmpty" style="padding:64px 24px;margin:auto">
						<div class="ic">
							<MessageSquare style="width:22px;height:22px" stroke-width={1.5} />
						</div>
						<div style="font-size:14px;color:var(--fg-2);font-weight:600;margin-bottom:4px">Vega API 模型调试</div>
						<div style="font-size:12px">在左侧选择模型开始对话 · 支持流式输出与实时 Token 统计</div>
					</div>
				{/if}

				{#each messages as msg, i (i)}
					{#if msg.role === "divider"}
						<div class="row" style="justify-content:center;gap:12px;padding:4px 0">
							<div style="flex:1;height:1px;background:var(--b-sub)"></div>
							<span style="font-size:11px;color:var(--muted);font-family:var(--font-mono)">切换至 {msg.content}</span>
							<div style="flex:1;height:1px;background:var(--b-sub)"></div>
						</div>
					{:else}
						<div class="msg {msg.role === 'user' ? 'user' : 'bot'}">
							<div class="ava">
								{#if msg.role === "user"}
									<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
								{:else}
									<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v3" /><path d="M8 8a4 4 0 0 1 8 0v3a4 4 0 0 1-8 0V8z" /><path d="M8 8H6a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h2M16 8h2a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M9 16v2h6v-2" /><path d="M10 12h.01M14 12h.01" /></svg>
								{/if}
							</div>
							<div>
								{#if msg.reasoning}
									<details style="margin-bottom:8px">
										<summary style="font-size:10px;color:var(--muted);cursor:pointer;font-family:var(--font-mono);text-transform:uppercase;letter-spacing:.06em">思考过程</summary>
										<div style="margin-top:6px;font-size:11px;color:var(--muted)"><Markdown text={msg.reasoning} /></div>
									</details>
								{/if}
								<div class="msg-bubble" style="white-space:pre-wrap;width:fit-content">
									{#if msg.role === "user"}
										{msg.content}
									{:else}
										<Markdown text={msg.content} />
									{/if}
									{#if streaming && i === messages.length - 1 && msg.role === "assistant"}
										<span style="color:var(--cta);animation:blink 1s infinite;margin-left:2px">▌</span>
									{/if}
								</div>
							</div>
						</div>
					{/if}
				{/each}
			</div>

			<div class="chat-input">
				<div class="chat-field">
					<textarea
						bind:this={inputEl}
						bind:value={inputText}
						onkeydown={handleKeydown}
						oninput={(e) => adjustHeight(inputEl)}
						rows="1"
						placeholder="输入消息…"
						title="Enter 发送, Shift+Enter 换行"
						disabled={!selectedModel || streaming}
					></textarea>
					{#if streaming}
						<button class="btn btn-danger" style="height:42px;padding:0 15px" onclick={stopStream} title="停止生成">
							<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
						</button>
					{:else}
						<button class="btn btn-primary" style="height:42px;padding:0 15px" onclick={sendMessage} disabled={!inputText.trim() || !selectedModel} title="发送">
							<Send stroke-width={2} />
						</button>
					{/if}
				</div>
				<div class="between" style="margin-top:8px;font-family:var(--font-mono);font-size:11px;color:var(--muted)">
					<span id="chatModelTag">{modelLabel}</span>
					<span class="row">
						{#if messages.length > 0}
							<button class="btn btn-ghost btn-sm" style="color:var(--danger);border-color:transparent" onclick={clearChat} title="清空对话">
								<Trash2 class="w-3 h-3" stroke-width={1.7} /> 清空
							</button>
						{/if}
						<span id="chatTokens">{formatTokens(tokenUsage.totalTokens)} tokens</span>
					</span>
				</div>
			</div>
		</div>
	</div>

	{#if mobilePanelOpen}
		<div
			class="scrim on"
			style="display:block"
			onclick={() => (mobilePanelOpen = false)}
			role="presentation"
			aria-label="关闭模型列表"
		></div>
	{/if}
{/if}
