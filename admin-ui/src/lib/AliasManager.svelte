<script lang="ts">
  import { getAliases, createAlias, updateAlias, deleteAlias, toggleAliasEnabled, getProviders } from "$lib/api";
  import type { ModelAlias } from "$lib/api";
  import { toasts } from "$lib/toast-store";
  import Alert from "$lib/Alert.svelte";
  import { Link2, Plus, Trash2 } from "lucide-svelte";

  let aliases = $state<ModelAlias[]>([]);
  let loading = $state(true);
  let models = $state<string[]>([]);

  // New-rule form
  let aliasInput = $state("");
  let targetInput = $state("");
  let descriptionInput = $state("");
  let error = $state("");
  let saving = $state(false);

  // Editing state
  let editingId = $state<number | null>(null);
  let editAlias = $state("");
  let editTarget = $state("");
  let editDesc = $state("");
  let editEnabled = $state(true);

  $effect(() => { load(); });

  async function load() {
    loading = true;
    try {
      aliases = await getAliases();
    } catch (err: any) {
      toasts.show(err.message, 'error');
    } finally {
      loading = false;
    }
  }

  // Build a candidate model list (from all providers' configured models) for the target dropdown.
  $effect(() => {
    getProviders().then((ps) => {
      const set = new Set<string>();
      for (const p of ps) for (const m of p.models || []) set.add(m);
      models = Array.from(set).sort();
    }).catch(() => {});
  });

  async function handleAdd() {
    error = "";
    if (!aliasInput.trim() || !targetInput.trim()) {
      error = "别名与目标模型都不能为空";
      return;
    }
    saving = true;
    try {
      await createAlias({ alias: aliasInput.trim(), target: targetInput.trim(), description: descriptionInput.trim() || undefined });
      aliasInput = ""; targetInput = ""; descriptionInput = "";
      await load();
      toasts.show('别名已创建');
    } catch (err: any) {
      error = err.message || '创建失败';
      toasts.show(error, 'error');
    } finally {
      saving = false;
    }
  }

  function startEdit(a: ModelAlias) {
    editingId = a.id; editAlias = a.alias; editTarget = a.target; editDesc = a.description || ""; editEnabled = a.enabled;
  }

  async function saveEdit() {
    if (editingId == null) return;
    saving = true;
    try {
      // Preserve the rule's enabled state — editing must not silently re-enable a disabled rule.
      await updateAlias(editingId, { alias: editAlias.trim(), target: editTarget.trim(), description: editDesc.trim() || undefined, enabled: editEnabled });
      editingId = null;
      await load();
      toasts.show('别名已更新');
    } catch (err: any) {
      toasts.show(err.message, 'error');
    } finally {
      saving = false;
    }
  }

  async function remove(id: number) {
    if (!confirm('确定删除该别名规则？')) return;
    try {
      await deleteAlias(id);
      await load();
      toasts.show('已删除');
    } catch (err: any) {
      toasts.show(err.message, 'error');
    }
  }

  async function toggle(a: ModelAlias) {
    try {
      await toggleAliasEnabled(a.id, !a.enabled);
      await load();
    } catch (err: any) {
      toasts.show(err.message, 'error');
    }
  }
</script>

