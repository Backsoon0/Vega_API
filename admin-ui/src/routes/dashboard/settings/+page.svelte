<script lang="ts">
	import { changePassword, getSettings, updateSettings } from "$lib/api";
	import { ToggleLeft, Columns, Shield, Database, Lock, Eye, EyeOff } from "lucide-svelte";
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

<div class="page-head">
	<div>
		<h1>设置</h1>
		<p class="lead">路由策略、熔断与显示偏好</p>
	</div>
</div>

<div class="grid-2 settings-grid">
	<!-- Failover toggle -->
	<div class="card card-pad rise" style="--d:40ms">
		<div class="between" style="align-items:flex-start;gap:12px">
			<div>
				<h2 style="font-size:14px;display:flex;gap:8px;align-items:center">
					<ToggleLeft class="w-4 h-4" style="color:var(--cta)" stroke-width={1.5} />
					故障转移模式
				</h2>
				<p style="font-size:12px;color:var(--muted);margin-top:6px">主 Provider 调用失败时自动切换到下一个可用 Provider</p>
			</div>
			{#if settingsLoading}
				<div style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted);flex-shrink:0;margin-left:12px"><Spinner size="sm" /></div>
			{:else}
				<button
					class="switch {failoverEnabled ? 'on' : ''}"
					style="width:46px"
					onclick={toggleFailover}
					disabled={failoverSaving}
					role="switch"
					aria-checked={failoverEnabled}
					aria-label="故障转移模式"
				></button>
			{/if}
		</div>
		<p class="mono" style="font-size:11.5px;color:{failoverEnabled ? 'var(--success)' : 'var(--muted)'};margin-top:14px">
			● {failoverEnabled ? '已开启 — 失败时自动切换' : '已关闭 — 仅使用权重最高的提供商'}
		</p>
	</div>

	<!-- Circuit breaker -->
	<div class="card card-pad rise" style="--d:90ms">
		<h2 style="font-size:14px;display:flex;gap:8px;align-items:center;margin-bottom:12px">
			<Shield class="w-4 h-4" style="color:var(--warning)" stroke-width={1.5} />
			熔断器
		</h2>
		<p style="font-size:12px;color:var(--muted);margin-bottom:14px">连续失败达阈值后自动跳过，冷却后恢复</p>
		<div class="row" style="align-items:flex-end">
			<div class="field" style="margin:0">
				<label for="cb-threshold">失败阈值</label>
				<input id="cb-threshold" class="input" type="number" style="width:84px;text-align:center" bind:value={cbThreshold} min="1" max="50" />
			</div>
			<div class="field" style="margin:0">
				<label for="cb-cooldown">冷却（秒）</label>
				<input id="cb-cooldown" class="input" type="number" style="width:84px;text-align:center" bind:value={cbCooldown} min="5" max="600" />
			</div>
			<button class="btn btn-primary btn-sm" style="margin-bottom:1px" onclick={saveCircuitBreaker} disabled={cbSaving}>
				{cbSaving ? '保存中...' : '保存'}
			</button>
		</div>
	</div>

	<!-- Call log retention -->
	<div class="card card-pad rise" style="--d:140ms">
		<h2 style="font-size:14px;display:flex;gap:8px;align-items:center;margin-bottom:12px">
			<Database class="w-4 h-4" style="color:var(--cta)" stroke-width={1.5} />
			调用记录保留上限
		</h2>
		<p style="font-size:12px;color:var(--muted);margin-bottom:14px">超出后自动清理最旧记录</p>
		<div class="row">
			<input class="input" type="number" style="width:120px" bind:value={logRetention} min="100" max="1000000" step="100" />
			<span style="font-size:12px;color:var(--muted)">条</span>
			<button class="btn btn-primary btn-sm" onclick={saveRetentionLimit} disabled={retentionSaving}>
				{retentionSaving ? '保存中...' : '保存'}
			</button>
		</div>
	</div>

	<!-- Display columns -->
	<div class="card card-pad rise" style="--d:190ms">
		<h2 style="font-size:14px;display:flex;gap:8px;align-items:center;margin-bottom:12px">
			<Columns class="w-4 h-4" style="color:var(--cta)" stroke-width={1.5} />
			显示栏位
		</h2>
		<p style="font-size:12px;color:var(--muted);margin-bottom:12px">选择调用记录页显示的列</p>
		<div class="row" style="flex-wrap:wrap;gap:8px" id="colChips">
			{#each ALL_COLUMNS as col}
				<button
					class="chip {visibleColumns.includes(col.key) ? 'chip-accent' : 'chip-muted'}"
					data-col={col.key}
					onclick={() => toggleColumn(col.key)}
				>
					{col.label}
				</button>
			{/each}
		</div>
		<button class="btn btn-primary btn-sm mt" onclick={saveColumnPrefs}>保存栏位设置</button>
	</div>
</div>

<!-- Password change -->
<div class="card card-pad rise" style="--d:240ms;max-width:520px;margin-top:24px">
	<h2 style="font-size:14px;display:flex;gap:8px;align-items:center;margin-bottom:14px">
		<Lock class="w-4 h-4" stroke-width={1.5} />
		修改管理密码
	</h2>
	<form onsubmit={handleChangePassword} class="space-y-4">
		<div class="field">
			<label for="pw-current">当前密码</label>
			<div style="position:relative">
				<input id="pw-current" class="input" type={showCurrent ? 'text' : 'password'} style="padding-right:42px" bind:value={currentPassword} placeholder="输入当前密码" />
				<button type="button" class="icon-btn" style="position:absolute;right:4px;top:50%;transform:translateY(-50%);width:32px;height:32px" onclick={() => (showCurrent = !showCurrent)} aria-label="显示/隐藏密码">
					{#if showCurrent}<EyeOff style="width:15px;height:15px" stroke-width={1.8} />{:else}<Eye style="width:15px;height:15px" stroke-width={1.8} />{/if}
				</button>
			</div>
		</div>
		<div class="field">
			<label for="pw-new">新密码</label>
			<div style="position:relative">
				<input id="pw-new" class="input" type={showNew ? 'text' : 'password'} style="padding-right:42px" bind:value={newPassword} placeholder="至少 6 个字符" />
				<button type="button" class="icon-btn" style="position:absolute;right:4px;top:50%;transform:translateY(-50%);width:32px;height:32px" onclick={() => (showNew = !showNew)} aria-label="显示/隐藏密码">
					{#if showNew}<EyeOff style="width:15px;height:15px" stroke-width={1.8} />{:else}<Eye style="width:15px;height:15px" stroke-width={1.8} />{/if}
				</button>
			</div>
		</div>
		<div class="field">
			<label for="pw-confirm">确认新密码</label>
			<div style="position:relative">
				<input id="pw-confirm" class="input" type={showConfirm ? 'text' : 'password'} style="padding-right:42px" bind:value={confirmPassword} placeholder="再次输入新密码" />
				<button type="button" class="icon-btn" style="position:absolute;right:4px;top:50%;transform:translateY(-50%);width:32px;height:32px" onclick={() => (showConfirm = !showConfirm)} aria-label="显示/隐藏密码">
					{#if showConfirm}<EyeOff style="width:15px;height:15px" stroke-width={1.8} />{:else}<Eye style="width:15px;height:15px" stroke-width={1.8} />{/if}
				</button>
			</div>
		</div>

		{#if error}<Alert type="error" message={error} />{/if}
		{#if message}<Alert type="success" message={message} />{/if}

		<button type="submit" disabled={saving} class="btn btn-primary" style="width:100%;justify-content:center;margin-top:6px">
			{#if saving}<span class="spark"></span> 保存中...{:else}修改密码{/if}
		</button>
	</form>
</div>
