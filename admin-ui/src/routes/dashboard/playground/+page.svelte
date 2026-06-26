<script lang="ts">
	import { getProviders, getProviderModels, playgroundChat, type Provider, type PlaygroundChatEvent } from "$lib/api";
	import Spinner from "$lib/Spinner.svelte";
	import Alert from "$lib/Alert.svelte";
	import Markdown from "$lib/Markdown.svelte";
	import {
		MessageSquare,
		Send,
		ChevronDown,
		ChevronRight,
		User,
		Bot,
		Zap,
		Hash,
		Wifi,
		Trash2,
		Menu,
		X,
	} from "lucide-svelte";

	const typeLabels: Record<string, string> = {
		vertex_ai: "Vertex AI",
		google_ai_studio: "AI Studio",
		openai: "OpenAI",
		anthropic: "Anthropic",
	};

	const typeColors: Record<string, string> = {
		vertex_ai: "text-vertex",
		google_ai_studio: "text-studio",
		openai: "text-openai",
		anthropic: "text-anthropic",
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
		el.style.height = Math.min(el.scrollHeight, 160) + "px";
	}

	function formatTokens(n: number): string {
		if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
		if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
		return String(n);
	}
</script>

<svelte:head><title>模型调试 — Vega API</title></svelte:head>

{#if loading}
	<div class="flex items-center justify-center min-h-[50vh]">
		<div class="flex flex-col items-center gap-4">
			<Spinner class="text-cta" />
			<span class="text-sm text-muted font-mono">加载提供商列表...</span>
		</div>
	</div>
{:else if error}
	<div class="flex items-center justify-center min-h-[50vh]">
		<Alert type="error" message={error} />
	</div>
{:else}
	<div class="flex flex-col lg:flex-row h-dvh gap-0 -m-3 sm:-m-5 lg:-m-6">
		<!-- Mobile panel overlay -->
		{#if mobilePanelOpen}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="lg:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
				onclick={() => (mobilePanelOpen = false)}
				onkeydown={(e) => { if (e.key === 'Escape') mobilePanelOpen = false; }}
				role="button"
				tabindex="-1"
			></div>
			<div class="lg:hidden fixed inset-y-0 left-0 z-50 w-80 max-w-[85vw] bg-surface border-r border-white/[0.06] flex flex-col shadow-modal animate-fade-in">
				<div class="flex items-center justify-between p-4 border-b border-white/[0.06]">
					<h2 class="text-sm font-semibold text-primary flex items-center gap-2">
						<MessageSquare class="w-4 h-4 text-cta" stroke-width={1.5} />
						选择模型
					</h2>
					<button
						class="p-1.5 rounded-lg hover:bg-surface-hover text-muted hover:text-secondary transition-colors"
						onclick={() => (mobilePanelOpen = false)}
						aria-label="关闭"
					>
						<X class="w-4 h-4" stroke-width={1.5} />
					</button>
				</div>
				<div class="flex-1 overflow-y-auto p-2 space-y-1">
					{#each providers as p (p.id)}
						<div>
							<button
								class="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm transition-all duration-150
								       hover:bg-surface-hover text-secondary hover:text-primary"
								class:bg-cta-subtle={selectedProviderId === p.id}
								class:text-cta={selectedProviderId === p.id}
								onclick={() => toggleProvider(p.id)}
							>
								{#if expandedProviders.has(p.id)}
									<ChevronDown class="w-3.5 h-3.5 text-muted shrink-0" stroke-width={1.5} />
								{:else}
									<ChevronRight class="w-3.5 h-3.5 text-muted shrink-0" stroke-width={1.5} />
								{/if}
								<span class="w-2 h-2 rounded-full shrink-0 {p.enabled ? 'bg-accent shadow-[0_0_6px_var(--color-accent)]' : 'bg-muted'}"></span>
								<span class="truncate text-left flex-1">{p.name}</span>
								<span class="text-[10px] font-mono uppercase shrink-0 {typeColors[p.type] || 'text-muted'}">{typeLabels[p.type] || p.type}</span>
							</button>
							{#if expandedProviders.has(p.id)}
								{@const models = [...new Set([...(p.models || []), ...(liveModels[p.id] || [])])]}
								<div class="ml-8 space-y-0.5">
									{#if modelsLoading[p.id]}
										<div class="flex items-center gap-1.5 px-3 py-1.5">
											<Spinner class="text-muted" />
											<span class="text-[10px] text-muted">获取中...</span>
										</div>
									{:else}
										{#each models as model (model)}
											<button
												class="w-full text-left px-3 py-1.5 rounded-md text-xs font-mono transition-all duration-150
												       {selectedProviderId === p.id && selectedModel === model
												       	? 'bg-cta-subtle text-cta font-semibold'
												       	: 'text-muted hover:text-secondary hover:bg-surface-hover'}"
												onclick={() => selectModel(p.id, model)}
											>
												{model}
											</button>
										{/each}
										{#if !models.length}
											<p class="text-[10px] text-muted px-3 py-1">未获取到模型</p>
										{/if}
									{/if}
								</div>
							{/if}
						</div>
					{/each}
				</div>
				<div class="p-3 border-t border-white/[0.06] space-y-2 text-[10px] font-mono">
					<div class="flex items-center justify-between text-muted">
						<span class="flex items-center gap-1"><Zap class="w-3 h-3" />Prompt</span>
						<span class="text-secondary tabular-nums">{formatTokens(tokenUsage.promptTokens)}</span>
					</div>
					<div class="flex items-center justify-between text-muted">
						<span class="flex items-center gap-1"><Wifi class="w-3 h-3" />Completion</span>
						<span class="text-secondary tabular-nums">{formatTokens(tokenUsage.completionTokens)}</span>
					</div>
					<div class="flex items-center justify-between text-muted">
						<span class="flex items-center gap-1"><Hash class="w-3 h-3" />Total</span>
						<span class="text-cta font-semibold tabular-nums">{formatTokens(tokenUsage.totalTokens)}</span>
					</div>
				</div>
			</div>
		{/if}

		<!-- Left Panel: Provider & Model Selector (desktop) -->
		<div class="hidden lg:flex w-64 lg:w-72 shrink-0 bg-surface border-r border-white/[0.06] flex-col">
			<div class="p-4 border-b border-white/[0.06]">
				<h2 class="text-sm font-semibold text-primary flex items-center gap-2">
					<MessageSquare class="w-4 h-4 text-cta" stroke-width={1.5} />
					模型调试
				</h2>
				<p class="text-[10px] text-muted mt-1">选择一个模型开始对话</p>
			</div>

			<div class="flex-1 overflow-y-auto p-2 space-y-1">
				{#each providers as p (p.id)}
					<div>
						<button
							class="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm transition-all duration-150
							       hover:bg-surface-hover text-secondary hover:text-primary"
							class:bg-cta-subtle={selectedProviderId === p.id}
							class:text-cta={selectedProviderId === p.id}
							onclick={() => toggleProvider(p.id)}
						>
							{#if expandedProviders.has(p.id)}
								<ChevronDown class="w-3.5 h-3.5 text-muted shrink-0" stroke-width={1.5} />
							{:else}
								<ChevronRight class="w-3.5 h-3.5 text-muted shrink-0" stroke-width={1.5} />
							{/if}
							<span class="w-2 h-2 rounded-full shrink-0 {p.enabled ? 'bg-accent shadow-[0_0_6px_var(--color-accent)]' : 'bg-muted'}"></span>
							<span class="truncate text-left flex-1">{p.name}</span>
							<span class="text-[10px] font-mono uppercase shrink-0 {typeColors[p.type] || 'text-muted'}">{typeLabels[p.type] || p.type}</span>
						</button>

						{#if expandedProviders.has(p.id)}
							{@const models = [...new Set([...(p.models || []), ...(liveModels[p.id] || [])])]}
							<div class="ml-8 space-y-0.5">
								{#if modelsLoading[p.id]}
									<div class="flex items-center gap-1.5 px-3 py-1.5">
										<Spinner class="text-muted" />
										<span class="text-[10px] text-muted">获取中...</span>
									</div>
								{:else}
									{#each models as model (model)}
										<button
											class="w-full text-left px-3 py-1.5 rounded-md text-xs font-mono transition-all duration-150
											       {selectedProviderId === p.id && selectedModel === model
											       	? 'bg-cta-subtle text-cta font-semibold'
											       	: 'text-muted hover:text-secondary hover:bg-surface-hover'}"
											onclick={() => selectModel(p.id, model)}
										>
											{model}
										</button>
									{/each}
									{#if !models.length}
										<p class="text-[10px] text-muted px-3 py-1">未获取到模型</p>
									{/if}
								{/if}
							</div>
						{/if}
					</div>
				{/each}
			</div>

			<div class="p-3 border-t border-white/[0.06] space-y-2 text-[10px] font-mono">
				<div class="flex items-center justify-between text-muted">
					<span class="flex items-center gap-1"><Zap class="w-3 h-3" />Prompt</span>
					<span class="text-secondary tabular-nums">{formatTokens(tokenUsage.promptTokens)}</span>
				</div>
				<div class="flex items-center justify-between text-muted">
					<span class="flex items-center gap-1"><Wifi class="w-3 h-3" />Completion</span>
					<span class="text-secondary tabular-nums">{formatTokens(tokenUsage.completionTokens)}</span>
				</div>
				<div class="flex items-center justify-between text-muted">
					<span class="flex items-center gap-1"><Hash class="w-3 h-3" />Total</span>
					<span class="text-cta font-semibold tabular-nums">{formatTokens(tokenUsage.totalTokens)}</span>
				</div>
			</div>
		</div>

		<!-- Right Panel: Chat Area -->
		<div class="flex-1 flex flex-col min-w-0 bg-background">
			{#if selectedModel && selectedProvider}
				<!-- Chat header -->
				<div class="shrink-0 px-3 sm:px-4 py-2.5 sm:py-3 border-b border-white/[0.06] flex items-center gap-2 sm:gap-3 bg-surface">
					<!-- Mobile menu toggle -->
					<button
						class="lg:hidden p-1.5 rounded-lg hover:bg-surface-hover text-muted hover:text-secondary transition-colors shrink-0"
						onclick={() => (mobilePanelOpen = true)}
						aria-label="选择模型"
						title="选择模型"
					>
						<Menu class="w-4 h-4" stroke-width={1.5} />
					</button>
					<div class="flex items-center gap-1.5 sm:gap-2 min-w-0">
						<Bot class="w-4 h-4 text-cta shrink-0" stroke-width={1.5} />
						<span class="font-semibold text-xs sm:text-sm text-primary truncate">{selectedProvider.name}</span>
						<span class="text-muted text-xs hidden sm:inline">/</span>
						<span class="font-mono text-[10px] sm:text-xs text-secondary truncate">{selectedModel}</span>
					</div>
					<div class="flex-1"></div>
					{#if messages.length > 0}
						<button
							class="text-[10px] text-muted hover:text-danger transition-colors flex items-center gap-1 px-1.5 sm:px-2 py-1 rounded-md hover:bg-danger-subtle shrink-0"
							onclick={clearChat}
							title="清空对话"
						>
							<Trash2 class="w-3 h-3" />
							<span class="hidden sm:inline">清空</span>
						</button>
					{/if}
					{#if tokenUsage.totalTokens > 0}
						<span class="text-[10px] font-mono text-muted hidden sm:inline shrink-0">
							Prompt {tokenUsage.promptTokens} · Completion {tokenUsage.completionTokens}
						</span>
					{/if}
				</div>

				<!-- Messages -->
				<div bind:this={messagesEl} class="flex-1 overflow-y-auto px-3 sm:px-4 py-3 sm:py-4 space-y-3 sm:space-y-4">
					{#if messages.length === 0}
						<div class="flex items-center justify-center h-full">
							<div class="text-center text-muted max-w-sm px-4">
								<MessageSquare class="w-8 h-8 mx-auto mb-3 opacity-40" stroke-width={1.5} />
								<p class="text-sm">开始与 {selectedModel} 对话</p>
								<p class="text-[10px] mt-1">消息缓存于本地，刷新不丢失</p>
							</div>
						</div>
					{/if}

					{#each messages as msg, i (i)}
						{#if msg.role === "divider"}
							<div class="flex items-center gap-2 sm:gap-3 py-1">
								<div class="flex-1 h-px bg-white/[0.06]"></div>
								<span class="text-[10px] text-muted font-mono shrink-0">切换至 {msg.content}</span>
								<div class="flex-1 h-px bg-white/[0.06]"></div>
							</div>
						{:else}
							<div class="flex gap-2 sm:gap-3 {msg.role === 'user' ? 'justify-end' : ''}">
								{#if msg.role === 'assistant'}
									<div class="shrink-0 w-6 h-6 sm:w-7 sm:h-7 rounded-lg bg-cta-subtle flex items-center justify-center mt-0.5">
										<Bot class="w-3 sm:w-3.5 h-3 sm:h-3.5 text-cta" stroke-width={1.5} />
									</div>
								{/if}

								<div class="max-w-[92%] sm:max-w-[85%] {msg.role === 'user'
									? 'bg-cta-subtle text-primary rounded-2xl rounded-br-md px-3 sm:px-4 py-2 sm:py-2.5'
									: 'text-secondary'}">
									{#if msg.reasoning}
										<details class="mb-2">
											<summary class="text-[10px] text-muted cursor-pointer font-mono uppercase tracking-wider">
												思考过程
											</summary>
											<div class="mt-1 text-[10px] sm:text-[11px] text-muted">
												<Markdown text={msg.reasoning} />
											</div>
										</details>
									{/if}
									{#if msg.role === "assistant" && msg.content}
										<div class="text-xs sm:text-sm">
											<Markdown text={msg.content} />
										</div>
									{:else if msg.role === "user"}
										<div class="text-xs sm:text-sm leading-relaxed whitespace-pre-wrap break-words">
											{msg.content}
										</div>
									{:else if streaming && i === messages.length - 1}
										<span class="text-xs sm:text-sm text-muted animate-pulse">▌</span>
									{/if}
									{#if streaming && i === messages.length - 1 && msg.role === 'assistant' && msg.content}
										<span class="inline-block w-1 sm:w-1.5 h-3 sm:h-4 bg-cta animate-pulse ml-0.5 align-text-bottom"></span>
									{/if}
								</div>

								{#if msg.role === 'user'}
									<div class="shrink-0 w-6 h-6 sm:w-7 sm:h-7 rounded-lg bg-white/[0.06] flex items-center justify-center mt-0.5">
										<User class="w-3 sm:w-3.5 h-3 sm:h-3.5 text-muted" stroke-width={1.5} />
									</div>
								{/if}
							</div>
						{/if}
					{/each}
				</div>

				<!-- Input area -->
				<div class="shrink-0 p-2 sm:p-3 border-t border-white/[0.06] bg-surface">
					<div class="flex gap-1.5 sm:gap-2 items-end">
						<textarea
							bind:this={inputEl}
							bind:value={inputText}
							onkeydown={handleKeydown}
							oninput={(e) => adjustHeight(inputEl)}
							rows="1"
							placeholder="输入消息... Enter 发送"
							title="Enter 发送, Shift+Enter 换行"
							disabled={!selectedModel || streaming}
							class="flex-1 resize-none bg-input border border-white/[0.10] rounded-xl px-3 sm:px-4 py-2 sm:py-2.5
							       text-sm text-primary placeholder:text-placeholder
							       focus:outline-none focus:ring-2 focus:ring-cta/40 focus:border-white/[0.20]
							       disabled:opacity-40 transition-all duration-200 max-h-40"
						></textarea>

						{#if streaming}
							<button
								class="shrink-0 w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-danger-subtle text-danger
								       hover:bg-danger/20 transition-all duration-150
								       flex items-center justify-center"
								onclick={stopStream}
								title="停止生成"
							>
								<svg class="w-3.5 sm:w-4 h-3.5 sm:h-4" viewBox="0 0 24 24" fill="currentColor">
									<rect x="4" y="4" width="16" height="16" rx="2" />
								</svg>
							</button>
						{:else}
							<button
								class="shrink-0 w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-cta hover:bg-cta-hover
								       disabled:opacity-30 transition-all duration-150
								       flex items-center justify-center
								       shadow-glow-cta active:scale-95"
								disabled={!inputText.trim() || !selectedModel}
								onclick={sendMessage}
								title="发送"
							>
								<Send class="w-3.5 sm:w-4 h-3.5 sm:h-4 text-white" stroke-width={2} />
							</button>
						{/if}
					</div>
				</div>
			{:else}
				<!-- Empty state -->
				<div class="flex-1 flex items-center justify-center">
					<div class="text-center text-muted max-w-sm px-4">
						<MessageSquare class="w-10 sm:w-12 h-10 sm:h-12 mx-auto mb-4 opacity-30" stroke-width={1} />
						<p class="text-sm sm:text-base font-semibold text-secondary">Vega API 模型调试</p>
						<p class="text-xs sm:text-sm mt-2">
							点击 <span class="text-cta lg:hidden">左上角菜单</span><span class="hidden lg:inline">左侧列表</span> 选择模型开始对话
						</p>
						<p class="text-[10px] mt-1">支持流式输出 · 实时 Token 统计</p>
					</div>
				</div>
			{/if}
		</div>
	</div>
{/if}
