<script lang="ts">
  import { Power, PowerOff, Pencil, Trash2, GripVertical } from "lucide-svelte";
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
  };

  const typeColorSets: Record<string, { text: string; bg: string; dot: string }> = {
    vertex_ai: { text: "text-vertex", bg: "bg-vertex-subtle", dot: "bg-vertex" },
    google_ai_studio: { text: "text-studio", bg: "bg-studio-subtle", dot: "bg-studio" },
    openai: { text: "text-openai", bg: "bg-openai-subtle", dot: "bg-openai" },
  };

  let colors = $derived(typeColorSets[provider.type] || { text: "text-muted", bg: "bg-surface-elevated", dot: "bg-muted" });
</script>

<div
  class="group bg-surface border border-white/[0.08] rounded-2xl p-4 sm:p-5
         flex items-center gap-3 sm:gap-4
         transition-all duration-200
         hover:border-white/[0.14] hover:bg-surface-elevated hover:shadow-card-hover
         active:scale-[0.995]"
  class:opacity-50={!provider.enabled}
  role="article"
  aria-label={`${provider.name} — ${provider.enabled ? "已启用" : "已禁用"}`}
>
  <!-- Drag handle (desktop only) -->
  <div class="hidden sm:block text-muted/40 shrink-0" aria-hidden="true">
    <GripVertical class="w-4 h-4" />
  </div>

  <!-- Type badge -->
  <span
    class="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg
           text-[11px] font-bold uppercase tracking-wider
           border {colors.text} {colors.bg} border-current/20"
  >
    <span class="w-1.5 h-1.5 rounded-full {colors.dot}" aria-hidden="true"></span>
    {typeLabels[provider.type] || provider.type}
  </span>

  <!-- Info -->
  <div class="flex-1 min-w-0">
    <div class="flex items-center gap-2">
      <span class="font-semibold text-sm text-primary truncate">{provider.name}</span>
      <!-- Status dot -->
      <span
        class="shrink-0 w-1.5 h-1.5 rounded-full {provider.enabled ? 'bg-accent shadow-[0_0_6px_var(--color-accent)]' : 'bg-muted'}"
        aria-hidden="true"
      ></span>
    </div>
    <p class="text-xs text-muted mt-0.5 truncate font-mono tabular-nums">
      {provider.id} &middot; 权重 {provider.weight}
    </p>
  </div>

  <!-- Actions — always visible on mobile, fade on desktop -->
  <div
    class="flex items-center gap-0.5 shrink-0
           sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100
           transition-opacity duration-200"
  >
    <!-- Edit -->
    <button
      class="p-2 rounded-lg hover:bg-surface-hover text-muted hover:text-secondary transition-all duration-150
             min-w-[36px] min-h-[36px] sm:min-w-0 sm:min-h-0
             inline-flex items-center justify-center"
      onclick={() => onedit(provider.id)}
      title="编辑提供商"
      aria-label={`编辑 ${provider.name}`}
    >
      <Pencil class="w-3.5 h-3.5" />
    </button>

    <!-- Toggle -->
    <button
      class="p-2 rounded-lg hover:bg-surface-hover transition-all duration-150
             min-w-[36px] min-h-[36px] sm:min-w-0 sm:min-h-0
             inline-flex items-center justify-center"
      class:text-warning={provider.enabled}
      class:text-accent={!provider.enabled}
      onclick={() => ontoggle(provider.id)}
      title={provider.enabled ? "禁用提供商" : "启用提供商"}
      aria-label={provider.enabled ? `禁用 ${provider.name}` : `启用 ${provider.name}`}
    >
      {#if provider.enabled}
        <PowerOff class="w-3.5 h-3.5 text-warning" />
      {:else}
        <Power class="w-3.5 h-3.5 text-accent" />
      {/if}
    </button>

    <!-- Delete -->
    <button
      class="p-2 rounded-lg hover:bg-danger-subtle text-muted hover:text-danger transition-all duration-150
             min-w-[36px] min-h-[36px] sm:min-w-0 sm:min-h-0
             inline-flex items-center justify-center"
      onclick={() => ondelete(provider.id)}
      title="删除提供商"
      aria-label={`删除 ${provider.name}`}
    >
      <Trash2 class="w-3.5 h-3.5" />
    </button>
  </div>
</div>
