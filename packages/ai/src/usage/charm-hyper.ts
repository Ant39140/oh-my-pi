import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import type { UsageFetchContext, UsageFetchParams, UsageLimit, UsageProvider, UsageReport } from "../usage";

const PROVIDER = "charm-hyper";
const CREDITS_URL = "https://hyper.charm.land/v1/credits";

/**
 * Charm Hyper sells prepaid credits: `/v1/credits` answers `{"balance": N}` and
 * nothing else — no allowance, no spend-to-date, no reset window — so the limit
 * is remaining-only by construction. Synthesizing a total from the first
 * observed balance would misreport every later top-up, so we report only what
 * the API states.
 */
async function fetchCharmHyperUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== PROVIDER) return null;
	const credential = params.credential;
	if (credential.type !== "api_key" || !credential.apiKey) return null;

	let payload: unknown = null;
	try {
		const response = await ctx.fetch(CREDITS_URL, {
			headers: {
				Authorization: `Bearer ${credential.apiKey}`,
				Accept: "application/json",
			},
			signal: params.signal,
		});
		if (!response.ok) {
			ctx.logger?.warn("Charm Hyper usage fetch failed", {
				status: response.status,
				statusText: response.statusText,
			});
			return null;
		}
		payload = await response.json();
	} catch (error) {
		ctx.logger?.warn("Charm Hyper usage fetch error", { error: String(error) });
		return null;
	}

	if (!isRecord(payload)) return null;
	const balance = payload.balance;
	if (typeof balance !== "number" || !Number.isFinite(balance)) return null;

	const limit: UsageLimit = {
		id: "charm-hyper:credits",
		label: "Credit balance",
		// Windowless bucket key, so multiple keys group into one row and the
		// report's window suffix stays quiet (the label already says "balance").
		scope: { provider: params.provider, windowId: "balance" },
		amount: { remaining: balance, unit: "credits" },
	};

	return {
		provider: params.provider,
		fetchedAt: Date.now(),
		limits: [limit],
		metadata: { endpoint: CREDITS_URL },
		raw: payload,
	};
}

export const charmHyperUsageProvider: UsageProvider = {
	id: PROVIDER,
	fetchUsage: fetchCharmHyperUsage,
	supports: params => params.provider === PROVIDER && params.credential.type === "api_key",
	validatesCredentials: true,
};
