import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, Message, Usage } from "@oh-my-pi/pi-ai";
import { BtwHistoryPanel } from "@oh-my-pi/pi-coding-agent/modes/components/btw-history-panel";
import { BtwController } from "@oh-my-pi/pi-coding-agent/modes/controllers/btw-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { type BtwHistoryRecord, BtwHistoryStore, getBtwTurns } from "@oh-my-pi/pi-coding-agent/session/btw-history";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as clipboard from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import { Container, type TUI } from "@oh-my-pi/pi-tui";

interface TurnArgs {
	promptText: string;
	history?: readonly Message[];
	conversationKey?: string;
	onTextDelta?: (delta: string) => void;
	signal?: AbortSignal;
}

interface TurnResult {
	replyText: string;
	assistantMessage: AssistantMessage;
}

interface PendingTurn {
	args: TurnArgs;
	resolve: (result: TurnResult) => void;
	reject: (error: Error) => void;
}

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function answer(text: string): TurnResult {
	return {
		replyText: text,
		assistantMessage: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage,
			stopReason: "stop",
			timestamp: Date.now(),
		},
	};
}

async function drain(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
	await initTheme();
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function records(manager: SessionManager): Promise<readonly BtwHistoryRecord[]> {
	const artifacts = manager.getArtifactsDir();
	if (!artifacts) throw new Error("Expected persisted session artifacts");
	return (await BtwHistoryStore.open(artifacts)).getRecords();
}

async function harness() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-btw-follow-up-"));
	const manager = SessionManager.create(directory, directory);
	const managers = [manager];
	const requests: PendingTurn[] = [];
	const runEphemeralTurn = vi.fn((args: TurnArgs) => {
		const pending = Promise.withResolvers<TurnResult>();
		requests.push({ args, resolve: pending.resolve, reject: pending.reject });
		return pending.promise;
	});
	const session = {
		model: { provider: "anthropic", id: "claude-sonnet-4-5" },
		isStreaming: false,
		runEphemeralTurn,
	} as unknown as InteractiveModeContext["session"];
	const ctx = {
		ui: {
			requestRender: vi.fn(),
			requestComponentRender: vi.fn(),
			showOverlay: vi.fn(() => ({ hide: vi.fn() })),
			setFocus: vi.fn(),
			terminal: { rows: 30 },
		} as unknown as TUI,
		btwContainer: new Container(),
		session,
		sessionManager: manager,
		showStatus: vi.fn(),
		showError: vi.fn(),
		handleBtwBranch: vi.fn(async () => {}),
	} as unknown as InteractiveModeContext;
	const controller = new BtwController(ctx);
	cleanups.push(async () => {
		await controller.dispose();
		for (const item of managers) await item.flush();
		await fs.rm(directory, { recursive: true, force: true });
	});
	manager.appendMessage({ role: "user", content: "Main task remains untouched", timestamp: Date.now() });
	await manager.ensureOnDisk();

	async function complete(text: string): Promise<void> {
		const request = requests.at(-1);
		if (!request) throw new Error("Expected a pending BTW turn");
		request.resolve(answer(text));
		await drain();
		await controller.flush();
	}

	async function root(question: string, text: string): Promise<BtwHistoryRecord> {
		await controller.start(question);
		await complete(text);
		const record = (await records(ctx.sessionManager)).find(item => item.question === question);
		if (!record) throw new Error("Expected a persisted root question");
		return record;
	}

	return { directory, manager, managers, ctx, controller, requests, runEphemeralTurn, complete, root };
}

