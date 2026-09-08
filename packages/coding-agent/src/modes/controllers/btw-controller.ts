import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import { type OverlayHandle, replaceTabs } from "@oh-my-pi/pi-tui";
import { logger, prompt, Snowflake } from "@oh-my-pi/pi-utils";
import btwUserPrompt from "../../prompts/system/btw-user.md" with { type: "text" };
import {
	type BtwHistoryRecord,
	type BtwHistoryTurn,
	BtwHistoryStore,
	getBtwLatestTurn,
	getBtwTurns,
} from "../../session/btw-history";
import { copyToClipboard } from "../../utils/clipboard";
import { BtwHistoryPanel } from "../components/btw-history-panel";
import { BtwPanelComponent } from "../components/btw-panel";
import type { InteractiveModeContext } from "../types";

interface BtwRequest {
	component: BtwPanelComponent;
	abortController: AbortController;
	question: string;
	leafId: string | null;
	sessionId: string;
	session: InteractiveModeContext["session"];
	store: BtwHistoryStore;
	record: BtwHistoryRecord;
	history?: readonly BtwHistoryTurn[];
	conversationKey: string;
}

function assistantMessageWithReplyText(assistantMessage: AssistantMessage, replyText: string): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	let replacedText = false;
	for (const part of assistantMessage.content) {
		if (part.type === "thinking") {
			content.push({ type: "thinking", thinking: part.thinking });
			continue;
		}
		if (part.type === "redactedThinking") continue;
		if (part.type !== "text") {
			content.push(part);
			continue;
		}
		if (replacedText) continue;
		content.push({ type: "text", text: replyText });
		replacedText = true;
	}
	if (!replacedText) content.push({ type: "text", text: replyText });
	return { ...assistantMessage, content, providerPayload: undefined };
}

export class BtwController {
	#activeRequest: BtwRequest | undefined;
	#lastQuestion: string | undefined;
	#lastReplyText: string | undefined;
	#lastAssistantMessage: AssistantMessage | undefined;
	#lastLeafId: string | null | undefined;
	#lastSessionId: string | undefined;
	#branchInFlight = false;
	#lastCopyText: string | undefined;
	#copyInFlight = false;
	#visible = false;
	#starting = false;
	#generation = 0;
	#store: BtwHistoryStore | undefined;
	#storePromise: Promise<BtwHistoryStore> | undefined;
	#storeSessionId: string | undefined;
	#storeArtifactsDir: string | undefined;
	#historyPanel: BtwHistoryPanel | undefined;
	#historyOverlay: OverlayHandle | undefined;
	readonly #writes = new Set<Promise<void>>();

	constructor(private readonly ctx: InteractiveModeContext) {}

	/** Whether the inline panel owns Escape, not whether its hidden request is running. */
	hasActiveRequest(): boolean {
		return this.#visible;
	}

	canBranch(): boolean {
		return this.#branchUnavailableReason() === undefined;
	}

