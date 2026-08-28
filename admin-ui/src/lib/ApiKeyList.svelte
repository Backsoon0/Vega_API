<script lang="ts">
	import { getApiKeys, createApiKey, deleteApiKey, renameApiKey, updateApiKeyQuota, deleteLegacyKey, migrateLegacyKey, type ApiKeyInfo, type ApiKeyQuotaInput } from "$lib/api";
	import { toasts } from "$lib/toast-store";
	import Spinner from "$lib/Spinner.svelte";

	let keys = $state<ApiKeyInfo[]>([]);
	let hasLegacyKey = $state(false);
	let loading = $state(true);
	let showInput = $state(false);
	let newKeyName = $state('');
	let newKeyValue = $state('');
	let newQuotaCalls = $state('');
	let newQuotaTokens = $state('');
	let newQuotaPeriod = $state<'day' | 'month'>('day');
	let revealedKey = $state('');
	let revealedName = $state('');
	let copying = $state(false);
	let renamingId = $state(0);
	let renameName = $state('');
	let quotaId = $state(0);
	let quotaCalls = $state('');
	let quotaTokens = $state('');
	let quotaPeriod = $state<'day' | 'month'>('day');
	let showMigrate = $state(false);
	let migrateName = $state('');

	/** '' / invalid → null (unlimited); otherwise clamped non-negative int. */
	function parseQuota(v: string): number | null {
		if (v.trim() === '') return null;
		const n = Math.floor(Number(v));
		return Number.isFinite(n) && n >= 0 ? n : null;
	}

	const PERIOD_LABEL: Record<'day' | 'month', string> = { day: '天', month: '月' };

	function quotaSummary(k: ApiKeyInfo): string {
		const parts: string[] = [];
		if (k.quotaCalls != null) parts.push(`调用 ${k.usageCalls}/${k.quotaCalls}`);
		if (k.quotaTokens != null) parts.push(`Token ${k.usageTokens.toLocaleString()}/${k.quotaTokens.toLocaleString()}`);
		if (parts.length === 0) return '不限量';
		return parts.join(' · ') + ` /${PERIOD_LABEL[k.quotaPeriod]}`;
	}

	function isQuotaExceeded(k: ApiKeyInfo): boolean {
		return (
			(k.quotaCalls != null && k.usageCalls >= k.quotaCalls) ||
			(k.quotaTokens != null && k.usageTokens >= k.quotaTokens)
		);
	}

	async function load() {
		try {
			const data = await getApiKeys();
			keys = data.keys || [];
			hasLegacyKey = data.hasLegacyKey || false;
		} catch (err: any) {
			toasts.show(err.message, 'error');
		} finally {
			loading = false;
		}
	}

	function buildQuota(): ApiKeyQuotaInput | undefined {
		const calls = parseQuota(newQuotaCalls);
		const tokens = parseQuota(newQuotaTokens);
		if (calls == null && tokens == null) return undefined;
		return { quotaCalls: calls, quotaTokens: tokens, quotaPeriod: newQuotaPeriod };
	}

	async function handleGenerate() {
		const name = newKeyName.trim();
		if (!name) {
			toasts.show('请输入密钥名称', 'error');
			return;
		}
		try {
			const quota = buildQuota();
			const result = await createApiKey(name, undefined, true, quota);
			revealedKey = result.fullKey;
			revealedName = name;
			showInput = false;
			newKeyName = '';
			newQuotaCalls = '';
			newQuotaTokens = '';
			toasts.show(`密钥 "${name}" 已生成${quota ? '（含配额）' : ''}`);
			await load();
		} catch (err: any) {
			toasts.show(err.message, 'error');
		}
	}

	async function handleSet() {
		const name = newKeyName.trim();
		const k = newKeyValue.trim();
		if (!name) {
			toasts.show('请输入密钥名称', 'error');
			return;
		}
		if (!k || k.length < 8) {
			toasts.show('API Key 至少需要 8 个字符', 'error');
			return;
		}
		try {
			const quota = buildQuota();
			const result = await createApiKey(name, k, undefined, quota);
			revealedKey = result.fullKey;
			revealedName = name;
			showInput = false;
			newKeyName = '';
			newKeyValue = '';
			newQuotaCalls = '';
			newQuotaTokens = '';
			toasts.show(`密钥 "${name}" 已设置${quota ? '（含配额）' : ''}`);
			await load();
		} catch (err: any) {
			toasts.show(err.message, 'error');
		}
	}

	function startQuota(k: ApiKeyInfo) {
		quotaId = k.id;
		quotaCalls = k.quotaCalls != null ? String(k.quotaCalls) : '';
		quotaTokens = k.quotaTokens != null ? String(k.quotaTokens) : '';
		quotaPeriod = k.quotaPeriod;
	}

	function cancelQuota() {
		quotaId = 0;
		quotaCalls = '';
		quotaTokens = '';
	}

	async function handleSaveQuota() {
		if (!quotaId) return;
		const quota: ApiKeyQuotaInput = {
			quotaCalls: parseQuota(quotaCalls),
			quotaTokens: parseQuota(quotaTokens),
			quotaPeriod,
		};
		try {
			await updateApiKeyQuota(quotaId, quota);
			if (quota.quotaCalls == null && quota.quotaTokens == null) {
				toasts.show('配额已清除（不限量）');
			} else {
				toasts.show('配额已更新，立即生效');
			}
			cancelQuota();
			await load();
		} catch (err: any) {
			toasts.show(err.message, 'error');
		}
	}

	async function handleDelete(id: number, name: string) {
		if (!confirm(`确定删除密钥 "${name}" 吗？`)) return;
		try {
			await deleteApiKey(id);
			toasts.show(`密钥 "${name}" 已删除`);
			await load();
		} catch (err: any) {
			toasts.show(err.message, 'error');
		}
	}

	async function handleDeleteLegacy() {
		if (!confirm("确定删除旧版兼容密钥吗？")) return;
		try {
			await deleteLegacyKey();
			hasLegacyKey = false;
			toasts.show('旧版密钥已删除');
		} catch (err: any) {
			toasts.show(err.message, 'error');
		}
	}

	function startRename(id: number, name: string) {
		renamingId = id;
		renameName = name;
	}

	function cancelRename() {
		renamingId = 0;
		renameName = '';
	}

	async function handleRename() {
		const name = renameName.trim();
		if (!name) { toasts.show('名称不能为空', 'error'); return; }
		try {
			await renameApiKey(renamingId, name);
			toasts.show(`已重命名为 "${name}"`);
			cancelRename();
			await load();
		} catch (err: any) {
			toasts.show(err.message, 'error');
		}
	}

	async function handleMigrate() {
		const name = migrateName.trim();
		if (!name) { toasts.show('名称不能为空', 'error'); return; }
		try {
			const result = await migrateLegacyKey(name);
			toasts.show(`旧版密钥已迁移为 "${name}"`);
			showMigrate = false;
			migrateName = '';
			await load();
		} catch (err: any) {
			toasts.show(err.message, 'error');
		}
	}

	function hideRevealed() {
		revealedKey = '';
		revealedName = '';
	}

	async function handleCopy() {
		copying = true;
		try {
			await navigator.clipboard.writeText(revealedKey);
			toasts.show('已复制到剪贴板');
		} catch {
			toasts.show('复制失败，请手动选择复制', 'error');
		} finally {
			copying = false;
		}
	}

	function handleCancelInput() {
		showInput = false;
		newKeyName = '';
		newKeyValue = '';
		newQuotaCalls = '';
		newQuotaTokens = '';
	}

	$effect(() => { load(); });

	function fmtDate(iso: string | null): string {
		if (!iso) return '—';
		return new Date(iso).toLocaleString('zh-CN', { hour12: false });
	}
	function fmtDay(iso: string): string {
		return new Date(iso).toLocaleDateString('zh-CN');
	}
