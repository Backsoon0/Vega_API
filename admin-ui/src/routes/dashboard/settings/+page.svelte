<script lang="ts">
	import { changePassword, getSettings, updateSettings } from "$lib/api";
	import { Wrench, Lock, Eye, EyeOff, ToggleLeft, ToggleRight, Columns } from "lucide-svelte";
	import Alert from "$lib/Alert.svelte";
	import Spinner from "$lib/Spinner.svelte";
	import { toasts } from "$lib/toast-store";

	// ---- Password state ----
	let currentPassword = $state('');
	let newPassword = $state('');
	let confirmPassword = $state('');
	let showCurrent = $state(false);
	let showNew = $state(false);
	let showConfirm = $state(false);
	let saving = $state(false);
	let message = $state('');
	let error = $state('');

	// ---- Failover state ----
	let failoverEnabled = $state(false);
	let settingsLoading = $state(true);
	let failoverSaving = $state(false);

	// ---- Column visibility ----
	const ALL_COLUMNS = [
		{ key: 'time', label: '时间' },
		{ key: 'ip', label: 'IP' },
		{ key: 'provider', label: '提供商' },
		{ key: 'model', label: '模型' },
		{ key: 'keyName', label: '密钥名称' },
		{ key: 'stream', label: '流式' },
		{ key: 'tokens', label: 'Token' },
		{ key: 'duration', label: '耗时' },
		{ key: 'status', label: '状态' },
	];
	let visibleColumns = $state<string[]>(ALL_COLUMNS.map(c => c.key));

	function loadColumnPrefs() {
		try {
			const saved = localStorage.getItem('vega_log_columns');
			if (saved) {
				const arr = JSON.parse(saved);
				if (Array.isArray(arr) && arr.length > 0) {
					visibleColumns = arr;
				}
			}
		} catch { /* use defaults */ }
	}
	function saveColumnPrefs() {
		localStorage.setItem('vega_log_columns', JSON.stringify(visibleColumns));
		toasts.show('栏位设置已保存');
	}

	function toggleColumn(key: string) {
		if (visibleColumns.includes(key)) {
			if (visibleColumns.length > 1) {
				visibleColumns = visibleColumns.filter(c => c !== key);
			}
		} else {
			visibleColumns = [...visibleColumns, key];
		}
	}

	// ---- Load settings ----
	$effect(() => {
		getSettings().then(s => {
			failoverEnabled = s.failoverEnabled;
		}).catch(() => {}).finally(() => {
			settingsLoading = false;
		});
		loadColumnPrefs();
	});

	// ---- Failover toggle ----
	async function toggleFailover() {
		failoverSaving = true;
		try {
			await updateSettings({ failoverEnabled: !failoverEnabled });
			failoverEnabled = !failoverEnabled;
			toasts.show(failoverEnabled ? '故障转移已开启' : '故障转移已关闭');
		} catch (err: any) {
			toasts.show(err.message || '保存失败', 'error');
		} finally {
			failoverSaving = false;
		}
	}

	// ---- Password ----
	async function handleChangePassword(e: Event) {
		e.preventDefault();
		error = ''; message = '';
		if (!currentPassword || !newPassword || !confirmPassword) {
			error = '请填写所有字段'; return;
		}
		if (newPassword.length < 6) {
			error = '新密码至少 6 个字符'; return;
		}
		if (newPassword !== confirmPassword) {
			error = '两次输入的新密码不一致'; return;
		}
		saving = true;
		try {
			const res = await changePassword(currentPassword, newPassword);
			if (res.ok) {
				message = '密码修改成功';
				currentPassword = ''; newPassword = ''; confirmPassword = '';
			} else {
				error = res.error || '修改失败';
			}
		} catch (err: any) {
			error = err.message || '修改失败';
		} finally { saving = false; }
	}
</script>

<svelte:head><title>设置 — Vega API</title></svelte:head>

