import { describe, it, expect } from "vitest";
import { formatClockLocal, formatDayClockLocal, formatDateTimeLocal } from "../admin-ui/src/lib/utils";

// The backend buckets on UTC and returns hourly keys as bare `YYYY-MM-DDTHH`
// (no zone marker) — the panel must render those in the VIEWER's timezone.
// ES2016+ parses a bare date-time as LOCAL time, so the naive `new Date(key)`
// path is the bug these tests guard against.

const pad = (n) => String(n).padStart(2, "0");
const ISO = "2026-09-12T14:00:00.000Z";

describe("admin-ui viewer-local time formatters", () => {
	it("reads a bare hourly bucket key as UTC, not as local time", () => {
		const key = "2026-09-12T14";
		const asUtc = new Date(ISO); // 14:00Z → viewer-local wall clock
		const fromUtc = `${pad(asUtc.getHours())}:${pad(asUtc.getMinutes())}`;
		const naiveLocal = new Date(key); // parsed as LOCAL per ES2016+
		const fromNaive = `${pad(naiveLocal.getHours())}:${pad(naiveLocal.getMinutes())}`;

		expect(formatClockLocal(key)).toBe(fromUtc);
		// On any non-UTC machine the two differ — prove we did not take the naive path.
		if (fromNaive !== fromUtc) expect(formatClockLocal(key)).not.toBe(fromNaive);
	});

	it("formats each shape in the runtime's own timezone", () => {
		const d = new Date(ISO);
		expect(formatClockLocal(ISO)).toBe(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
		expect(formatDayClockLocal(ISO)).toBe(
			`${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
		);
		expect(formatDateTimeLocal(ISO)).toBe(
			`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
		);
	});

	it("formats the bare key identically to the same instant as full ISO", () => {
		expect(formatDayClockLocal("2026-09-12T14")).toBe(formatDayClockLocal(ISO));
		expect(formatDateTimeLocal("2026-09-12T14")).toBe(formatDateTimeLocal(ISO));
	});

	it("falls back to the raw value when unparsable", () => {
		expect(formatClockLocal("not-a-time")).toBe("not-a-time");
		expect(formatDateTimeLocal("")).toBe("");
	});
});