	/** Whether plain `b` is currently reserved for a completed or pending branch action. */
	handlesBranchKey(): boolean {
		if (this.#branchInFlight) return true;
		if (!this.#visible || this.#activeRequest?.component.isBranchable() !== true) return false;
		return (
			this.#lastQuestion !== undefined &&
			this.#lastReplyText !== undefined &&
			this.#lastAssistantMessage !== undefined &&
			this.#lastLeafId !== undefined &&
			this.#lastSessionId !== undefined
		);
	}

	#branchUnavailableReason(): string | undefined {
		if (this.#branchInFlight) return "a branch is already in progress";
		if (!this.#visible || this.#activeRequest?.component.isBranchable() !== true) return "the answer is not ready";
		if (!this.#lastQuestion || !this.#lastReplyText || !this.#lastAssistantMessage)
			return "the answer is unavailable";
		if (!this.#lastLeafId) return "the session has no branch point";
		if (
			this.#lastSessionId !== this.ctx.sessionManager.getSessionId() ||
			this.#lastLeafId !== this.ctx.sessionManager.getLeafId()
		)
			return "the session changed since /btw started";
		if (this.ctx.session.isStreaming) return "a turn is still running";
		return undefined;
	}

	canCopy(): boolean {
		return (
			this.#visible &&
			!this.#copyInFlight &&
			this.#activeRequest?.component.isCopyable() === true &&
			this.#lastCopyText !== undefined
		);
	}

	async #copyAnswer(answer: string): Promise<boolean> {
		if (this.#copyInFlight || !answer.trim()) return false;
		this.#copyInFlight = true;
		try {
			await copyToClipboard(replaceTabs(answer).trim());
			this.ctx.showStatus("Copied /btw answer to clipboard");
			return true;
		} catch (error) {
			this.ctx.showError(error instanceof Error ? error.message : String(error));
			return true;
		} finally {
			this.#copyInFlight = false;
		}
	}

	async handleCopy(): Promise<boolean> {
		if (!this.canCopy() || this.#lastCopyText === undefined) return false;
		return this.#copyAnswer(this.#lastCopyText);
	}

	async handleBranch(): Promise<boolean> {
		const unavailableReason = this.#branchUnavailableReason();
		if (unavailableReason) {
			this.ctx.showStatus(`/btw branch unavailable: ${unavailableReason}`, { dim: true });
			return false;
		}
		const request = this.#activeRequest;
		const question = this.#lastQuestion;
		const assistantMessage = this.#lastAssistantMessage;
		const leafId = this.#lastLeafId;
		const sessionId = this.#lastSessionId;
		if (!request || !question || !assistantMessage || !leafId || !sessionId) return false;
		this.#branchInFlight = true;
		request.component.markBranching();
		try {
			await this.flush();
			await this.ctx.handleBtwBranch(question, assistantMessage, leafId, sessionId);
			return true;
		} finally {
			this.#branchInFlight = false;
			if (this.#activeRequest === request) request.component.markComplete();
		}
	}

	handleEscape(): boolean {
		if (this.#branchInFlight) {
			this.ctx.showStatus("/btw branch is in progress", { dim: true });
			return true;
		}
		if (!this.#visible) return false;
		this.#hideInline();
		return true;
	}

	canFollowUp(): boolean {
		const request = this.#activeRequest;
		return (
			this.#visible &&
			!this.#starting &&
			!this.#branchInFlight &&
			request !== undefined &&
			this.#isActiveRequest(request) &&
			getBtwLatestTurn(request.record).status === "complete"
		);
	}

	handleFollowUp(): boolean {
		const request = this.#activeRequest;
		if (!request || !this.canFollowUp()) return false;
		return this.#showHistory(request.store).openFollowUp(request.record.id);
	}

	canCancel(): boolean {
		return (
			this.#visible &&
			this.#activeRequest !== undefined &&
			getBtwLatestTurn(this.#activeRequest.record).status === "running"
		);
	}

	handleCancel(): boolean {
		const request = this.#activeRequest;
		if (!request || getBtwLatestTurn(request.record).status !== "running") return false;
		this.#updateRequest(request, { status: "cancelled", updatedAt: Date.now() });
		request.abortController.abort();
		request.component.markAborted();
		this.#persist(request);
		this.#refreshHistory();
		return true;
	}

	async dispose(): Promise<void> {
		this.#generation++;
		this.#starting = false;
		this.handleCancel();
		this.#closeHistory();
		this.#hideInline();
		this.#activeRequest?.component.close();
		this.#activeRequest = undefined;
		this.#clearCompletedState();
		this.#store = undefined;
		this.#storePromise = undefined;
		this.#storeSessionId = undefined;
		this.#storeArtifactsDir = undefined;
		await this.flush();
	}

	async flush(): Promise<void> {
		while (this.#writes.size > 0) await Promise.all(this.#writes);
	}

	async #loadHistory(): Promise<BtwHistoryStore> {
		const sessionId = this.ctx.sessionManager.getSessionId();
		const artifactsDir = this.ctx.sessionManager.getArtifactsDir() ?? undefined;
		if (this.#storeSessionId !== sessionId || this.#storeArtifactsDir !== artifactsDir) {
			const closing = this.dispose();
			this.#starting = true;
			this.#storeSessionId = sessionId;
			this.#storeArtifactsDir = artifactsDir;
			await closing;
			if (this.#storeSessionId !== sessionId || this.#storeArtifactsDir !== artifactsDir) {
				throw new Error("The session changed while opening BTW history.");
			}
		}
		this.#storePromise ??= BtwHistoryStore.open(artifactsDir);
		const pending = this.#storePromise;
		try {
			const store = await pending;
			if (this.#storePromise === pending) this.#store = store;
			return store;
		} catch (error) {
			if (this.#storePromise === pending) this.#storePromise = undefined;
			throw error;
		}
	}

	async start(question: string): Promise<void> {
		await this.#start(question);
	}

	async startFollowUp(recordId: string, question: string): Promise<boolean> {
		if (!question.trim()) return false;
		return this.#start(question, recordId);
	}

	async #start(question: string, recordId?: string): Promise<boolean> {
		const trimmedQuestion = question.trim();
		if (this.#starting || this.#branchInFlight) {
			this.ctx.showStatus("A /btw action is in progress. Please wait.", { dim: true });
			return false;
		}
		if (
			trimmedQuestion &&
			this.#activeRequest &&
			getBtwLatestTurn(this.#activeRequest.record).status === "running" &&
			this.#activeRequest.sessionId === this.ctx.sessionManager.getSessionId()
		) {
			this.ctx.showStatus("A /btw question is still running. Open /btw to view it or cancel it first.", {
				dim: true,
			});
			return false;
		}
		const originalSessionId = this.ctx.sessionManager.getSessionId();
		this.#starting = true;
		try {
			const store = await this.#loadHistory();
			const generation = this.#generation;
			const sessionId = this.ctx.sessionManager.getSessionId();
			if (store !== this.#store || sessionId !== originalSessionId) return false;
			if (!trimmedQuestion) {
				this.#showHistory(store);
				return true;
			}
			const previous = recordId ? store.getRecords().find(record => record.id === recordId) : undefined;
			if (recordId && (!previous || getBtwLatestTurn(previous).status === "running")) {
				this.ctx.showStatus("This side conversation is unavailable or still running.", { dim: true });
				return false;
			}
			const session = this.ctx.session;
			if (!session.model) {
				this.ctx.showError("No active model available for /btw.");
				return false;
			}
			await this.ctx.sessionManager.ensureOnDisk();
			if (generation !== this.#generation || sessionId !== this.ctx.sessionManager.getSessionId()) return false;
			if (!previous) this.#closeHistory();
			this.#activeRequest?.component.close();
			this.#clearCompletedState();
			const now = Date.now();
			const leafId = this.ctx.sessionManager.getLeafId();
			const turn: BtwHistoryTurn = {
				question: trimmedQuestion,
				answer: "",
				status: "running",
				createdAt: now,
				updatedAt: now,
			};
			const record: BtwHistoryRecord = previous
				? { ...previous, followUps: [...(previous.followUps ?? []), turn] }
				: { ...turn, id: Snowflake.next(), leafId };
			const history = previous ? getBtwTurns(previous) : undefined;
			// A cancelled/failed transport may still be unwinding. Start a fresh
			// lineage after that boundary, while successful follow-ups share one.
			const transportEpoch = (history?.findLastIndex(item => item.status !== "complete") ?? -1) + 1;
			const request: BtwRequest = {
				component: new BtwPanelComponent({
					question: trimmedQuestion,
					tui: this.ctx.ui,
					canBranch: () => this.canBranch(),
					canFollowUp: () => this.canFollowUp(),
				}),
				abortController: new AbortController(),
				question: trimmedQuestion,
				leafId,
				sessionId,
				session,
				store,
				record,
				history,
				conversationKey: `btw:${record.id}:${transportEpoch}`,
			};
			this.#activeRequest = request;
			this.#visible = !previous;
			this.ctx.btwContainer.clear();
			if (this.#visible) this.ctx.btwContainer.addChild(request.component);
			this.ctx.ui.requestRender();
			this.#persist(request);
			this.#refreshHistory();
			void this.#runRequest(request);
			return true;
		} catch (error) {
			this.ctx.showError(`Cannot open /btw history: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		} finally {
			this.#starting = false;
		}
	}

	#showHistory(store: BtwHistoryStore): BtwHistoryPanel {
		if (this.#historyOverlay && this.#historyPanel) {
			this.#refreshHistory();
			return this.#historyPanel;
		}
		this.#hideInline();
		const panel = new BtwHistoryPanel({
			records: this.#historyRecords(store),
			onClose: () => this.#closeHistory(),
			onCopy: record => {
				void this.#copyAnswer(getBtwLatestTurn(record).answer);
			},
			onCancel: record => {
				if (this.#activeRequest?.record.id === record.id) this.handleCancel();
			},
			canFollowUp: record =>
				!this.#starting &&
				!this.#branchInFlight &&
				getBtwLatestTurn(record).status !== "running" &&
				(!this.#activeRequest || getBtwLatestTurn(this.#activeRequest.record).status !== "running"),
			onFollowUp: (record, question) => {
				if (this.#store !== store || this.#storeSessionId !== this.ctx.sessionManager.getSessionId()) {
					return Promise.resolve(false);
				}
				return this.startFollowUp(record.id, question);
			},
			requestRender: () => this.ctx.ui.requestRender(),
			getHeight: () => this.ctx.ui.terminal.rows,
		});
		this.#historyPanel = panel;
		this.#historyOverlay = this.ctx.ui.showOverlay(panel, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.ctx.ui.setFocus(panel);
		this.ctx.ui.requestRender();
		return panel;
	}

	#historyRecords(store: BtwHistoryStore): readonly BtwHistoryRecord[] {
		const records = store.getRecords();
		const request = this.#activeRequest;
		if (!request || request.store !== store) return records;
		return records.map(record => (record.id === request.record.id ? request.record : record));
	}

	#refreshHistory(): void {
		if (this.#historyPanel && this.#store) this.#historyPanel.update(this.#historyRecords(this.#store));
	}

	#closeHistory(): void {
		const overlay = this.#historyOverlay;
		this.#historyOverlay = undefined;
		this.#historyPanel = undefined;
		if (!overlay) return;
		overlay.hide();
		this.ctx.ui.requestRender();
	}

	#persist(request: BtwRequest): void {
		const write = request.store.upsert(request.record).catch(error => {
			logger.error("BTW history save failed", { error });
			if (request.sessionId === this.ctx.sessionManager.getSessionId()) {
				this.ctx.showError(
					`Could not save /btw history: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		});
		this.#writes.add(write);
		void write.finally(() => this.#writes.delete(write));
	}

	#updateRequest(request: BtwRequest, patch: Partial<BtwHistoryTurn>): void {
		const followUps = request.record.followUps;
		if (followUps?.length) {
			request.record = {
				...request.record,
				followUps: [...followUps.slice(0, -1), { ...followUps[followUps.length - 1]!, ...patch }],
			};
		} else {
			request.record = { ...request.record, ...patch };
		}
	}

	async #runRequest(request: BtwRequest): Promise<void> {
		try {
			const promptText = prompt.render(btwUserPrompt, { question: request.question });
			const model = request.session.model;
			if (!model) throw new Error("No active model available for /btw.");
			const history: Message[] = [];
			for (const turn of request.history ?? []) {
				history.push({
					role: "user",
					content: [{ type: "text", text: prompt.render(btwUserPrompt, { question: turn.question }) }],
					attribution: "agent",
					timestamp: turn.createdAt,
				});
				if (!turn.answer) continue;
				// Saved BTW history contains visible text, not provider-native reasoning
				// or replay signatures. These are context messages, not new billed turns.
				history.push({
					role: "assistant",
					content: [{ type: "text", text: turn.answer }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: turn.updatedAt,
				});
			}
			const { replyText, assistantMessage } = await request.session.runEphemeralTurn({
				promptText,
				history,
				conversationKey: request.conversationKey,
				onTextDelta: delta => {
					const latest = getBtwLatestTurn(request.record);
					if (latest.status !== "running") return;
					this.#updateRequest(request, { answer: latest.answer + delta, updatedAt: Date.now() });
					if (this.#isActiveRequest(request)) {
						if (this.#visible) request.component.appendText(delta);
						this.#refreshHistory();
					}
				},
				signal: request.abortController.signal,
			});
			if (getBtwLatestTurn(request.record).status !== "running") return;
			this.#updateRequest(request, { answer: replyText, status: "complete", updatedAt: Date.now() });
			if (this.#isActiveRequest(request)) {
				request.component.setAnswer(replyText);
				request.component.markComplete();
				const copyText = request.component.getCopyText();
				if (copyText !== undefined) {
					this.#lastQuestion = request.question;
					this.#lastReplyText = replyText;
					this.#lastCopyText = copyText;
					this.#lastAssistantMessage = assistantMessageWithReplyText(assistantMessage, replyText);
					this.#lastLeafId = request.leafId;
					this.#lastSessionId = request.sessionId;
				} else this.#clearCompletedState();
			}
		} catch (error) {
			if (getBtwLatestTurn(request.record).status !== "running") return;
			const cancelled = request.abortController.signal.aborted;
			const message = error instanceof Error ? error.message : String(error);
			this.#updateRequest(request, {
				status: cancelled ? "cancelled" : "error",
				updatedAt: Date.now(),
				...(cancelled ? {} : { error: message }),
			});
			if (this.#isActiveRequest(request)) {
				if (cancelled) request.component.markAborted();
				else request.component.markError(message);
			}
		}
		this.#persist(request);
		if (this.#isActiveRequest(request)) this.#refreshHistory();
	}

	#hideInline(): void {
		this.#visible = false;
		this.ctx.btwContainer.clear();
		this.ctx.ui.requestRender();
	}

	#clearCompletedState(): void {
		this.#lastQuestion = undefined;
		this.#lastReplyText = undefined;
		this.#lastAssistantMessage = undefined;
		this.#lastCopyText = undefined;
		this.#lastLeafId = undefined;
		this.#lastSessionId = undefined;
	}

	#isActiveRequest(request: BtwRequest): boolean {
		return this.#activeRequest === request && request.sessionId === this.ctx.sessionManager.getSessionId();
	}
}