<div class="max-w-6xl mx-auto">
	<div class="mb-8">
		<h1 class="text-lg font-bold text-primary font-mono flex items-center gap-2">
			<Wrench class="w-5 h-5" stroke-width={1.5} />
			设置
		</h1>
		<p class="text-xs text-muted mt-1">管理面板配置、安全设置和显示偏好</p>
	</div>

	<div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
		<!-- Failover toggle -->
		<div class="bg-surface border border-white/[0.08] rounded-2xl p-6 shadow-card">
			<h2 class="text-sm font-semibold text-primary mb-4 flex items-center gap-2">
				<ToggleLeft class="w-4 h-4 text-cta" stroke-width={1.5} />
				故障转移模式
			</h2>
			{#if settingsLoading}
				<div class="flex items-center gap-2 text-sm text-muted py-2">
					<Spinner size="sm" />
					加载中...
				</div>
			{:else}
				<div class="flex items-center justify-between">
					<div>
						<p class="text-sm text-secondary">
							{#if failoverEnabled}
								已开启 — 当前 API 调用失败时自动尝试其他提供商
							{:else}
								已关闭 — 仅使用权重最高的提供商，不自动切换
							{/if}
						</p>
						<p class="text-xs text-muted mt-1">
							开启后，当一个 provider 调用失败时，系统会自动尝试下一个可用 provider 的相同模型
						</p>
					</div>
					<button
						onclick={toggleFailover}
						disabled={failoverSaving}
						class="shrink-0 transition-all {failoverSaving ? 'opacity-50' : 'hover:scale-110'}"
					>
						{#if failoverEnabled}
							<ToggleRight class="w-10 h-6 text-accent" stroke-width={1.5} />
						{:else}
							<ToggleLeft class="w-10 h-6 text-muted" stroke-width={1.5} />
						{/if}
					</button>
				</div>
			{/if}
		</div>

		<!-- Call log columns -->
		<div class="bg-surface border border-white/[0.08] rounded-2xl p-6 shadow-card">
			<h2 class="text-sm font-semibold text-primary mb-4 flex items-center gap-2">
				<Columns class="w-4 h-4 text-cta" stroke-width={1.5} />
				调用记录显示栏位
			</h2>
			<p class="text-xs text-muted mb-4">选择在调用记录页面中显示的列</p>
			<div class="space-y-2">
				{#each ALL_COLUMNS as col}
					<label class="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/[0.03] cursor-pointer transition-colors">
						<input
							type="checkbox"
							checked={visibleColumns.includes(col.key)}
							onchange={() => toggleColumn(col.key)}
							class="rounded bg-input border-white/[0.15] text-cta focus:ring-cta/40 w-4 h-4"
						/>
						<span class="text-sm text-secondary">{col.label}</span>
					</label>
				{/each}
			</div>
			<button
				onclick={saveColumnPrefs}
				class="mt-4 px-4 py-2 text-xs font-semibold rounded-xl bg-cta hover:bg-cta-hover text-white transition-all active:scale-[0.97]"
			>
				保存栏位设置
			</button>
		</div>

		<!-- Password change (full width on 2-col layout) -->
		<div class="lg:col-span-2">
			<div class="bg-surface border border-white/[0.06] rounded-xl p-6">
				<h2 class="text-sm font-semibold text-primary mb-6 flex items-center gap-2">
					<Lock class="w-4 h-4" stroke-width={1.5} />
					修改管理密码
				</h2>

				<form onsubmit={handleChangePassword} class="space-y-4 max-w-md">
					<!-- Current Password -->
					<div>
						<label for="current-password" class="block text-xs text-secondary mb-1.5">当前密码</label>
						<div class="relative">
							<input
								id="current-password"
								type={showCurrent ? 'text' : 'password'}
								class="w-full px-3 py-2.5 bg-input border border-white/[0.08] rounded-lg text-sm text-primary placeholder:text-placeholder focus:outline-none focus:ring-2 focus:ring-cta/50"
								bind:value={currentPassword}
								placeholder="输入当前密码"
							/>
							<button
								type="button"
								class="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-secondary p-1 transition-colors"
								onclick={() => (showCurrent = !showCurrent)}
							>
								{#if showCurrent}
									<EyeOff class="w-3.5 h-3.5" stroke-width={1.5} />
								{:else}
									<Eye class="w-3.5 h-3.5" stroke-width={1.5} />
								{/if}
							</button>
						</div>
					</div>

					<!-- New Password -->
					<div>
						<label for="new-password" class="block text-xs text-secondary mb-1.5">新密码</label>
						<div class="relative">
							<input
								id="new-password"
								type={showNew ? 'text' : 'password'}
								class="w-full px-3 py-2.5 bg-input border border-white/[0.08] rounded-lg text-sm text-primary placeholder:text-placeholder focus:outline-none focus:ring-2 focus:ring-cta/50"
								bind:value={newPassword}
								placeholder="至少 6 个字符"
							/>
							<button
								type="button"
								class="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-secondary p-1 transition-colors"
								onclick={() => (showNew = !showNew)}
							>
								{#if showNew}
									<EyeOff class="w-3.5 h-3.5" stroke-width={1.5} />
								{:else}
									<Eye class="w-3.5 h-3.5" stroke-width={1.5} />
								{/if}
							</button>
						</div>
					</div>

					<!-- Confirm New Password -->
					<div>
						<label for="confirm-password" class="block text-xs text-secondary mb-1.5">确认新密码</label>
						<div class="relative">
							<input
								id="confirm-password"
								type={showConfirm ? 'text' : 'password'}
								class="w-full px-3 py-2.5 bg-input border border-white/[0.08] rounded-lg text-sm text-primary placeholder:text-placeholder focus:outline-none focus:ring-2 focus:ring-cta/50"
								bind:value={confirmPassword}
								placeholder="再次输入新密码"
							/>
							<button
								type="button"
								class="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-secondary p-1 transition-colors"
								onclick={() => (showConfirm = !showConfirm)}
							>
								{#if showConfirm}
									<EyeOff class="w-3.5 h-3.5" stroke-width={1.5} />
								{:else}
									<Eye class="w-3.5 h-3.5" stroke-width={1.5} />
								{/if}
							</button>
						</div>
					</div>

					{#if error}
						<Alert type="error" message={error} />
					{/if}
					{#if message}
						<Alert type="success" message={message} />
					{/if}

					<button
						type="submit"
						disabled={saving}
						class="w-full py-2.5 text-sm font-semibold rounded-xl bg-cta hover:bg-cta-hover text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
					>
						{#if saving}
							<Spinner size="sm" />
							保存中...
						{:else}
							修改密码
						{/if}
					</button>
				</form>
			</div>
		</div>
	</div>
</div>
