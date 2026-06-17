<script lang="ts">
	import { formatTime, formatDuration } from "$lib/utils";
	import type { LogEntry } from "$lib/api";

	let {
		entries = [] as LogEntry[],
		loading = false,
		visibleColumns = [
			'time', 'ip', 'provider', 'model', 'stream', 'tokens', 'duration', 'status', 'keyName',
		] as string[],
		onRowClick = (_: LogEntry) => {},
	} = $props();

	function hasCol(name: string): boolean {
		return visibleColumns.includes(name);
	}

	function tokenDisplay(entry: LogEntry): string {
		const p = entry.promptTokens.toLocaleString();
		const c = entry.completionTokens.toLocaleString();
		if (entry.cacheCreationInputTokens > 0) {
			return `${p}(${entry.cacheCreationInputTokens.toLocaleString()}未命中) / ${c}`;
		}
		if (entry.cacheReadInputTokens > 0) {
			return `${p}(${entry.cacheReadInputTokens.toLocaleString()}缓存) / ${c}`;
		}
		return `${p} / ${c}`;
	}
</script>

<div class="space-y-4">
	<!-- Content -->
	{#if loading && entries.length === 0}
		<div class="space-y-3">
			{#each Array(5) as _}
				<div class="bg-surface border border-white/[0.06] rounded-xl p-4 h-[52px] shimmer-skeleton"></div>
			{/each}
		</div>
	{:else if entries.length === 0}
		<div class="bg-surface border border-white/[0.06] border-dashed rounded-2xl p-10 sm:p-12 text-center">
			<p class="text-muted text-sm">暂无调用记录</p>
			<p class="text-placeholder text-xs mt-1">发送 API 请求后，调用记录将显示在这里</p>
		</div>
	{:else}
		<!-- Desktop table -->
		<div class="hidden sm:block bg-surface border border-white/[0.06] rounded-xl overflow-hidden overflow-x-auto">
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-white/[0.06]">
						{#if hasCol('time')}
							<th class="text-left px-4 py-3 text-[10px] text-muted uppercase tracking-wider font-semibold">时间</th>
						{/if}
						{#if hasCol('ip')}
							<th class="text-left px-4 py-3 text-[10px] text-muted uppercase tracking-wider font-semibold">IP</th>
						{/if}
						{#if hasCol('provider')}
							<th class="text-left px-4 py-3 text-[10px] text-muted uppercase tracking-wider font-semibold">提供商</th>
						{/if}
						{#if hasCol('model')}
							<th class="text-left px-4 py-3 text-[10px] text-muted uppercase tracking-wider font-semibold">模型</th>
						{/if}
						{#if hasCol('keyName')}
							<th class="text-left px-4 py-3 text-[10px] text-muted uppercase tracking-wider font-semibold">密钥</th>
						{/if}
						{#if hasCol('stream')}
							<th class="text-center px-2 py-3 text-[10px] text-muted uppercase tracking-wider font-semibold">流式</th>
						{/if}
						{#if hasCol('tokens')}
							<th class="text-right px-4 py-3 text-[10px] text-muted uppercase tracking-wider font-semibold">Tokens</th>
						{/if}
						{#if hasCol('duration')}
							<th class="text-right px-4 py-3 text-[10px] text-muted uppercase tracking-wider font-semibold">耗时</th>
						{/if}
						{#if hasCol('status')}
							<th class="text-center px-4 py-3 text-[10px] text-muted uppercase tracking-wider font-semibold">状态</th>
						{/if}
					</tr>
				</thead>
				<tbody>
					{#each entries as entry (entry.id)}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<tr
							class="border-b border-white/[0.03] hover:bg-surface-hover transition-colors cursor-pointer"
							onclick={() => onRowClick(entry)}
							onkeydown={(e) => { if (e.key === 'Enter') onRowClick(entry); }}
							role="button"
							tabindex="0"
						>
							{#if hasCol('time')}
								<td class="px-4 py-2.5 text-secondary font-mono text-xs whitespace-nowrap">{formatTime(entry.timestamp)}</td>
							{/if}
							{#if hasCol('ip')}
								<td class="px-4 py-2.5 text-muted font-mono text-xs">{entry.ip}</td>
							{/if}
							{#if hasCol('provider')}
								<td class="px-4 py-2.5 text-secondary text-xs">{entry.providerId}</td>
							{/if}
							{#if hasCol('model')}
								<td class="px-4 py-2.5 text-secondary font-mono text-xs max-w-[160px] truncate">{entry.model}</td>
							{/if}
							{#if hasCol('keyName')}
								<td class="px-4 py-2.5 text-secondary text-xs max-w-[100px] truncate">{entry.apiKeyName || '—'}</td>
							{/if}
							{#if hasCol('stream')}
								<td class="px-2 py-2.5 text-center">
									{#if entry.isStream}
										<span class="text-[10px] px-1.5 py-0.5 rounded-full font-semibold bg-cta-subtle text-cta">流</span>
									{:else}
										<span class="text-[10px] text-placeholder">—</span>
									{/if}
								</td>
							{/if}
							{#if hasCol('tokens')}
								<td class="px-4 py-2.5 text-muted font-mono text-xs text-right tabular-nums">
									{#if entry.cacheCreationInputTokens > 0 || entry.cacheReadInputTokens > 0}
										<span class="text-accent">{entry.promptTokens.toLocaleString()}</span>
										<span class="text-warning">
											({(entry.cacheCreationInputTokens || entry.cacheReadInputTokens).toLocaleString()}{entry.cacheCreationInputTokens > 0 ? '未命中' : '缓存'})
										</span>
										<span class="text-muted"> / </span>
									{:else}
										<span class="text-accent">{entry.promptTokens.toLocaleString()}</span>
										<span class="text-muted"> / </span>
									{/if}
									<span class="text-cta">{entry.completionTokens.toLocaleString()}</span>
								</td>
							{/if}
							{#if hasCol('duration')}
								<td class="px-4 py-2.5 text-muted font-mono text-xs text-right tabular-nums">
									{formatDuration(entry.durationMs)}
								</td>
							{/if}
							{#if hasCol('status')}
								<td class="px-4 py-2.5 text-center">
									<span
										class="text-[10px] px-2 py-0.5 rounded-full font-semibold {entry.success ? 'bg-success-subtle text-success' : 'bg-danger-subtle text-danger'}"
										title={!entry.success && entry.extra?.errorMessage ? entry.extra.errorMessage : ''}
									>
										{entry.success ? '成功' : '失败'}
									</span>
								</td>
							{/if}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		<!-- Mobile cards -->
		<div class="sm:hidden space-y-3">
			{#each entries as entry (entry.id)}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="bg-surface border border-white/[0.06] rounded-xl p-4 space-y-2.5 cursor-pointer hover:bg-surface-hover transition-colors"
					onclick={() => onRowClick(entry)}
					onkeydown={(e) => { if (e.key === 'Enter') onRowClick(entry); }}
					role="button"
					tabindex="0"
				>
					<div class="flex items-center justify-between">
						<span class="font-mono text-xs text-secondary">{formatTime(entry.timestamp)}</span>
						<div class="flex items-center gap-1.5">
							{#if hasCol('stream') && entry.isStream}
								<span class="text-[10px] px-1.5 py-0.5 rounded-full font-semibold bg-cta-subtle text-cta">流式</span>
							{/if}
							{#if hasCol('status')}
								<span
									class="text-[10px] px-2 py-0.5 rounded-full font-semibold {entry.success ? 'bg-success-subtle text-success' : 'bg-danger-subtle text-danger'}"
									title={!entry.success && entry.extra?.errorMessage ? entry.extra.errorMessage : ''}
								>
									{entry.success ? '成功' : '失败'}
								</span>
							{/if}
						</div>
					</div>
					<div class="grid grid-cols-2 gap-2 text-xs">
						{#if hasCol('ip')}
							<div class="col-span-2"><span class="text-muted">IP: </span><span class="text-secondary font-mono">{entry.ip}</span></div>
						{/if}
						{#if hasCol('provider')}
							<div class="col-span-2"><span class="text-muted">提供商: </span><span class="text-secondary">{entry.providerId}</span></div>
						{/if}
						{#if hasCol('model')}
							<div class="col-span-2"><span class="text-muted">模型: </span><span class="text-secondary font-mono break-all">{entry.model}</span></div>
						{/if}
						{#if hasCol('keyName')}
							<div class="col-span-2"><span class="text-muted">密钥: </span><span class="text-secondary">{entry.apiKeyName || '—'}</span></div>
						{/if}
						<div class="col-span-2 flex gap-3 flex-wrap">
							{#if hasCol('tokens')}
								<span class="text-muted">Prompt: <span class="text-accent font-mono tabular-nums">{entry.promptTokens.toLocaleString()}</span>
									{#if entry.cacheCreationInputTokens > 0}
										<span class="text-warning">({entry.cacheCreationInputTokens.toLocaleString()}未命中)</span>
									{/if}
								</span>
								<span class="text-muted">Completion: <span class="text-cta font-mono tabular-nums">{entry.completionTokens.toLocaleString()}</span></span>
							{/if}
							{#if hasCol('duration')}
								<span class="text-muted">耗时: <span class="text-secondary font-mono">{formatDuration(entry.durationMs)}</span></span>
							{/if}
						</div>
						{#if !entry.success && entry.extra?.errorMessage}
							<div class="col-span-2"><span class="text-danger text-[11px]">{entry.extra.errorMessage.slice(0, 120)}</span></div>
						{/if}
					</div>
				</div>
			{/each}
		</div>

		<div class="text-xs text-muted text-right">
			{entries.length} 条记录
		</div>
	{/if}
</div>
