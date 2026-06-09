<script lang="ts">
  import { Power, PowerOff, Pencil, Trash2 } from "lucide-svelte";
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

  const typeColors: Record<string, string> = {
    vertex_ai: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    google_ai_studio: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    openai: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  };
</script>

<div
  class="group bg-zinc-900/80 border border-zinc-800 rounded-xl p-5 flex items-center gap-4 transition-all duration-200 hover:border-zinc-700 hover:bg-zinc-900"
  class:opacity-50={!provider.enabled}
>
  <!-- Type badge -->
  <span
    class="inline-flex items-center px-2.5 py-1 rounded-lg text-[11px] font-semibold uppercase tracking-wider border {typeColors[provider.type] || 'bg-zinc-800 text-zinc-400'}"
  >
    {typeLabels[provider.type] || provider.type}
  </span>

  <!-- Info -->
  <div class="flex-1 min-w-0">
    <div class="flex items-center gap-2">
      <span class="font-semibold text-sm text-zinc-100">{provider.name}</span>
      {#if provider.enabled}
        <span class="w-1.5 h-1.5 rounded-full bg-emerald-400" title="已启用"></span>
      {:else}
        <span class="w-1.5 h-1.5 rounded-full bg-zinc-600" title="已禁用"></span>
      {/if}
    </div>
    <p class="text-xs text-zinc-500 mt-0.5 truncate">
      {provider.id} · 权重 {provider.weight}
    </p>
  </div>

  <!-- Actions -->
  <div class="flex items-center gap-1 transition-opacity sm:opacity-0 group-hover:opacity-100">
    <button
      class="p-2 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
      onclick={() => onedit(provider.id)}
      title="编辑"
    >
      <Pencil class="w-3.5 h-3.5" />
    </button>
    <button
      class="p-2 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
      onclick={() => ontoggle(provider.id)}
      title={provider.enabled ? "禁用" : "启用"}
    >
      {#if provider.enabled}
        <PowerOff class="w-3.5 h-3.5 text-amber-400" />
      {:else}
        <Power class="w-3.5 h-3.5 text-emerald-400" />
      {/if}
    </button>
    <button
      class="p-2 rounded-lg hover:bg-red-500/10 text-zinc-400 hover:text-red-400 transition-colors"
      onclick={() => ondelete(provider.id)}
      title="删除"
    >
      <Trash2 class="w-3.5 h-3.5" />
    </button>
  </div>
</div>
