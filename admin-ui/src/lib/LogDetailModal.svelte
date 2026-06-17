<script lang="ts">
	import type { LogEntry } from "$lib/api";
	import { formatTime, formatDuration } from "$lib/utils";
	import { X } from "lucide-svelte";

	let {
		entry = null as LogEntry | null,
		open = false,
		onclose = () => {},
	} = $props();

	$effect(() => {
		if (open) {
			document.body.style.overflow = 'hidden';
		} else {
			document.body.style.overflow = '';
		}
		return () => { document.body.style.overflow = ''; };
	});

	function formatExtra(extra: Record<string, string>): string {
		const keys = Object.keys(extra);
		if (keys.length === 0) return '(无)';
		return keys.map(k => `${k}: ${extra[k]}`).join('\n');
	}
</script>

{#if open && entry}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
		onclick={onclose}
		onkeydown={(e) => { if (e.key === 'Escape') onclose(); }}
		role="dialog"
		tabindex="-1"
	>
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<div
			class="bg-surface border border-white/[0.08] rounded-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto shadow-2xl"
			onclick={(e: Event) => e.stopPropagation()}
			onkeydown={(e: Event) => { if (e instanceof KeyboardEvent && e.key === 'Escape') onclose(); }}
			role="document"
		>
			<!-- Header -->
			<div class="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
				<div>
					<h2 class="text-sm font-bold text-primary font-mono">调用详情 #{entry.id}</h2>
					<p class="text-[10px] text-muted font-mono mt-0.5">{entry.requestId || '无 Request ID'}</p>
				</div>
				<button
					class="p-1.5 rounded-lg hover:bg-surface-hover text-muted hover:text-secondary transition-all"
					onclick={onclose}
				>
					<X class="w-4 h-4" />
				</button>
			</div>

			<!-- Body -->
			<div class="px-6 py-4 space-y-3 text-sm">
				<div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
					<span class="text-muted">时间</span>
					<span class="text-secondary font-mono">{entry.timestamp}</span>

					<span class="text-muted">IP</span>
					<span class="text-secondary font-mono">{entry.ip}</span>

					<span class="text-muted">提供商</span>
					<span class="text-secondary">{entry.providerId}</span>

					<span class="text-muted">模型</span>
					<span class="text-secondary font-mono">{entry.model}</span>

					<span class="text-muted">密钥</span>
					<span class="text-secondary">{entry.apiKeyName || '(未记录)'}</span>

					<span class="text-muted">流式</span>
					<span class="text-secondary">
						{#if entry.isStream}
							<span class="text-[10px] px-1.5 py-0.5 rounded-full font-semibold bg-cta-subtle text-cta">流式</span>
						{:else}
							非流式
						{/if}
					</span>

					<span class="text-muted">状态</span>
					<span class="text-secondary">
						<span class="text-[10px] px-2 py-0.5 rounded-full font-semibold {entry.success ? 'bg-success-subtle text-success' : 'bg-danger-subtle text-danger'}">
							{entry.success ? '成功' : '失败'}
						</span>
					</span>

					<span class="text-muted">耗时</span>
					<span class="text-secondary font-mono">{formatDuration(entry.durationMs)} ({entry.durationMs}ms)</span>
				</div>

				<!-- Token breakdown -->
				<div class="border-t border-white/[0.06] pt-3">
					<h3 class="text-[10px] text-muted uppercase tracking-wider font-semibold mb-2">Token 明细</h3>
					<div class="grid grid-cols-2 gap-2 text-xs">
						<div class="bg-white/[0.03] rounded-lg px-3 py-2">
							<div class="text-muted">输入 Token</div>
							<div class="text-accent font-mono tabular-nums text-sm">{entry.promptTokens.toLocaleString()}</div>
						</div>
						<div class="bg-white/[0.03] rounded-lg px-3 py-2">
							<div class="text-muted">输出 Token</div>
							<div class="text-cta font-mono tabular-nums text-sm">{entry.completionTokens.toLocaleString()}</div>
						</div>
						<div class="bg-white/[0.03] rounded-lg px-3 py-2">
							<div class="text-muted">总计</div>
							<div class="text-primary font-mono tabular-nums text-sm">{(entry.promptTokens + entry.completionTokens).toLocaleString()}</div>
						</div>
						<div class="bg-white/[0.03] rounded-lg px-3 py-2">
							<div class="text-muted">缓存命中</div>
							<div class="text-warning font-mono tabular-nums text-sm">
								{#if entry.cacheReadInputTokens > 0}
									{entry.cacheReadInputTokens.toLocaleString()} 命中
								{:else if entry.cacheCreationInputTokens > 0}
									{entry.cacheCreationInputTokens.toLocaleString()} 未命中
								{:else}
									—
								{/if}
							</div>
						</div>
					</div>
					{#if entry.cacheReadInputTokens > 0 || entry.cacheCreationInputTokens > 0}
						<div class="mt-2 text-[10px] text-muted">
							缓存读取: {entry.cacheReadInputTokens.toLocaleString()} | 缓存创建: {entry.cacheCreationInputTokens.toLocaleString()}
						</div>
					{/if}
				</div>

				<!-- Extra / Error -->
				<div class="border-t border-white/[0.06] pt-3">
					<h3 class="text-[10px] text-muted uppercase tracking-wider font-semibold mb-2">
						{#if !entry.success && entry.extra?.errorMessage}
							错误信息
						{:else}
							附加信息
						{/if}
					</h3>
					<pre class="text-xs text-secondary font-mono bg-white/[0.03] rounded-lg px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all max-h-[200px] overflow-y-auto">{formatExtra(entry.extra)}</pre>
				</div>
			</div>
		</div>
	</div>
{/if}
