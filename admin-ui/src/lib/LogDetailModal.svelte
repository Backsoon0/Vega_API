<script lang="ts">
	import type { LogEntry } from "$lib/api";
	import { formatTime, formatDuration } from "$lib/utils";

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

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onclose();
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if open && entry}
	<div class="modal-wrap on" role="dialog" aria-modal="true" aria-label={`调用详情 #${entry.id}`}>
		<button type="button" class="modal-scrim" onclick={onclose} tabindex="-1" aria-label="关闭"></button>
		<div class="modal-panel" role="document">
			<div class="modal-head">
				<h3>调用详情 #{entry.id}</h3>
				<button class="icon-btn" onclick={onclose} aria-label="关闭">
					<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 6 6 18M6 6l12 12" /></svg>
				</button>
			</div>
			<div class="modal-body">
				<div style="position:relative">
					<p style="font-family:var(--font-mono);font-size:11px;color:var(--muted);margin-bottom:14px">{entry.requestId || '无 Request ID'}</p>
				</div>
				<div style="display:grid;grid-template-columns:auto 1fr;gap:8px 16px;font-size:12.5px">
					<span style="color:var(--muted)">时间</span>
					<span style="color:var(--fg-2);font-family:var(--font-mono)">{entry.timestamp}</span>
					<span style="color:var(--muted)">IP</span>
					<span style="color:var(--fg-2);font-family:var(--font-mono)">{entry.ip}</span>
					<span style="color:var(--muted)">提供商</span>
					<span style="color:var(--fg-2)">{entry.providerId}</span>
					<span style="color:var(--muted)">模型</span>
					<span style="color:var(--fg-2);font-family:var(--font-mono)">{entry.model}</span>
					<span style="color:var(--muted)">密钥</span>
					<span style="color:var(--fg-2)">{entry.apiKeyName || '(未记录)'}</span>
					<span style="color:var(--muted)">流式</span>
					<span>{#if entry.isStream}<span class="chip chip-cta">流式</span>{:else}非流式{/if}</span>
					<span style="color:var(--muted)">状态</span>
					<span><span class="chip {entry.success ? 'chip-accent' : 'chip-danger'}"><span class="c-dot" style="background:currentColor"></span>{entry.success ? "成功" : "失败"}</span></span>
					<span style="color:var(--muted)">耗时</span>
					<span style="color:var(--fg-2);font-family:var(--font-mono)">{formatDuration(entry.durationMs)} ({entry.durationMs}ms)</span>
				</div>

				<!-- Token breakdown -->
				<div style="border-top:1px solid var(--b-sub);padding-top:14px;margin-top:14px">
					<h4 style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:600;margin-bottom:8px">Token 明细</h4>
					<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;font-size:12px">
						<div style="background:var(--surface-3);border-radius:10px;padding:10px 12px"><div style="color:var(--muted)">输入 Token</div><div style="color:var(--success);font-family:var(--font-mono);font-variant-numeric:tabular-nums;font-size:14px;margin-top:2px">{entry.promptTokens.toLocaleString()}</div></div>
						<div style="background:var(--surface-3);border-radius:10px;padding:10px 12px"><div style="color:var(--muted)">输出 Token</div><div style="color:var(--cta);font-family:var(--font-mono);font-variant-numeric:tabular-nums;font-size:14px;margin-top:2px">{entry.completionTokens.toLocaleString()}</div></div>
						<div style="background:var(--surface-3);border-radius:10px;padding:10px 12px"><div style="color:var(--muted)">总计</div><div style="color:var(--fg);font-family:var(--font-mono);font-variant-numeric:tabular-nums;font-size:14px;margin-top:2px">{(entry.promptTokens + entry.completionTokens).toLocaleString()}</div></div>
						<div style="background:var(--surface-3);border-radius:10px;padding:10px 12px"><div style="color:var(--muted)">缓存命中</div><div style="color:var(--warning);font-family:var(--font-mono);font-variant-numeric:tabular-nums;font-size:14px;margin-top:2px">{#if entry.cacheReadInputTokens > 0}{entry.cacheReadInputTokens.toLocaleString()} 命中{:else if entry.cacheCreationInputTokens > 0}{entry.cacheCreationInputTokens.toLocaleString()} 未命中{:else}—{/if}</div></div>
					</div>
					{#if entry.cacheReadInputTokens > 0 || entry.cacheCreationInputTokens > 0}
						<div style="margin-top:6px;font-size:10px;color:var(--muted)">缓存读取: {entry.cacheReadInputTokens.toLocaleString()} | 缓存创建: {entry.cacheCreationInputTokens.toLocaleString()}</div>
					{/if}
				</div>

				<!-- Extra / Error -->
				<div style="border-top:1px solid var(--b-sub);padding-top:14px;margin-top:14px">
					<h4 style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:600;margin-bottom:8px">
						{#if !entry.success && entry.extra?.errorMessage}错误信息{:else}附加信息{/if}
					</h4>
					<pre style="font-size:12px;color:var(--fg-2);font-family:var(--font-mono);background:var(--surface-3);border-radius:10px;padding:10px 12px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;max-height:200px;overflow-y:auto">{formatExtra(entry.extra)}</pre>
				</div>
			</div>
		</div>
	</div>
{/if}
