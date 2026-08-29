<script lang="ts">
  import type { Provider } from "$lib/api";
  import { updateProvider, getProviderModels } from "$lib/api";
  import { toasts } from "$lib/toast-store";
  import Modal from "$lib/Modal.svelte";

  interface Props {
    provider: Provider;
    onedit: (id: string) => void;
    ontoggle: (id: string) => void;
    ondelete: (id: string) => void;
  }

  let { provider, onedit, ontoggle, ondelete }: Props = $props();

  const typeLabels: Record<string, string> = {
    vertex_ai: "Vertex AI",
    google_ai_studio: "AI Studio",
    openai: "OpenAI",
    anthropic: "Anthropic",
  };

  const typeTag: Record<string, string> = {
    vertex_ai: "tag-vertex",
    google_ai_studio: "tag-studio",
    openai: "tag-openai",
    anthropic: "tag-anthropic",
  };

  // ---- Model hidden toggle (feature 3) ----
  let hiddenOpen = $state(false);
  let models = $state<string[]>([]);
  let hidden = $state<Set<string>>(new Set());
  let loadingModels = $state(false);
  let savingHidden = $state(false);

  // The provider object can be replaced by parent after reload; re-derive hidden set.
  let lastProviderId = $state("");
  $effect(() => {
    if (provider.id !== lastProviderId) {
      lastProviderId = provider.id;
      hidden = new Set(provider.hiddenModels || []);
    }
  });

  async function openHidden() {
    hiddenOpen = true;
    loadingModels = true;
    hidden = new Set(provider.hiddenModels || []);
    try {
      models = await getProviderModels(provider.id);
      if (models.length === 0) models = [...(provider.models || [])];
    } catch (err: any) {
      models = [...(provider.models || [])];
      if (models.length === 0) toasts.show(err.message || '无法加载模型列表', 'error');
    } finally {
      loadingModels = false;
    }
  }

  function toggleModel(m: string) {
    if (hidden.has(m)) hidden.delete(m);
    else hidden.add(m);
    hidden = new Set(hidden);
  }

  async function saveHidden() {
    savingHidden = true;
    try {
      await updateProvider(provider.id, {
        id: provider.id, type: provider.type, name: provider.name,
        enabled: provider.enabled, config: provider.config, models: provider.models,
        weight: provider.weight, hiddenModels: Array.from(hidden),
      });
      provider.hiddenModels = Array.from(hidden);
      toasts.show('隐藏设置已保存');
      hiddenOpen = false;
    } catch (err: any) {
      toasts.show(err.message, 'error');
    } finally {
      savingHidden = false;
    }
  }
</script>

<div
  class="card card-pad"
  style="display:flex;align-items:center;gap:14px;padding:14px 18px;{provider.enabled ? '' : 'opacity:.62'}"
  role="article"
  aria-label={`${provider.name} — ${provider.enabled ? "已启用" : "已禁用"}`}
>
  <!-- Type tag -->
  <span class="tag {typeTag[provider.type] || 'tag-muted'}" style="flex-shrink:0">
    <span class="t-dot" style="background:currentColor;border-radius:50%"></span>
    {typeLabels[provider.type] || provider.type}
  </span>

  <!-- Info -->
  <div style="flex:1;min-width:0">
    <div class="row">
      <span style="font-weight:600;color:var(--fg)">{provider.name}</span>
      {#if (provider.hiddenModels || []).length > 0}
        <span style="font-size:10px;color:var(--muted);background:var(--input);border:1px solid var(--b-def);padding:1px 7px;border-radius:999px">隐藏 {(provider.hiddenModels || []).length}</span>
      {/if}
      <span
        style="width:7px;height:7px;border-radius:50%;background:{provider.enabled ? 'var(--success)' : 'var(--muted)'};box-shadow:{provider.enabled ? '0 0 8px var(--accent-glow)' : 'none'}"
      ></span>
    </div>
    <div class="mono" style="font-size:11px;color:var(--muted)">{provider.id} · 权重 {provider.weight}</div>
  </div>

  <!-- Actions -->
  <div class="row">
    <button class="icon-btn" style="width:36px;height:36px;color:{provider.hiddenModels && provider.hiddenModels.length ? 'var(--accent)' : 'var(--fg-2)'}" onclick={openHidden} title="管理隐藏模型" aria-label={`管理 ${provider.name} 的隐藏模型`}>
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>
    </button>
    <button class="icon-btn" style="width:36px;height:36px" onclick={() => onedit(provider.id)} title="编辑提供商" aria-label={`编辑 ${provider.name}`}>
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></svg>
    </button>
    <button
      class="icon-btn"
      style="width:36px;height:36px;color:{provider.enabled ? 'var(--warning)' : 'var(--success)'}"
      onclick={() => ontoggle(provider.id)}
      title={provider.enabled ? "禁用提供商" : "启用提供商"}
      aria-label={provider.enabled ? `禁用 ${provider.name}` : `启用 ${provider.name}`}
    >
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"><path d="M18.36 6.64A9 9 0 1 1 5.64 6.64" /><path d="M12 2v9" /></svg>
    </button>
    <button class="icon-btn" style="width:36px;height:36px;color:var(--danger)" onclick={() => ondelete(provider.id)} title="删除提供商" aria-label={`删除 ${provider.name}`}>
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"><path d="M3 6h18M8 6V4h8v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14" /></svg>
    </button>
  </div>
</div>

<Modal bind:open={hiddenOpen} title={`隐藏模型 — ${provider.name}`} onclose={() => (hiddenOpen = false)}>
  <div style="display:flex;flex-direction:column;gap:10px;max-height:50vh;overflow:auto">
    <p style="font-size:12px;color:var(--muted);line-height:1.5">
      勾选后，该模型将<b style="color:var(--fg)">不显示</b>在全局模型列表（<span class="mono" style="font-size:11px">/v1/models</span> 等）中，但仍可通过 API 直接调用。
    </p>
    {#if loadingModels}
      <div style="padding:20px;text-align:center;color:var(--muted);font-size:12px">加载模型列表...</div>
    {:else if models.length === 0}
      <div style="padding:20px;text-align:center;color:var(--muted);font-size:12px">未获取到模型。请在提供商编辑中手动配置模型后再管理隐藏。</div>
    {:else}
      <div style="display:flex;flex-direction:column;gap:4px">
        {#each models as m (m)}
          <label
            style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:10px;border:1px solid var(--b-def);background:var(--input);cursor:pointer;font-size:12px"
          >
            <input type="checkbox" checked={hidden.has(m)} onchange={() => toggleModel(m)} style="accent-color:var(--accent)" />
            <span class="mono" style="flex:1;color:var(--fg)">{m}</span>
            <span style="font-size:10px;color:var(--muted)">{hidden.has(m) ? '已隐藏' : '可见'}</span>
          </label>
        {/each}
      </div>
    {/if}
  </div>
  <div style="display:flex;gap:10px;margin-top:16px">
    <button class="btn btn-soft" style="flex:1;justify-content:center" onclick={() => (hiddenOpen = false)}>取消</button>
    <button class="btn btn-primary" style="flex:1;justify-content:center" disabled={savingHidden || loadingModels} onclick={saveHidden}>
      {savingHidden ? '保存中...' : '保存'}
    </button>
  </div>
</Modal>
