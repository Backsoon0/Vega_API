<script lang="ts">
  import CallLogTable from "$lib/CallLogTable.svelte";
  import { getLogs, mergeLogs, clearLogs as clearStoredLogs, type CallLogEntry } from "$lib/logStore";
  import { authToken } from "$lib/api";
  import { ListTodo } from "lucide-svelte";

  let entries = $state<CallLogEntry[]>(getLogs());
  let error = $state('');

  // Poll for new logs every 5 seconds
  $effect(() => {
    if (!authToken) return;
    const interval = setInterval(async () => {
      try {
        const resp = await fetch('/admin/logs', {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (!resp.ok) return;
        const data = await resp.json();
        if (data.logs?.length) {
          mergeLogs(data.logs);
          entries = getLogs();
        }
      } catch (err) {
        error = '获取日志失败';
      }
    }, 5000);

    return () => clearInterval(interval);
  });

  function handleClear() {
    entries = [];
  }
</script>

<svelte:head><title>调用记录 — Vega API</title></svelte:head>

<div class="max-w-6xl mx-auto">
  <div class="mb-8">
    <h1 class="text-lg font-bold text-primary font-mono flex items-center gap-2">
      <ListTodo class="w-5 h-5" stroke-width={1.5} />
      调用记录
    </h1>
    <p class="text-xs text-muted mt-1">实时 API 调用日志（数据仅存储在浏览器本地）</p>
  </div>

  <CallLogTable entries={entries} onclear={handleClear} />
</div>
