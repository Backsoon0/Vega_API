<script lang="ts">
	/**
	 * CustomSelect — reproduces the reference console's custom animated dropdown
	 * (`.dd` / `.dd-btn` / `.dd-menu` / `.dd-opt`) so the options menu is dark and
	 * matches the theme instead of the OS-rendered (often light) native popup.
	 *
	 * The menu stays in the DOM and the `.open` class on `.dd` is toggled, so the
	 * CSS transitions animate both opening AND closing (opacity/transform/visibility).
	 * Outside-click closes it, which also keeps multiple dropdowns mutually exclusive.
	 *
	 * Usage:
	 *   <CustomSelect {options} bind:value onchange={(v) => ...} small />
	 */
	interface Option {
		value: string | number;
		label: string;
	}

	let {
		options = [] as Option[],
		value = $bindable<string | number>(''),
		onchange = (_: string | number) => {},
		small = false,
		class: extraClass = '',
		placeholder = '请选择',
	} = $props();

	let open = $state(false);
	let rootEl = $state<HTMLElement>();

	const selected = $derived(options.find((o) => String(o.value) === String(value)));
	const selectedLabel = $derived(selected ? selected.label : placeholder);

	function toggle() {
		open = !open;
	}

	function select(v: string | number) {
		value = v;
		open = false;
		onchange(v);
	}

	// Close when clicking outside this dropdown. Because this runs on mousedown
	// (before click), clicking another dropdown's trigger closes this one first,
	// which makes several dropdowns on the same page mutually exclusive.
	$effect(() => {
		if (!open) return;
		function onDocDown(e: MouseEvent) {
			if (!rootEl?.contains(e.target as Node)) open = false;
		}
		document.addEventListener('mousedown', onDocDown);
		return () => document.removeEventListener('mousedown', onDocDown);
	});

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') open = false;
	}
</script>

<svelte:window onkeydown={onKeydown} />

<div
	class="dd {small ? 'dd-sm' : ''} {open ? 'open' : ''} {extraClass}"
	bind:this={rootEl}
>
	<button
		type="button"
		class="dd-btn"
		aria-haspopup="listbox"
		aria-expanded={open}
		onclick={toggle}
	>
		<span class="dd-val">{selectedLabel}</span>
		<svg class="dd-chev" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
	</button>
	<div class="dd-menu" role="listbox">
		{#each options as opt (opt.value)}
			<button
				type="button"
				class="dd-opt {String(opt.value) === String(value) ? 'sel' : ''}"
				data-v={opt.value}
				onclick={() => select(opt.value)}
			>
				{opt.label}
			</button>
		{/each}
	</div>
</div>
