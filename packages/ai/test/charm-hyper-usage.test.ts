import { describe, expect, it } from "bun:test";

import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { resolveUsedFraction, type UsageFetchContext, type UsageFetchParams } from "@oh-my-pi/pi-ai/usage";
import { charmHyperUsageProvider } from "@oh-my-pi/pi-ai/usage/charm-hyper";

function makeCredential(): UsageFetchParams["credential"] {
	return {
		type: "api_key",
		apiKey: "sk-hyper-test-key",
	};
}

type SeenRequest = { url?: string; headers?: Record<string, string> };

function makeCtx(body: string, status = 200, seen?: SeenRequest): UsageFetchContext {
	const fetch: FetchImpl = async (url, init) => {
		if (seen) {
			seen.url = String(url);
			seen.headers = init?.headers as Record<string, string> | undefined;
		}
		return new Response(body, { status, headers: { "content-type": "application/json" } });
	};
	return { fetch };
}

describe("charm hyper usage provider", () => {
	it("maps a credit balance to a remaining-only credits limit with no synthesized total", async () => {
		// Hyper reports a prepaid balance and nothing else. Inventing a `limit`,
		// `used`, or `usedFraction` here would make `/usage` draw a quota bar
		// against a total the account never had.
		const seen: SeenRequest = {};
		const report = await charmHyperUsageProvider.fetchUsage(
			{ provider: "charm-hyper", credential: makeCredential(), signal: undefined },
			makeCtx(`{"balance": 100}`, 200, seen),
		);

		expect(seen.url).toBe("https://hyper.charm.land/v1/credits");
		expect(seen.headers?.Authorization).toBe("Bearer sk-hyper-test-key");

		expect(report).not.toBeNull();
		expect(report!.limits).toHaveLength(1);
		const limit = report!.limits[0]!;
		expect(limit.amount).toEqual({ remaining: 100, unit: "credits" });
		expect(limit.window).toBeUndefined();
		expect(resolveUsedFraction(limit)).toBeUndefined();
	});

	it("returns null rather than a zero balance when the response cannot be trusted", async () => {
		// Each row is a different way the endpoint can fail; every one of them
		// must read as "no data", never as an account that ran out of credits.
		const cases: [name: string, body: string, status: number][] = [
			["auth failure", `{"error":"authentication failed"}`, 401],
			["server error", `{"balance": 100}`, 500],
			["unparseable body", "not-json{{{", 200],
			["balance absent", `{}`, 200],
			["balance not a number", `{"balance":"100"}`, 200],
			["balance not finite", `{"balance": null}`, 200],
		];
		for (const [name, body, status] of cases) {
			const report = await charmHyperUsageProvider.fetchUsage(
				{ provider: "charm-hyper", credential: makeCredential(), signal: undefined },
				makeCtx(body, status),
			);
			expect(report, name).toBeNull();
		}
	});

	it("returns null for credentials it has no bearer key for", async () => {
		// Guards against probing upstream with a literal `Bearer undefined`.
		const oauthCredential = { type: "oauth" } as UsageFetchParams["credential"];
		const oauth = await charmHyperUsageProvider.fetchUsage(
			{ provider: "charm-hyper", credential: oauthCredential, signal: undefined },
			makeCtx(`{"balance": 100}`),
		);
		expect(oauth).toBeNull();

		const keyless = await charmHyperUsageProvider.fetchUsage(
			{ provider: "charm-hyper", credential: { type: "api_key" }, signal: undefined },
			makeCtx(`{"balance": 100}`),
		);
		expect(keyless).toBeNull();
	});
});