describe("BTW follow-up lifecycle", () => {
	it("opens the just-completed inline topic directly for follow-up without launching a request", async () => {
		const h = await harness();
		await h.root("Earlier topic", "Earlier answer");
		await h.controller.start("Current topic");
		expect(h.controller.canFollowUp()).toBe(false);
		expect(h.controller.handleFollowUp()).toBe(false);
		await h.complete("Current answer");
		const overlay = vi.spyOn(h.ctx.ui, "showOverlay");
		expect(h.controller.canFollowUp()).toBe(true);
		expect(h.controller.handleFollowUp()).toBe(true);
		expect(h.controller.hasActiveRequest()).toBe(false);
		const panel = overlay.mock.calls.at(-1)?.[0];
		if (!(panel instanceof BtwHistoryPanel)) throw new Error("Expected BTW follow-up composer");
		expect(h.runEphemeralTurn).toHaveBeenCalledTimes(2);
		const started = Promise.withResolvers<boolean>();
		const start = h.controller.startFollowUp.bind(h.controller);
		vi.spyOn(h.controller, "startFollowUp").mockImplementation(async (...args) => {
			const accepted = await start(...args);
			started.resolve(accepted);
			return accepted;
		});
		panel.pasteText("Continue this topic");
		panel.handleInput("\r");
		expect(await started.promise).toBe(true);
		expect(h.runEphemeralTurn).toHaveBeenCalledTimes(3);
		const request = h.requests.at(-1)!.args;
		expect(JSON.stringify(request.history)).toContain("Current answer");
		expect(JSON.stringify(request.history)).not.toContain("Earlier answer");
		await h.complete("Continued answer");
		const topics = await records(h.manager);
		expect(topics.find(topic => topic.question === "Current topic")?.followUps?.[0]?.answer).toBe("Continued answer");
	});

	it("resumes only the selected chronological conversation, including cancelled partial output, without promoting it into main chat", async () => {
		const h = await harness();
		const file = h.manager.getSessionFile()!;
		const journal = await Bun.file(file).text();
		const leaf = h.manager.getLeafId();
		const context = JSON.stringify(h.manager.buildSessionContext());
		const root = await h.root("Selected root question", "Selected root answer");
		const originalPrompt = h.requests[0]!.args.promptText;
		const originalConversationKey = h.requests[0]!.args.conversationKey;
		await h.root("Unrelated private question", "Unrelated private answer");
		expect(h.requests.at(-1)!.args.conversationKey).not.toBe(originalConversationKey);

		expect(await h.controller.startFollowUp(root.id, "First follow-up question")).toBe(true);
		expect(h.requests.at(-1)!.args.conversationKey).toBe(originalConversationKey);
		await h.complete("First follow-up answer");
		expect(await h.controller.startFollowUp(root.id, "Cancelled follow-up question")).toBe(true);
		const cancelled = h.requests.at(-1)!;
		cancelled.args.onTextDelta?.("Cancelled partial answer");
		expect(h.controller.handleCancel()).toBe(true);
		expect(cancelled.args.signal?.aborted).toBe(true);
		cancelled.resolve(answer("Ignored cancellation result"));
		await drain();
		await h.controller.flush();
		const beforeReopen = (await records(h.manager)).find(item => item.id === root.id)!;
		expect(getBtwTurns(beforeReopen).map(turn => [turn.question, turn.answer, turn.status])).toEqual([
			["Selected root question", "Selected root answer", "complete"],
			["First follow-up question", "First follow-up answer", "complete"],
			["Cancelled follow-up question", "Cancelled partial answer", "cancelled"],
		]);

		await h.controller.dispose();
		const reopened = await SessionManager.open(file);
		h.managers.push(reopened);
		h.ctx.sessionManager = reopened;
		expect(await h.controller.startFollowUp(root.id, "Continue after cancellation")).toBe(true);
		const request = h.requests.at(-1)!.args;
		expect(request.conversationKey).not.toBe(originalConversationKey);
		expect(request.history?.map(message => message.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		const texts = request.history?.map(message =>
			typeof message.content === "string"
				? message.content
				: message.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join(""),
		);
		expect(texts?.[0]).toBe(originalPrompt);
		expect(texts?.[1]).toBe("Selected root answer");
		expect(texts?.[2]).toContain("First follow-up question");
		expect(texts?.[3]).toBe("First follow-up answer");
		expect(texts?.[4]).toContain("Cancelled follow-up question");
		expect(texts?.[5]).toBe("Cancelled partial answer");
		expect(request.promptText).toContain("Continue after cancellation");
		expect(request.promptText).not.toContain("Selected root question");
		const combined = JSON.stringify(request);
		expect(combined).not.toContain("Unrelated private question");
		expect(combined).not.toContain("Unrelated private answer");
		expect(combined).not.toContain("Ignored cancellation result");
		await h.complete("Resumed follow-up answer");
		await h.controller.dispose();
		const saved = await records(reopened);
		expect(saved).toHaveLength(2);
		const selected = saved.find(item => item.id === root.id)!;
		expect(selected.leafId).toBe(leaf);
		expect(getBtwTurns(selected).map(turn => [turn.question, turn.answer, turn.status])).toEqual([
			["Selected root question", "Selected root answer", "complete"],
			["First follow-up question", "First follow-up answer", "complete"],
			["Cancelled follow-up question", "Cancelled partial answer", "cancelled"],
			["Continue after cancellation", "Resumed follow-up answer", "complete"],
		]);
		expect(await Bun.file(file).text()).toBe(journal);
		expect(reopened.getLeafId()).toBe(leaf);
		expect(JSON.stringify(reopened.buildSessionContext())).toBe(context);
	});

	it("keeps earlier answers after a streamed follow-up errors and copies the latest completed answer", async () => {
		const h = await harness();
		const root = await h.root("Original question", "Original answer");
		expect(await h.controller.startFollowUp(root.id, "Successful continuation")).toBe(true);
		const result = answer("Latest complete answer");
		result.assistantMessage.providerPayload = {
			type: "openaiResponsesHistory",
			provider: "openai-codex",
			dt: true,
			items: [{ type: "reasoning", encrypted_content: "private-provider-payload" }],
		};
		h.requests.at(-1)!.resolve(result);
		await drain();
		await h.controller.flush();
		const copy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const overlay = vi.spyOn(h.ctx.ui, "showOverlay");
		await h.controller.start("");
		const panel = overlay.mock.calls.at(-1)?.[0];
		if (!(panel instanceof BtwHistoryPanel)) throw new Error("Expected BTW history panel");
		panel.handleInput("c");
		await drain();
		expect(copy).toHaveBeenCalledWith("Latest complete answer");

		expect(await h.controller.startFollowUp(root.id, "Failing continuation")).toBe(true);
		h.requests.at(-1)!.args.onTextDelta?.("Partial failing answer");
		h.requests.at(-1)!.reject(new Error("Provider disconnected"));
		await drain();
		await h.controller.flush();
		const saved = (await records(h.manager))[0]!;
		expect(getBtwTurns(saved).map(turn => [turn.answer, turn.status, turn.error])).toEqual([
			["Original answer", "complete", undefined],
			["Latest complete answer", "complete", undefined],
			["Partial failing answer", "error", "Provider disconnected"],
		]);
		expect(JSON.stringify(saved)).not.toContain("private-provider-payload");
	});

	it("rejects blank questions and overlapping starts without adding turns or aborting the accepted request", async () => {
		const h = await harness();
		const root = await h.root("Root", "Answer");
		const before = await records(h.manager);
		expect(await h.controller.startFollowUp(root.id, " \n\t ")).toBe(false);
		expect(await records(h.manager)).toEqual(before);
		expect(h.runEphemeralTurn).toHaveBeenCalledTimes(1);

		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(h.manager, "ensureOnDisk").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
		});
		const starting = h.controller.startFollowUp(root.id, "Accepted continuation");
		await entered.promise;
		expect(await h.controller.startFollowUp(root.id, "Overlapping start")).toBe(false);
		release.resolve();
		expect(await starting).toBe(true);
		await h.controller.start("Overlapping new root");
		expect(await h.controller.startFollowUp(root.id, "Overlapping running turn")).toBe(false);
		expect(h.runEphemeralTurn).toHaveBeenCalledTimes(2);
		expect(h.requests.at(-1)!.args.signal?.aborted).toBe(false);
		await h.complete("Accepted answer");
		const saved = await records(h.manager);
		expect(saved).toHaveLength(1);
		expect(saved[0]!.followUps?.map(turn => turn.question)).toEqual(["Accepted continuation"]);
	});

	it("rotates a cancelled topic transport before a new follow-up while the old request unwinds", async () => {
		const h = await harness();
		const root = await h.root("Topic", "Original answer");
		expect(await h.controller.startFollowUp(root.id, "Cancelled request")).toBe(true);
		const cancelled = h.requests.at(-1)!;
		cancelled.args.onTextDelta?.("Partial answer");
		expect(h.controller.handleCancel()).toBe(true);
		expect(await h.controller.startFollowUp(root.id, "New request")).toBe(true);
		const current = h.requests.at(-1)!;
		expect(current.args.conversationKey).not.toBe(cancelled.args.conversationKey);
		cancelled.args.onTextDelta?.("Stale output");
		cancelled.resolve(answer("Stale final answer"));
		await h.complete("Current answer");
		const saved = (await records(h.manager))[0]!;
		expect(getBtwTurns(saved).map(turn => [turn.answer, turn.status])).toEqual([
			["Original answer", "complete"],
			["Partial answer", "cancelled"],
			["Current answer", "complete"],
		]);
		expect(await h.controller.startFollowUp(root.id, "Continue successfully")).toBe(true);
		expect(h.requests.at(-1)!.args.conversationKey).toBe(current.args.conversationKey);
		await h.complete("Continued answer");
	});

	it("ignores late stream and result after disposal while a different session runs its own follow-up", async () => {
		const h = await harness();
		const oldRoot = await h.root("Old root", "Old answer");
		expect(await h.controller.startFollowUp(oldRoot.id, "Old follow-up")).toBe(true);
		const oldRequest = h.requests.at(-1)!;
		oldRequest.args.onTextDelta?.("Old partial answer");
		await h.controller.dispose();
		expect(oldRequest.args.signal?.aborted).toBe(true);

		const next = SessionManager.create(h.directory, h.directory);
		h.managers.push(next);
		h.ctx.sessionManager = next;
		const newRoot = await h.root("New root", "New answer");
		expect(await h.controller.startFollowUp(newRoot.id, "New follow-up")).toBe(true);
		oldRequest.args.onTextDelta?.("Leaked late delta");
		oldRequest.resolve(answer("Leaked late result"));
		await drain();
		await h.complete("New follow-up answer");
		await h.controller.dispose();
		const oldSaved = (await records(h.manager))[0]!;
		expect(getBtwTurns(oldSaved).map(turn => [turn.answer, turn.status])).toEqual([
			["Old answer", "complete"],
			["Old partial answer", "cancelled"],
		]);
		const newSaved = await records(next);
		expect(newSaved).toHaveLength(1);
		expect(newSaved[0]!.id).toBe(newRoot.id);
		expect(getBtwTurns(newSaved[0]!).map(turn => [turn.answer, turn.status])).toEqual([
			["New answer", "complete"],
			["New follow-up answer", "complete"],
		]);
	});

	it("refuses a follow-up whose asynchronous start outlives disposal and a session switch", async () => {
		const h = await harness();
		const root = await h.root("Old root", "Original answer");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(h.manager, "ensureOnDisk").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
		});
		const starting = h.controller.startFollowUp(root.id, "Must not cross sessions");
		await entered.promise;
		await h.controller.dispose();
		const next = SessionManager.create(h.directory, h.directory);
		h.managers.push(next);
		h.ctx.sessionManager = next;
		release.resolve();
		expect(await starting).toBe(false);
		expect(h.runEphemeralTurn).toHaveBeenCalledTimes(1);
		expect(await records(next)).toEqual([]);
		expect((await records(h.manager))[0]!.followUps ?? []).toEqual([]);
	});
});

