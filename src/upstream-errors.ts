// src/upstream-errors.ts
// Helpers for building safe, JSON-parseable error responses from upstream
// provider replies.
//
// Problem: a proxied provider can return a non-JSON body on error (an HTML
// error page from Cloudflare, an API gateway, a WAF, etc.). Vega currently
// forwards that body verbatim with `Content-Type: application/json`, so the
// client's JSON parser chokes with errors like
//   "Unexpected JSON token at offset 11: Expected EOF after parsing, but had
//    h instead at path: $  JSON input: <!DOCTYPE html>"
// This helper guarantees the body sent to clients is always valid JSON.

/**
 * Ensure the body sent to the client parses as JSON.
 * - Empty body → a clean JSON error.
 * - Already-valid JSON (including upstream JSON error objects) → passed through
 *   verbatim so upstream messages / shapes are preserved.
 * - Anything else (HTML, plain text) → wrapped in a JSON error object so the
 *   client never receives an unparseable body.
 */
export function toJsonErrorBody(errText: string, fallbackMessage: string): string {
	if (!errText) {
		return JSON.stringify({ error: { message: fallbackMessage, type: 'server_error' } });
	}

	try {
		JSON.parse(errText);
		// Valid JSON — forward it unchanged (preserves upstream error shape).
		return errText;
	} catch {
		// Non-JSON (e.g. an HTML error page) — wrap in a JSON error object.
		return JSON.stringify({
			error: {
				message: `${fallbackMessage} (non-JSON upstream response): ${errText.slice(0, 300)}`,
				type: 'server_error',
			},
		});
	}
}