</script>

<div class="card" style="padding:6px">
	<!-- Header -->
	<div class="card-head" style="padding:16px 16px">
		<div class="row">
			<div style="width:32px;height:32px;border-radius:10px;display:grid;place-items:center;{keys.length > 0 || hasLegacyKey ? 'background:var(--accent-soft);color:var(--accent)' : 'background:var(--warning-soft);color:var(--warning)'}">
				<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
			</div>
			<div>
				<h2 style="font-size:13.5px;font-weight:600;color:var(--fg)">客户端 API Key</h2>
				<div style="font-size:11px;color:var(--muted);margin-top:2px;font-weight:400">多个密钥 · 独立命名与追踪</div>
			</div>
		</div>
		<button class="btn btn-soft btn-sm" onclick={() => { showInput = !showInput; hideRevealed(); }}>
			<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"><path d="M12 5v14M5 12h14" /></svg>
			新建密钥
		</button>
	</div>

	<!-- Loading -->
	{#if loading}
		<div class="row" style="padding:14px 16px;color:var(--muted);font-size:13px"><Spinner size="sm" /> 加载中...</div>
	{:else}
		{#if keys.length === 0 && !hasLegacyKey}
			<div class="row" style="margin:4px 16px;padding:12px 14px;border-radius:12px;background:var(--warning-soft);border:1px solid rgba(245,158,11,.2);color:var(--warning);font-size:13px">
				<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" style="flex-shrink:0"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
				<span>未设置密钥 — /v1/* 接口可公开访问</span>
			</div>
		{/if}

		{#if hasLegacyKey}
			<div style="margin:4px 16px;padding:12px 14px;border-radius:12px;background:var(--warning-soft);border:1px solid rgba(245,158,11,.2)">
				<div class="between" style="color:var(--warning);font-size:13px">
					<span class="row"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" style="flex-shrink:0"><path d="M10.3 3.2 2.3 18a2 2 0 0 0 1.7 3h16a2 2 0 0 0 1.7-3L13.7 3.2a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></svg> ← 旧版兼容密钥 (未命名)</span>
					<span class="row">
						<button class="btn btn-ghost btn-sm" onclick={() => { showMigrate = !showMigrate; migrateName = ''; }}>{showMigrate ? '取消' : '设置名称'}</button>
						<button class="btn btn-danger btn-sm" onclick={handleDeleteLegacy}>删除</button>
					</span>
				</div>
				{#if showMigrate}
					<div class="row" style="margin-top:10px">
						<input class="input" style="flex:1" bind:value={migrateName} placeholder="输入密钥名称" />
						<button class="btn btn-accent btn-sm" onclick={handleMigrate}>保存</button>
					</div>
				{/if}
			</div>
		{/if}

		{#each keys as k (k.id)}
			<div class="between" style="padding:11px 12px;border-radius:10px">
				<div class="row">
					<div style="width:32px;height:32px;border-radius:10px;display:grid;place-items:center;background:var(--cta-soft);color:var(--cta)">
						<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"><path d="M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5" /></svg>
					</div>
					<div>
						{#if renamingId === k.id}
							<div class="row">
								<input class="input" style="width:200px;padding:6px 10px;font-size:13px" bind:value={renameName} />
								<button class="btn btn-accent btn-sm" onclick={handleRename}>保存</button>
								<button class="btn btn-ghost btn-sm" onclick={cancelRename}>取消</button>
							</div>
						{:else}
							<div style="font-size:13px;color:var(--fg)">{k.name}</div>
						{/if}
						<div class="mono" style="font-size:11px;color:var(--muted)">创建 {fmtDay(k.createdAt)}{#if k.lastUsedAt}<span style="margin-left:8px">最近 {fmtDate(k.lastUsedAt)}</span>{/if}</div>
						<div style="font-size:11px;margin-top:3px">
							{#if quotaId === k.id}
								<div class="row" style="flex-wrap:wrap;gap:6px;margin-top:4px">
									<input class="input" style="width:92px;padding:5px 8px;font-size:12px" bind:value={quotaCalls} placeholder="调用上限" />
									<input class="input" style="width:110px;padding:5px 8px;font-size:12px" bind:value={quotaTokens} placeholder="Token 上限" />
									<select class="input" style="width:72px;padding:5px 6px;font-size:12px" bind:value={quotaPeriod}>
										<option value="day">每日</option>
										<option value="month">每月</option>
									</select>
									<button class="btn btn-accent btn-sm" onclick={handleSaveQuota}>保存</button>
									<button class="btn btn-ghost btn-sm" onclick={cancelQuota}>取消</button>
								</div>
							{:else}
								<span style="color:{k.quotaCalls == null && k.quotaTokens == null ? 'var(--muted)' : (isQuotaExceeded(k) ? 'var(--danger)' : 'var(--fg-2)')}">
									{#if k.quotaCalls != null || k.quotaTokens != null}
										<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" style="vertical-align:-1px;margin-right:3px"><path d="M12 2 4 5v6c0 5.25 3.4 10.74 8 11 4.6-.26 8-5.75 8-11V5z" /></svg>
									{/if}
									{quotaSummary(k)}
								</span>
							{/if}
						</div>
					</div>
				</div>
				<div class="row">
					{#if renamingId !== k.id}
						<button class="icon-btn" style="width:34px;height:34px" title="重命名" onclick={() => startRename(k.id, k.name)}>
							<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></svg>
						</button>
						<button class="icon-btn" style="width:34px;height:34px;{k.quotaCalls != null || k.quotaTokens != null ? 'color:var(--cta)' : ''}" title="{k.quotaCalls != null || k.quotaTokens != null ? '编辑配额' : '设置配额'}" onclick={() => startQuota(k)}>
							<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"><path d="M12 2 4 5v6c0 5.25 3.4 10.74 8 11 4.6-.26 8-5.75 8-11V5z" /><path d="m9.5 12 1.8 1.8L15 10" /></svg>
						</button>
					{/if}
					<button class="icon-btn" style="width:34px;height:34px;color:var(--danger)" title="删除" onclick={() => handleDelete(k.id, k.name)}>
						<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"><path d="M3 6h18M8 6V4h8v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14" /></svg>
					</button>
				</div>
			</div>
		{/each}
	{/if}

	<!-- New key input -->
	{#if showInput}
		<div style="margin:4px 16px 12px;padding:14px;border-radius:12px;background:var(--surface-3);border:1px dashed var(--b-str)">
			<div class="row" style="flex-wrap:wrap">
				<input class="input" style="flex:1;min-width:160px" bind:value={newKeyName} placeholder="密钥名称（如：我的应用、项目A）" />
				<input class="input" style="flex:1;min-width:160px;font-family:var(--font-mono)" bind:value={newKeyValue} placeholder="自行设置 Key（留空将随机生成）" />
			</div>
			<div class="row" style="flex-wrap:wrap;gap:8px;margin-top:10px">
				<input class="input" style="width:130px;font-size:12.5px" bind:value={newQuotaCalls} placeholder="调用上限（留空不限）" />
				<input class="input" style="width:150px;font-size:12.5px" bind:value={newQuotaTokens} placeholder="Token 上限（留空不限）" />
				<select class="input" style="width:76px;font-size:12.5px" bind:value={newQuotaPeriod}>
					<option value="day">每日</option>
					<option value="month">每月</option>
				</select>
				<span style="font-size:11px;color:var(--muted);align-self:center">配额可稍后在列表里修改</span>
			</div>
			<div class="row" style="margin-top:10px">
				<button class="btn btn-primary btn-sm" onclick={() => newKeyValue.trim() ? handleSet() : handleGenerate()}>创建</button>
				<button class="btn btn-ghost btn-sm" onclick={handleCancelInput}>取消</button>
			</div>
		</div>
	{/if}

	<!-- Revealed key display -->
	{#if revealedKey}
		<div style="margin:4px 16px 12px;padding:14px;border-radius:12px;background:var(--input);border:1px solid rgba(245,158,11,.2)">
			<div class="between" style="align-items:flex-start">
				<div style="flex:1;min-width:0">
					<div style="font-size:12px;color:var(--muted);margin-bottom:6px">密钥 "{revealedName}" 已创建 — 请立即复制保存：</div>
					<code style="font-size:13px;color:var(--warning);font-family:var(--font-mono);word-break:break-all;line-height:1.4">{revealedKey}</code>
				</div>
				<div class="row">
					<button class="icon-btn" style="width:32px;height:32px" title="复制" onclick={handleCopy} disabled={copying}>
						{#if copying}
							<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6 9 17l-5-5" /></svg>
						{:else}
							<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
						{/if}
					</button>
					<button class="icon-btn" style="width:32px;height:32px" title="关闭" onclick={hideRevealed}>
						<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
					</button>
				</div>
			</div>
			<p style="font-size:11px;color:var(--warning);margin-top:10px;display:flex;align-items:center;gap:6px">
				<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.2 2.3 18a2 2 0 0 0 1.7 3h16a2 2 0 0 0 1.7-3L13.7 3.2a2 2 0 0 0-3.4 0z" /></svg>
				此密钥仅显示一次，请立即复制保存
			</p>
		</div>
	{/if}
</div>