function composer(onFollowUp: (record: BtwHistoryRecord, question: string) => Promise<boolean>) {
	const record: BtwHistoryRecord = {
		id: "composer-root",
		leafId: "main-leaf",
		question: "Original question",
		answer: "Original answer",
		status: "complete",
		createdAt: 1,
		updatedAt: 2,
	};
	const onClose = vi.fn();
	const onCopy = vi.fn();
	const onCancel = vi.fn();
	const panel = new BtwHistoryPanel({
		records: [record],
		onClose,
		onCopy,
		onCancel,
		canFollowUp: () => true,
		onFollowUp,
		requestRender: vi.fn(),
		getHeight: () => 30,
	});
	panel.render(100);
	return { panel, record, onClose, onCopy, onCancel };
}

describe("BTW follow-up composer", () => {
	it("uses Tab for pane navigation and Enter to open, then submit, a follow-up", async () => {
		const followUp = vi.fn(async () => true);
		const h = composer(followUp);
		h.panel.handleInput("\t");
		h.panel.handleInput("c");
		expect(h.onCopy).toHaveBeenCalledTimes(1);
		expect(followUp).not.toHaveBeenCalled();

		h.panel.handleInput("\r");
		expect(followUp).not.toHaveBeenCalled();
		h.panel.pasteText("A follow-up");
		h.panel.handleInput("\r");
		await drain();
		expect(followUp).toHaveBeenCalledWith(h.record, "A follow-up");
	});

	it("treats f/c/x as draft text and lets Escape cancel only the composer", () => {
		const followUp = vi.fn(async () => true);
		const h = composer(followUp);
		h.panel.handleInput("f");
		h.panel.render(100);
		for (const key of ["f", "c", "x"]) h.panel.handleInput(key);
		expect(Bun.stripANSI(h.panel.render(100).join("\n"))).toContain("fcx");
		h.panel.handleInput("\x1b");
		h.panel.render(100);
		expect(followUp).not.toHaveBeenCalled();
		expect(h.onCopy).not.toHaveBeenCalled();
		expect(h.onCancel).not.toHaveBeenCalled();
		expect(h.onClose).not.toHaveBeenCalled();
		h.panel.handleInput("\x1b");
		expect(h.onClose).toHaveBeenCalledTimes(1);
	});

	it("submits once while pending and retains the rejected draft for a successful retry", async () => {
		const pending = Promise.withResolvers<boolean>();
		const followUp = vi.fn((_record: BtwHistoryRecord, _question: string) => pending.promise);
		const h = composer(followUp);
		h.panel.handleInput("f");
		h.panel.render(100);
		for (const key of ["f", "c", "x"]) h.panel.handleInput(key);
		h.panel.handleInput("\r");
		h.panel.render(100);
		h.panel.handleInput("\r");
		expect(followUp).toHaveBeenCalledTimes(1);
		expect(followUp).toHaveBeenCalledWith(h.record, "fcx");
		pending.resolve(false);
		await drain();
		expect(Bun.stripANSI(h.panel.render(100).join("\n"))).toContain("fcx");
		followUp.mockResolvedValue(true);
		h.panel.handleInput("\r");
		await drain();
		h.panel.render(100);
		expect(followUp).toHaveBeenCalledTimes(2);
		expect(followUp.mock.calls[1]).toEqual([h.record, "fcx"]);
		h.panel.handleInput("c");
		expect(h.onCopy).toHaveBeenCalledWith(h.record);
		expect(h.onCancel).not.toHaveBeenCalled();
	});
});
