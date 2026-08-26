<script lang="ts">
	import { getApiKeys, createApiKey, deleteApiKey, renameApiKey, deleteLegacyKey, migrateLegacyKey, type ApiKeyInfo } from "$lib/api";
	import { toasts } from "$lib/toast-store";
	import Spinner from "$lib/Spinner.svelte";

	let keys = $state<ApiKeyInfo[]>([]);
	let hasLegacyKey = $state(false);
	let loading = $state(true);
	let showInput = $state(false);
	let newKeyName = $state('');
	let newKeyValue = $state('');
	let revealedKey = $state('');
	let revealedName = $state('');
	let copying = $state(false);
	let renamingId = $state(0);
	let renameName = $state('');
	let showMigrate = $state(false);
	let migrateName = $state('');

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

	async function handleGenerate() {
		const name = newKeyName.trim();
		if (!name) {
			toasts.show('请输入密钥名称', 'error');
			return;
		}
		try {
			const result = await createApiKey(name, undefined, true);
			revealedKey = result.fullKey;
			revealedName = name;
			showInput = false;
			newKeyName = '';
			toasts.show(`密钥 "${name}" 已生成`);
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
			const result = await createApiKey(name, k);
			revealedKey = result.fullKey;
			revealedName = name;
			showInput = false;
			newKeyName = '';
			newKeyValue = '';
			toasts.show(`密钥 "${name}" 已设置`);
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
					</div>
				</div>
				<div class="row">
					{#if renamingId !== k.id}
						<button class="icon-btn" style="width:34px;height:34px" title="重命名" onclick={() => startRename(k.id, k.name)}>
							<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></svg>
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
