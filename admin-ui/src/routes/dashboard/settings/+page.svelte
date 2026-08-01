<script lang="ts">
	import { changePassword, getSettings, updateSettings } from "$lib/api";
	import { Wrench, Lock, Eye, EyeOff, ToggleLeft, ToggleRight, Columns, Shield, Database } from "lucide-svelte";
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

	// ---- Circuit breaker state ----
	let cbThreshold = $state(5);
	let cbCooldown = $state(30);
	let cbSaving = $state(false);

	// ---- Call log retention state ----
	let logRetention = $state(10000);
	let retentionSaving = $state(false);

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
			cbThreshold = s.circuitBreakerThreshold || 5;
			cbCooldown = s.circuitBreakerCooldownSeconds || 30;
			logRetention = s.logRetentionLimit || 10000;
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

	// ---- Circuit breaker save ----
	async function saveCircuitBreaker() {
		if (cbThreshold < 1) cbThreshold = 1;
		if (cbCooldown < 5) cbCooldown = 5;
		cbSaving = true;
		try {
			await updateSettings({ circuitBreakerThreshold: cbThreshold, circuitBreakerCooldownSeconds: cbCooldown });
			toasts.show('熔断器设置已保存');
		} catch (err: any) {
			toasts.show(err.message || '保存失败', 'error');
		} finally {
			cbSaving = false;
		}
	}

	// ---- Call log retention save ----
	async function saveRetentionLimit() {
		if (logRetention < 100) logRetention = 100;
		if (logRetention > 1000000) logRetention = 1000000;
		retentionSaving = true;
		try {
			await updateSettings({ logRetentionLimit: Math.floor(logRetention) });
			toasts.show('调用记录保留上限已保存');
		} catch (err: any) {
			toasts.show(err.message || '保存失败', 'error');
		} finally {
			retentionSaving = false;
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

	<div class="flex flex-col gap-6 max-w-3xl">
		<!-- Failover toggle -->
		<div class="card-gradient-cta rounded-2xl p-5 shadow-card">
			<div class="flex items-center justify-between">
				<div>
					<h2 class="text-sm font-semibold text-primary flex items-center gap-2">
						<ToggleLeft class="w-4 h-4 text-cta" stroke-width={1.5} />
						故障转移模式
					</h2>
					<p class="text-xs text-muted mt-1">
						开启后，当一个 provider 调用失败时，系统会自动尝试下一个可用 provider 的相同模型
					</p>
				</div>
				{#if settingsLoading}
					<div class="flex items-center gap-2 text-sm text-muted shrink-0 ml-4">
						<Spinner size="sm" />
					</div>
				{:else}
					<button
						onclick={toggleFailover}
						disabled={failoverSaving}
						class="shrink-0 ml-4 transition-all {failoverSaving ? 'opacity-50' : 'hover:scale-110'}"
					>
						{#if failoverEnabled}
							<ToggleRight class="w-10 h-6 text-accent" stroke-width={1.5} />
						{:else}
							<ToggleLeft class="w-10 h-6 text-muted" stroke-width={1.5} />
						{/if}
					</button>
				{/if}
			</div>
			{#if !settingsLoading}
				<p class="text-xs {failoverEnabled ? 'text-accent' : 'text-muted'} mt-3">
					{failoverEnabled ? '● 已开启 — 调用失败时自动切换提供商' : '○ 已关闭 — 仅使用权重最高的提供商'}
				</p>
			{/if}
		</div>

		<!-- Circuit breaker config -->
		<div class="bg-surface rounded-xl p-5 shadow-card">
			<h2 class="text-sm font-semibold text-primary mb-3 flex items-center gap-2">
				<Shield class="w-4 h-4 text-warning" stroke-width={1.5} />
				熔断器
			</h2>
			<p class="text-xs text-muted mb-4">同一 provider 连续失败达阈值后自动跳过，冷却后恢复。即时生效，无需重启。</p>
			<div class="flex flex-wrap items-end gap-4">
				<div>
					<label for="cb-threshold" class="block text-xs text-muted mb-1">失败阈值</label>
					<div class="flex items-center gap-2">
						<input
							id="cb-threshold"
							type="number"
							min="1" max="50"
							class="w-16 px-3 py-2 bg-input rounded-lg text-sm text-primary text-center focus:outline-none"
							bind:value={cbThreshold}
						/>
						<span class="text-xs text-muted">次</span>
					</div>
				</div>
				<div>
					<label for="cb-cooldown" class="block text-xs text-muted mb-1">冷却时间</label>
					<div class="flex items-center gap-2">
						<input
							id="cb-cooldown"
							type="number"
							min="5" max="600"
							class="w-16 px-3 py-2 bg-input rounded-lg text-sm text-primary text-center focus:outline-none"
							bind:value={cbCooldown}
						/>
						<span class="text-xs text-muted">秒</span>
					</div>
				</div>
				<button
					onclick={saveCircuitBreaker}
					disabled={cbSaving}
					class="px-4 py-2 text-xs font-semibold rounded-xl bg-cta hover:bg-cta-hover text-white transition-all active:scale-[0.97] shadow-glow-cta-subtle disabled:opacity-50"
				>
					{cbSaving ? '保存中...' : '保存'}
				</button>
			</div>
		</div>

		<!-- Call log retention -->
		<div class="bg-surface rounded-xl p-5 shadow-card">
			<h2 class="text-sm font-semibold text-primary mb-3 flex items-center gap-2">
				<Database class="w-4 h-4 text-cta" stroke-width={1.5} />
				调用记录保留上限
			</h2>
			<p class="text-xs text-muted mb-4">系统最多保留的调用记录条数，超出后自动清理最旧的记录。修改后立即生效，无需重启。</p>
			<div class="flex flex-wrap items-end gap-4">
				<div>
					<label for="log-retention" class="block text-xs text-muted mb-1">最大保留条数</label>
					<div class="flex items-center gap-2">
						<input
							id="log-retention"
							type="number"
							min="100" max="1000000" step="100"
							class="w-28 px-3 py-2 bg-input rounded-lg text-sm text-primary text-center focus:outline-none"
							bind:value={logRetention}
						/>
						<span class="text-xs text-muted">条</span>
					</div>
				</div>
				<button
					onclick={saveRetentionLimit}
					disabled={retentionSaving}
					class="px-4 py-2 text-xs font-semibold rounded-xl bg-cta hover:bg-cta-hover text-white transition-all active:scale-[0.97] shadow-glow-cta-subtle disabled:opacity-50"
				>
					{retentionSaving ? '保存中...' : '保存'}
				</button>
			</div>
		</div>

		<!-- Call log columns -->
		<div class="card-gradient-accent rounded-2xl p-5 shadow-card">
			<h2 class="text-sm font-semibold text-primary mb-2 flex items-center gap-2">
				<Columns class="w-4 h-4 text-accent" stroke-width={1.5} />
				调用记录显示栏位
			</h2>
			<p class="text-xs text-muted mb-3">选择在调用记录页面中显示的列</p>
			<div class="flex flex-wrap gap-1 mb-4">
				{#each ALL_COLUMNS as col}
					<label class="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-white/[0.06] cursor-pointer transition-colors {visibleColumns.includes(col.key) ? 'bg-white/[0.06]' : ''}">
						<input
							type="checkbox"
							checked={visibleColumns.includes(col.key)}
							onchange={() => toggleColumn(col.key)}
							class="rounded bg-input border-default text-cta focus:ring-cta/40 w-3.5 h-3.5"
						/>
						<span class="text-xs text-secondary">{col.label}</span>
					</label>
				{/each}
			</div>
			<button
				onclick={saveColumnPrefs}
				class="px-4 py-2 text-xs font-semibold rounded-xl bg-cta hover:bg-cta-hover text-white transition-all active:scale-[0.97] shadow-glow-cta-subtle"
			>
				保存栏位设置
			</button>
		</div>

		<!-- Password change -->
		<div class="bg-surface rounded-xl p-5 shadow-card">
			<h2 class="text-sm font-semibold text-primary mb-4 flex items-center gap-2">
				<Lock class="w-4 h-4" stroke-width={1.5} />
				修改管理密码
			</h2>

			<form onsubmit={handleChangePassword} class="space-y-4 max-w-md">
				<div>
					<label for="current-password" class="block text-xs text-secondary mb-1.5">当前密码</label>
					<div class="relative">
						<input
							id="current-password"
							type={showCurrent ? 'text' : 'password'}
							class="w-full px-3 py-2.5 bg-input rounded-lg text-sm text-primary placeholder:text-placeholder focus:outline-none"
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

				<div>
					<label for="new-password" class="block text-xs text-secondary mb-1.5">新密码</label>
					<div class="relative">
						<input
							id="new-password"
							type={showNew ? 'text' : 'password'}
							class="w-full px-3 py-2.5 bg-input rounded-lg text-sm text-primary placeholder:text-placeholder focus:outline-none"
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

				<div>
					<label for="confirm-password" class="block text-xs text-secondary mb-1.5">确认新密码</label>
					<div class="relative">
						<input
							id="confirm-password"
							type={showConfirm ? 'text' : 'password'}
							class="w-full px-3 py-2.5 bg-input rounded-lg text-sm text-primary placeholder:text-placeholder focus:outline-none"
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
					class="w-full py-2.5 text-sm font-semibold rounded-xl bg-cta hover:bg-cta-hover text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-glow-cta-subtle"
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
