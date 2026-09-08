import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type BtwHistoryRecord, BtwHistoryStore } from "@oh-my-pi/pi-coding-agent/session/btw-history";

describe("BtwHistoryStore", () => {
	let directory: string;
	let artifactsDir: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-btw-history-"));
		artifactsDir = path.join(directory, "session");
	});

	afterEach(async () => {
		await fs.rm(directory, { recursive: true, force: true });
	});

	function record(id: string, overrides: Partial<BtwHistoryRecord> = {}): BtwHistoryRecord {
		return {
			id,
			question: `Question ${id}`,
			answer: `Answer ${id}`,
			status: "complete",
			createdAt: 1,
			updatedAt: 2,
			leafId: "main-leaf",
			...overrides,
		};
	}

	it("retains every entry after reopen without changing the main journal", async () => {
		const journalPath = `${artifactsDir}.jsonl`;
		const journal = '{"type":"session","id":"session"}\n';
		await Bun.write(journalPath, journal);
		const store = await BtwHistoryStore.open(artifactsDir);
		const first = record("first");
		const newerB = record("newer-b", { createdAt: 10, updatedAt: 11 });
		const newerA = record("newer-a", { createdAt: 10, updatedAt: 12, status: "error", error: "Connection lost" });
		await store.upsert(first);
		await store.upsert(newerB);
		await store.upsert(newerA);
		await store.upsert({ ...first, answer: "Revised answer", updatedAt: 20 });
		await store.flush();

		const reopened = await BtwHistoryStore.open(artifactsDir);
		expect(reopened.getRecords()).toEqual([newerA, newerB, { ...first, answer: "Revised answer", updatedAt: 20 }]);
		expect(await Bun.file(journalPath).text()).toBe(journal);
	});

	it("recovers unfinished answers as interrupted without overwriting a live writer", async () => {
		const writer = await BtwHistoryStore.open(artifactsDir);
		const running = record("running", { status: "running", answer: "Partial answer" });
		await writer.upsert(running);
		const recovered = await BtwHistoryStore.open(artifactsDir);
		expect(recovered.getRecords()).toEqual([{ ...running, status: "interrupted" }]);

		const complete = { ...running, status: "complete" as const, answer: "Final answer", updatedAt: 3 };
		await writer.upsert(complete);
		await recovered.flush();
		expect((await BtwHistoryStore.open(artifactsDir)).getRecords()).toEqual([complete]);
	});

	it("does not lose independent entries written by stores opened before either write", async () => {
		const left = await BtwHistoryStore.open(artifactsDir);
		const right = await BtwHistoryStore.open(artifactsDir);
		const first = record("left");
		const second = record("right", { status: "cancelled", answer: "Partial cancelled answer" });
		await Promise.all([left.upsert(first), right.upsert(second)]);
		await Promise.all([left.flush(), right.flush()]);
		expect((await BtwHistoryStore.open(artifactsDir)).getRecords()).toEqual([first, second]);
	});

	it("captures streaming snapshots before queued writes and keeps old views stable", async () => {
		const store = await BtwHistoryStore.open(artifactsDir);
		const streaming = record("streaming", { status: "running", answer: "Captured partial" });
		const pending = store.upsert(streaming);
		const oldView = store.getRecords();
		streaming.answer = "Uncheckpointed text";
		streaming.status = "complete";
		await pending;
		expect((await BtwHistoryStore.open(artifactsDir)).getRecords()[0]).toEqual({
			...streaming,
			answer: "Captured partial",
			status: "interrupted",
		});

		await store.upsert(streaming);
		expect(oldView[0]?.answer).toBe("Captured partial");
		expect(oldView[0]?.status).toBe("running");
		expect((await BtwHistoryStore.open(artifactsDir)).getRecords()).toEqual([streaming]);
	});

	it("snapshots nested follow-ups and recovers only unfinished turns", async () => {
		const store = await BtwHistoryStore.open(artifactsDir);
		const followUp = {
			question: "Continue this topic",
			answer: "Partial",
			status: "running" as const,
			createdAt: 3,
			updatedAt: 4,
		};
		const topic = record("topic", { followUps: [followUp] });
		const writing = store.upsert(topic);
		followUp.answer = "Uncheckpointed";
		await writing;
		expect(store.getRecords()[0]?.followUps?.[0]?.answer).toBe("Partial");
		const recovered = (await BtwHistoryStore.open(artifactsDir)).getRecords()[0]!;
		expect(recovered.status).toBe("complete");
		expect(recovered.answer).toBe("Answer topic");
		expect(recovered.followUps).toEqual([{ ...followUp, answer: "Partial", status: "interrupted" }]);
		const raw = await Bun.file(path.join(artifactsDir, "btw-history", "entry-topic.json")).json();
		expect(raw.followUps[0].status).toBe("running");
	});

	it("surfaces malformed JSON without replacing any saved bytes", async () => {
		const store = await BtwHistoryStore.open(artifactsDir);
		await store.upsert(record("valid", { status: "running" }));
		const corruptPath = path.join(artifactsDir, "btw-history", "entry-corrupt.json");
		const invalid = '{"id":"corrupt",';
		await Bun.write(corruptPath, invalid);
		const validPath = path.join(artifactsDir, "btw-history", "entry-valid.json");
		const validBefore = await Bun.file(validPath).text();

		await expect(BtwHistoryStore.open(artifactsDir)).rejects.toThrow("Failed to read BTW history");
		expect(await Bun.file(corruptPath).text()).toBe(invalid);
		expect(await Bun.file(validPath).text()).toBe(validBefore);
	});

	it("rejects unknown fields, invalid status, nonfinite timestamps, and mismatched identities", async () => {
		const historyDir = path.join(artifactsDir, "btw-history");
		await fs.mkdir(historyDir, { recursive: true });
		const filePath = path.join(historyDir, "entry-record.json");
		const malformed = [
			JSON.stringify({ ...record("record"), injectedContext: "must not persist" }),
			JSON.stringify({ ...record("record"), status: "queued" }),
			JSON.stringify(record("record")).replace('"createdAt":1', '"createdAt":1e999'),
			JSON.stringify(record("different-id")),
		];
		for (const content of malformed) {
			await Bun.write(filePath, content);
			await expect(BtwHistoryStore.open(artifactsDir)).rejects.toThrow("Failed to read BTW history");
			expect(await Bun.file(filePath).text()).toBe(content);
		}
	});

	it("rejects traversal ids before creating files or accepting the record", async () => {
		const store = await BtwHistoryStore.open(artifactsDir);
		await expect(store.upsert(record("../../outside"))).rejects.toThrow("Invalid BTW history record id");
		expect(store.getRecords()).toEqual([]);
		expect(await fs.readdir(directory)).toEqual([]);
	});

	it("retains write failures through flush and refuses to overwrite later corruption", async () => {
		const store = await BtwHistoryStore.open(artifactsDir);
		const saved = record("saved");
		await store.upsert(saved);
		const filePath = path.join(artifactsDir, "btw-history", "entry-saved.json");
		await Bun.write(filePath, "broken");
		await expect(store.upsert({ ...saved, answer: "Replacement" })).rejects.toThrow("Failed to read BTW history");
		await expect(store.flush()).rejects.toThrow("Failed to read BTW history");
		await expect(store.upsert(record("later"))).rejects.toThrow("Failed to read BTW history");
		await expect(store.flush()).rejects.toThrow("Failed to read BTW history");
		expect(await Bun.file(filePath).text()).toBe("broken");
		expect(await fs.readdir(path.dirname(filePath))).toEqual(["entry-saved.json"]);
	});

	it("publishes private records and removes staged files after queued writes drain", async () => {
		const store = await BtwHistoryStore.open(artifactsDir);
		const first = store.upsert(record("first"));
		const second = store.upsert(record("second"));
		await store.flush();
		await Promise.all([first, second]);
		const historyDir = path.join(artifactsDir, "btw-history");
		expect((await fs.readdir(historyDir)).sort()).toEqual(["entry-first.json", "entry-second.json"]);
		if (process.platform !== "win32") {
			expect((await fs.stat(historyDir)).mode & 0o777).toBe(0o700);
			expect((await fs.stat(path.join(historyDir, "entry-first.json"))).mode & 0o777).toBe(0o600);
		}
	});
});
