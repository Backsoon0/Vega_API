<script lang="ts">
	import { fly, fade } from "svelte/transition";

	interface Props {
		title: string;
		open?: boolean;
		onclose?: () => void;
		children?: import("svelte").Snippet;
	}

	let { title, open = $bindable(false), onclose, children }: Props = $props();

	function close() {
		open = false;
		onclose?.();
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") close();
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
	<div
		class="modal-wrap on"
		role="dialog"
		aria-modal="true"
		aria-label={title}
		transition:fade={{ duration: 180 }}
	>
		<!-- The backdrop itself is a real <button>, so clicking it closes without a11y warnings. -->
		<button type="button" class="modal-scrim" onclick={close} tabindex="-1" aria-label="关闭对话框"></button>
		<div class="modal-panel" role="document" transition:fly={{ y: 24, duration: 250, easing: (t: number) => 1 - Math.pow(1 - t, 3) }}>
			<div class="modal-head">
				<h3>{title}</h3>
				<button class="icon-btn" onclick={close} aria-label="关闭对话框">
					<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 6 6 18M6 6l12 12" /></svg>
				</button>
			</div>
			<div class="modal-body">
				{#if children}
					{@render children()}
				{/if}
			</div>
		</div>
	</div>
{/if}