<div class="card card-pad rise" style="--d:200ms;margin-top:24px">
  <h2 style="font-size:14px;display:flex;gap:8px;align-items:center;margin-bottom:6px">
    <Link2 class="w-4 h-4" stroke-width={1.5} />
    模型别名与重定向
  </h2>
  <p style="font-size:12px;color:var(--muted);margin-bottom:14px;line-height:1.6">
    为模型配置自定义别名，或将某模型名/别名重定向到另一模型。调用别名时会自动转发到目标模型（别名优先级高于真实模型名）。
  </p>

  <!-- Add form -->
  <div style="display:flex;flex-direction:column;gap:10px;padding:14px;border-radius:12px;background:var(--input);border:1px solid var(--b-def);margin-bottom:14px">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="field" style="margin-bottom:0">
        <label for="al-alias">别名（调用时使用）<span style="color:var(--danger)">*</span></label>
        <input id="al-alias" class="input mono" bind:value={aliasInput} placeholder="如: fast" />
      </div>
      <div class="field" style="margin-bottom:0">
        <label for="al-target">重定向到目标模型 <span style="color:var(--danger)">*</span></label>
        <input id="al-target" class="input mono" list="alias-target-list" bind:value={targetInput} placeholder="如: gemini-2.5-flash" />
        <datalist id="alias-target-list">
          {#each models as m}<option value={m} />{/each}
        </datalist>
      </div>
    </div>
    <div class="field" style="margin-bottom:0">
      <label for="al-desc">描述（可选）</label>
      <input id="al-desc" class="input" bind:value={descriptionInput} placeholder="说明这条别名的用途" />
    </div>
    {#if error}
      <Alert type="error" message={error} />
    {/if}
    <button class="btn btn-primary btn-sm" style="justify-content:center;width:120px" disabled={saving} onclick={handleAdd}>
      <Plus style="width:14px;height:14px" /> 添加
    </button>
  </div>

  <!-- List -->
  {#if loading}
    <div style="padding:16px;text-align:center;color:var(--muted);font-size:12px">加载别名...</div>
  {:else if aliases.length === 0}
    <div style="padding:16px;text-align:center;color:var(--muted);font-size:12px">暂无别名规则</div>
  {:else}
    <div style="display:flex;flex-direction:column;gap:8px">
      {#each aliases as a (a.id)}
        {#if editingId === a.id}
          <div style="display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:12px;border:1px solid var(--accent);background:var(--cta-soft)">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div class="field" style="margin-bottom:0">
                <label>别名</label>
                <input class="input mono" bind:value={editAlias} />
              </div>
              <div class="field" style="margin-bottom:0">
                <label>目标模型</label>
                <input class="input mono" list="alias-target-list" bind:value={editTarget} />
              </div>
            </div>
            <div class="field" style="margin-bottom:0">
              <label>描述</label>
              <input class="input" bind:value={editDesc} />
            </div>
            <div style="display:flex;gap:8px">
              <button class="btn btn-primary btn-sm" style="justify-content:center" disabled={saving} onclick={saveEdit}>保存</button>
              <button class="btn btn-soft btn-sm" style="justify-content:center" onclick={() => (editingId = null)}>取消</button>
            </div>
          </div>
        {:else}
          <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;border:1px solid var(--b-def);background:var(--surface);{a.enabled ? '' : 'opacity:.55'}">
            <span class="mono" style="font-weight:600;color:var(--accent);font-size:12px">{a.alias}</span>
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" style="color:var(--muted);flex-shrink:0"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            <span class="mono" style="color:var(--fg);font-size:12px;flex:1">{a.target}</span>
            <span style="font-size:10px;color:var(--muted)">{a.description}</span>
            <button class="icon-btn" style="width:30px;height:30px" onclick={() => toggle(a)} title={a.enabled ? '禁用' : '启用'} aria-label="切换状态">
              <span style="width:30px;height:16px;border-radius:999px;background:{a.enabled ? 'var(--success)' : 'var(--muted)'};position:relative;display:inline-block">
                <span style="position:absolute;top:2px;left:{a.enabled ? '16px' : '2px'};width:12px;height:12px;border-radius:50%;background:#fff;transition:left .15s"></span>
              </span>
            </button>
            <button class="icon-btn" style="width:30px;height:30px" onclick={() => startEdit(a)} title="编辑" aria-label="编辑别名">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></svg>
            </button>
            <button class="icon-btn" style="width:30px;height:30px;color:var(--danger)" onclick={() => remove(a.id)} title="删除" aria-label="删除别名">
              <Trash2 style="width:13px;height:13px" />
            </button>
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>
