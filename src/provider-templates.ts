// src/provider-templates.ts
// Provider preset templates (feature 2).
//
// Templates are code-level constants — they are NOT persisted to the DB. A
// template is a "quick prefill" for the ProviderForm: selecting one fills
// type/baseUrl/etc., and the user is free to override anything before saving.
// Secret keys are intentionally left blank (the user must supply their own).
//
// No localhost/intranet templates are included (Ollama, LM Studio, vLLM, ...)
// because those rely on loopback addresses that are unreachable from the
// distributed Cloudflare Workers / Vercel runtimes.

export interface ProviderTemplate {
	id: string;
	label: string;
	type: 'openai' | 'google_ai_studio' | 'vertex_ai' | 'anthropic';
	description: string;
	/** Prefilled config fields (never secrets). */
	config: Record<string, string>;
	/** Suggested routing weight (optional). */
	weight?: number;
}

export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
	// OpenAI-compatible tier (reuse the 'openai' type; only baseUrl differs).
	{ id: 'openai-official', label: 'OpenAI 官方', type: 'openai', description: 'OpenAI 官方 API', config: { baseUrl: 'https://api.openai.com/v1' } },
	{ id: 'openai-deepseek', label: 'DeepSeek', type: 'openai', description: 'DeepSeek V3/R1 等模型', config: { baseUrl: 'https://api.deepseek.com/v1' } },
	{ id: 'openai-xai', label: 'xAI (Grok)', type: 'openai', description: 'xAI Grok 系列', config: { baseUrl: 'https://api.x.ai/v1' } },
	{ id: 'openai-groq', label: 'Groq', type: 'openai', description: 'Groq 高速推理', config: { baseUrl: 'https://api.groq.com/openai/v1' } },
	{ id: 'openai-openrouter', label: 'OpenRouter', type: 'openai', description: 'OpenRouter 聚合平台', config: { baseUrl: 'https://openrouter.ai/api/v1' } },
	{ id: 'openai-zhipu', label: '智谱 GLM', type: 'openai', description: '智谱 GLM 系列', config: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4' } },
	{ id: 'openai-moonshot', label: '月之暗面 Kimi', type: 'openai', description: 'Kimi / Moonshot 系列', config: { baseUrl: 'https://api.moonshot.cn/v1' } },
	// Native-type templates.
	{ id: 'google-studio', label: 'Google AI Studio', type: 'google_ai_studio', description: 'Google AI Studio (Gemini)', config: {} },
	{ id: 'anthropic', label: 'Anthropic Claude', type: 'anthropic', description: 'Anthropic Claude 系列', config: {} },
	// Vertex AI template.
	{ id: 'vertex-default', label: 'Vertex AI (自定义)', type: 'vertex_ai', description: 'Google Cloud Vertex AI', config: { location: 'global' } },
];
