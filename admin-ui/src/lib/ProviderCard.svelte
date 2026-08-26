<script lang="ts">
  import type { Provider } from "$lib/api";

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
      <span
        style="width:7px;height:7px;border-radius:50%;background:{provider.enabled ? 'var(--success)' : 'var(--muted)'};box-shadow:{provider.enabled ? '0 0 8px var(--accent-glow)' : 'none'}"
      ></span>
    </div>
    <div class="mono" style="font-size:11px;color:var(--muted)">{provider.id} · 权重 {provider.weight}</div>
  </div>

  <!-- Actions -->
  <div class="row">
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
