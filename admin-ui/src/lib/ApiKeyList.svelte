<script lang="ts">
	import {
		Eye, Copy, Trash2, RefreshCw, Edit3, Plus, Pencil, ArrowRight,
		Shield, Key, X, Check, AlertTriangle, ShieldOff
	} from "lucide-svelte";
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
</script>

<div class="bg-surface border border-white/[0.08] rounded-2xl p-5 sm:p-6 space-y-5 shadow-card">
	<!-- Header -->
	<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
		<div class="flex items-center gap-2.5">
			<div class="flex items-center justify-center w-8 h-8 rounded-lg {keys.length > 0 || hasLegacyKey ? 'bg-accent-subtle' : 'bg-warning-subtle'}">
				{#if keys.length > 0 || hasLegacyKey}
					<Shield class="w-4 h-4 text-accent" />
				{:else}
					<ShieldOff class="w-4 h-4 text-warning" />
				{/if}
			</div>
			<div>
				<h2 class="text-sm font-semibold text-primary">客户端 API Key</h2>
				<p class="text-xs text-muted">管理多个 API 密钥，每个密钥可单独命名和追踪</p>
			</div>
		</div>

		<button
			class="px-3 py-2 text-xs font-medium rounded-lg
						 bg-cta hover:bg-cta-hover text-white
						 transition-all duration-200
						 inline-flex items-center gap-1.5"
			onclick={() => { showInput = !showInput; hideRevealed(); }}
		>
			<Plus class="w-3 h-3" />
			新建密钥
		</button>
	</div>

	<!-- Loading -->
	{#if loading}
		<div class="flex items-center gap-2 text-sm text-muted py-2">
			<Spinner size="sm" />
			加载中...
		</div>

	<!-- Key list -->
	{:else}
		{#if keys.length === 0 && !hasLegacyKey}
			<div class="flex items-center gap-2.5 text-sm text-warning bg-warning-subtle rounded-xl px-4 py-3 border border-warning/20">
				<ShieldOff class="w-4 h-4 shrink-0" />
				<span>未设置密钥 — /v1/* 接口可公开访问</span>
			</div>
		{/if}

		{#if hasLegacyKey}
			<div class="space-y-2">
				<div class="flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-warning-subtle border border-warning/20">
					<div class="flex items-center gap-2 text-sm text-warning">
						<AlertTriangle class="w-4 h-4 shrink-0" />
						<span>旧版兼容密钥 (未命名)</span>
					</div>
					<div class="flex items-center gap-2 shrink-0">
						<button
							class="text-xs text-cta hover:text-cta/80 transition-colors inline-flex items-center gap-1"
							onclick={() => { showMigrate = !showMigrate; migrateName = ''; }}
						>
							<Edit3 class="w-3 h-3" />
							{showMigrate ? '取消' : '设置名称'}
						</button>
						<button
							class="text-xs text-danger hover:text-danger-hover transition-colors inline-flex items-center gap-1"
							onclick={handleDeleteLegacy}
						>
							<Trash2 class="w-3 h-3" />
							删除
						</button>
					</div>
				</div>

				{#if showMigrate}
					<div class="flex items-center gap-2 px-4 py-3 rounded-xl bg-white/[0.02] border border-white/[0.08]">
						<ArrowRight class="w-3.5 h-3.5 text-muted shrink-0" />
						<input
							type="text"
							bind:value={migrateName}
							placeholder="输入密钥名称"
							class="flex-1 px-3 py-2 rounded-lg bg-input border border-white/[0.10] text-primary text-sm
										 placeholder:text-placeholder focus:outline-none focus:ring-2 focus:ring-cta/40"
						/>
						<button
							class="px-3 py-2 text-xs font-semibold rounded-lg bg-accent hover:bg-accent-hover text-white transition-all"
							onclick={handleMigrate}
						>保存</button>
					</div>
				{/if}
			</div>
		{/if}

		{#each keys as k (k.id)}
			<div class="space-y-2">
				<div class="flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-white/[0.03] border border-white/[0.06]">
					<div class="flex items-center gap-3 min-w-0">
						<Key class="w-4 h-4 text-cta shrink-0" stroke-width={1.5} />
						<div class="min-w-0">
							{#if renamingId === k.id}
								<div class="flex items-center gap-2">
									<input
										type="text"
										bind:value={renameName}
										class="px-2 py-1 rounded-lg bg-input border border-white/[0.10] text-primary text-sm w-full max-w-[200px]
													 placeholder:text-placeholder focus:outline-none focus:ring-2 focus:ring-cta/40"
									/>
									<button
										class="text-xs text-accent hover:text-accent-hover p-1" onclick={handleRename}
									>保存</button>
									<button
										class="text-xs text-muted hover:text-secondary p-1" onclick={cancelRename}
									>取消</button>
								</div>
							{:else}
								<div class="text-sm text-secondary font-medium truncate">{k.name}</div>
							{/if}
							<div class="text-[10px] text-muted font-mono">
								创建于 {new Date(k.createdAt).toLocaleDateString('zh-CN')}
								{#if k.lastUsedAt}
									<span class="ml-2">最后使用: {new Date(k.lastUsedAt).toLocaleString('zh-CN')}</span>
								{/if}
							</div>
						</div>
					</div>
					<div class="flex items-center gap-2 shrink-0">
						{#if renamingId !== k.id}
							<button
								class="text-xs text-muted hover:text-secondary transition-colors inline-flex items-center gap-1"
								onclick={() => startRename(k.id, k.name)}
							>
								<Pencil class="w-3 h-3" />
							</button>
						{/if}
						<button
							class="text-xs text-danger hover:text-danger-hover transition-colors inline-flex items-center gap-1"
							onclick={() => handleDelete(k.id, k.name)}
						>
							<Trash2 class="w-3 h-3" />
							删除
						</button>
					</div>
				</div>
			</div>
		{/each}
	{/if}

	<!-- New key input -->
	{#if showInput}
		<div class="space-y-3 p-4 rounded-xl bg-white/[0.02] border border-white/[0.08]">
			<div class="flex flex-col sm:flex-row gap-2.5">
				<input
					type="text"
					bind:value={newKeyName}
					placeholder="密钥名称（如：我的应用、项目A）"
					class="flex-1 px-3.5 py-2.5 rounded-xl bg-input border border-white/[0.10] text-primary text-sm
								 placeholder:text-placeholder
								 focus:outline-none focus:ring-2 focus:ring-cta/40 focus:border-white/[0.20]
								 transition-all duration-200"
				/>
				<input
					type="text"
					bind:value={newKeyValue}
					placeholder="自行设置 Key（留空将随机生成）"
					class="flex-1 px-3.5 py-2.5 rounded-xl bg-input border border-white/[0.10] text-primary text-sm font-mono
								 placeholder:text-placeholder
								 focus:outline-none focus:ring-2 focus:ring-cta/40 focus:border-white/[0.20]
								 transition-all duration-200"
				/>
			</div>
			<div class="flex gap-2">
				<button
					class="px-4 py-2.5 text-xs font-semibold rounded-xl bg-accent hover:bg-accent-hover text-white
								 transition-all duration-200 active:scale-[0.97]"
					onclick={() => newKeyValue.trim() ? handleSet() : handleGenerate()}
				>创建</button>
				<button
					class="px-4 py-2.5 text-xs font-semibold rounded-xl bg-surface-elevated hover:bg-surface-hover text-secondary
								 transition-all duration-200"
					onclick={handleCancelInput}
				>取消</button>
			</div>
		</div>
	{/if}

	<!-- Revealed key display -->
	{#if revealedKey}
		<div class="p-4 rounded-xl bg-input border border-warning/20 space-y-3">
			<div class="flex items-start justify-between gap-3">
				<div class="flex-1 min-w-0">
					<div class="text-xs text-muted mb-1">密钥 "{revealedName}" 已创建 — 请立即复制保存：</div>
					<code class="text-sm text-warning font-mono break-all leading-relaxed">{revealedKey}</code>
				</div>
				<button
					class="shrink-0 p-1.5 rounded-lg hover:bg-surface-elevated text-muted hover:text-secondary
								 transition-all duration-150"
					onclick={hideRevealed}
					title="关闭"
				>
					<X class="w-4 h-4" />
				</button>
			</div>
			<div class="flex items-center justify-between gap-3 flex-wrap">
				<p class="text-xs text-warning flex items-center gap-1.5">
					<AlertTriangle class="w-3.5 h-3.5" />
					此密钥仅显示一次，请立即复制保存
				</p>
				<button
					class="shrink-0 px-3 py-1.5 text-xs font-semibold rounded-lg
								 bg-warning hover:bg-warning/80 text-background
								 transition-all duration-200
								 inline-flex items-center gap-1.5"
					onclick={handleCopy}
					disabled={copying}
				>
					{#if copying}
						<Check class="w-3 h-3" />
						已复制
					{:else}
						<Copy class="w-3 h-3" />
						复制密钥
					{/if}
				</button>
			</div>
		</div>
	{/if}
</div>
