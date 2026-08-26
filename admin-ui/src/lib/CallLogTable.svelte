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
	{#if loading && entries.length === 0}
		<div class="space-y-3">
			{#each Array(5) as _}
				<div class="card" style="height:52px;padding:14px 16px">
					<div class="shimmer-skeleton" style="height:24px;border-radius:8px"></div>
				</div>
			{/each}
		</div>
	{:else if entries.length === 0}
		<div class="card" style="padding:40px 16px;text-align:center;color:var(--muted)">
			<p style="font-size:14px">暂无调用记录</p>
			<p style="font-size:12px;color:var(--placeholder);margin-top:4px">发送 API 请求后，调用记录将显示在这里</p>
		</div>
	{:else}
		<!-- Desktop table -->
		<div class="card log-table-card">
			<div class="table-wrap">
				<table class="tbl">
					<thead>
						<tr>
							{#if hasCol('time')}<th>时间</th>{/if}
							{#if hasCol('ip')}<th>IP</th>{/if}
							{#if hasCol('provider')}<th>提供商</th>{/if}
							{#if hasCol('model')}<th>模型</th>{/if}
							{#if hasCol('keyName')}<th>密钥</th>{/if}
							{#if hasCol('stream')}<th>流式</th>{/if}
							{#if hasCol('tokens')}<th class="right">Tokens</th>{/if}
							{#if hasCol('duration')}<th class="right">耗时</th>{/if}
							{#if hasCol('status')}<th>状态</th>{/if}
						</tr>
					</thead>
					<tbody>
						{#each entries as entry (entry.id)}
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<tr onclick={() => onRowClick(entry)} onkeydown={(e) => { if (e.key === 'Enter') onRowClick(entry); }} role="button" tabindex="0">
								{#if hasCol('time')}<td class="mono" style="color:var(--muted)">{formatTime(entry.timestamp)}</td>{/if}
								{#if hasCol('ip')}<td class="mono">{entry.ip}</td>{/if}
								{#if hasCol('provider')}<td>{entry.providerId}</td>{/if}
								{#if hasCol('model')}<td class="mono">{entry.model}</td>{/if}
								{#if hasCol('keyName')}<td style="max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{entry.apiKeyName || "—"}</td>{/if}
								{#if hasCol('stream')}
									<td>
										{#if entry.isStream}
											<span class="chip chip-cta">流</span>
										{:else}
											<span style="color:var(--placeholder)">—</span>
										{/if}
									</td>
								{/if}
								{#if hasCol('tokens')}
									<td class="num right">
										{#if entry.cacheCreationInputTokens > 0 || entry.cacheReadInputTokens > 0}
											<span style="color:var(--success)">{entry.promptTokens.toLocaleString()}</span>
											<span style="color:var(--warning)">({(entry.cacheCreationInputTokens || entry.cacheReadInputTokens).toLocaleString()}{entry.cacheCreationInputTokens > 0 ? "未命中" : "缓存"})</span>
											<span style="color:var(--muted)"> / </span>
										{:else}
											<span style="color:var(--success)">{entry.promptTokens.toLocaleString()}</span>
											<span style="color:var(--muted)"> / </span>
										{/if}
										<span style="color:var(--cta)">{entry.completionTokens.toLocaleString()}</span>
									</td>
								{/if}
								{#if hasCol('duration')}<td class="num right" style="color:var(--muted)">{formatDuration(entry.durationMs)}</td>{/if}
								{#if hasCol('status')}
									<td>
										<span class="chip {entry.success ? 'chip-accent' : 'chip-danger'}" title={!entry.success && entry.extra?.errorMessage ? entry.extra.errorMessage : ""}>
											<span class="c-dot" style="background:currentColor"></span>{entry.success ? "成功" : "失败"}
										</span>
									</td>
								{/if}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>

		<!-- Mobile card list -->
		<div class="log-cards">
			{#each entries as entry (entry.id)}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="log-card {entry.success ? '' : 'is-err'}" role="button" tabindex="0" onclick={() => onRowClick(entry)} onkeydown={(e) => { if (e.key === 'Enter') onRowClick(entry); }}>
					<div class="lc-top">
						<span class="mono">{formatTime(entry.timestamp)}</span>
						<div class="lc-badges">
							{#if hasCol('stream') && entry.isStream}<span class="chip chip-cta">流式</span>{/if}
							<span class="chip {entry.success ? 'chip-accent' : 'chip-danger'}"><span class="c-dot" style="background:currentColor"></span>{entry.success ? "成功" : "失败"}</span>
						</div>
					</div>
					<div class="lc-line"><span class="lb">IP:</span> {entry.ip}</div>
					<div class="lc-line"><span class="lb">提供商:</span> {entry.providerId}</div>
					<div class="lc-line"><span class="lb">模型:</span> <span class="mono">{entry.model}</span></div>
					<div class="lc-line"><span class="lb">密钥:</span> {entry.apiKeyName || "—"}</div>
					<div class="lc-stats">
						<span class="lb">Prompt:</span>
						<span style="color:var(--success);font-family:var(--font-mono);font-variant-numeric:tabular-nums">{entry.promptTokens.toLocaleString()}</span>
						<span class="lb">Completion:</span>
						<span style="color:var(--cta);font-family:var(--font-mono);font-variant-numeric:tabular-nums">{entry.completionTokens.toLocaleString()}</span>
						<span class="lb">耗时:</span>
						<span style="font-family:var(--font-mono)">{formatDuration(entry.durationMs)}</span>
					</div>
					{#if !entry.success && entry.extra?.errorMessage}
						<div class="lc-err">{entry.extra.errorMessage.slice(0, 160)}</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
