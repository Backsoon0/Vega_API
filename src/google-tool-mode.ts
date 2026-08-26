// src/google-tool-mode.ts
// Controls how Google/Vertex model requests that replay tool calls are routed.
//
// Gemini 3 (and some "thinking" Gemini models) require a thought_signature on
// every replayed functionCall part. The light OpenAI-compat passthrough cannot
// carry one, so Google rejects those requests with HTTP 400 "Function call is
// missing a thought_signature". Only the AI SDK Google provider (which sends the
// native Gemini/Vertex request and injects the documented
// `skip_thought_signature_validator` sentinel) can make them succeed.
//
// However, the AI SDK path does more CPU work per request (structured parse of
// the native stream), which can matter on the Cloudflare free tier's tight CPU
// budget. So the mode is configurable:
//   VEGA_GOOGLE_TOOL_MODE = "ai-sdk" (default) → correct for Gemini 3 + tools.
//   VEGA_GOOGLE_TOOL_MODE = "direct"          → lighter direct passthrough with
//                                               reasoning stripped; lower CPU,
//                                               but Gemini 3 tool calls will be
//                                               rejected (Gemini 2.5 is fine).

export function shouldUseAISDKForGoogleTools(env: { VEGA_GOOGLE_TOOL_MODE?: string }): boolean {
	if (!env) return true;
	const mode = (env.VEGA_GOOGLE_TOOL_MODE || 'ai-sdk').trim().toLowerCase();
	return mode !== 'direct';
}
