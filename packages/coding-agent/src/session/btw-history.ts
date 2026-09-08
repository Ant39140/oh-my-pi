import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { isEnoent, toError } from "@oh-my-pi/pi-utils";
import { replaceFileAtomically } from "../utils/atomic-file";

export interface BtwHistoryTurn {
	question: string;
	answer: string;
	status: "running" | "complete" | "cancelled" | "error" | "interrupted";
	createdAt: number;
	updatedAt: number;
	error?: string;
}

export interface BtwHistoryRecord extends BtwHistoryTurn {
	id: string;
	leafId: string | null;
	followUps?: readonly BtwHistoryTurn[];
}

export function getBtwLatestTurn(record: BtwHistoryRecord): BtwHistoryTurn {
	return record.followUps?.at(-1) ?? record;
}

export function getBtwTurns(record: BtwHistoryRecord): readonly BtwHistoryTurn[] {
	return [record, ...(record.followUps ?? [])];
}

const turnFields = {
	question: "string",
	answer: "string",
	status: "'running' | 'complete' | 'cancelled' | 'error' | 'interrupted'",
	createdAt: "number >= 0",
	updatedAt: "number >= 0",
	"error?": "string",
} as const;
const turnSchema = type({ ...turnFields, "+": "reject" });
const recordSchema = type({
	...turnFields,
	id: "string > 0",
	leafId: "string | null",
	"followUps?": turnSchema.array(),
	"+": "reject",
});

function parseRecord(value: unknown): BtwHistoryRecord {
	const result = recordSchema(value);
	if (result instanceof type.errors) {
		throw new Error(`Invalid BTW history record: ${result.summary}`);
	}
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(result.id)) {
		throw new Error("Invalid BTW history record id");
	}
	for (const turn of getBtwTurns(result)) {
		if (!Number.isFinite(turn.createdAt) || !Number.isFinite(turn.updatedAt)) {
			throw new Error("Invalid BTW history record timestamp");
		}
	}
	return result;
}

function snapshotRecord(record: BtwHistoryRecord, recover = false): BtwHistoryRecord {
	const snapshotTurn = (turn: BtwHistoryTurn): BtwHistoryTurn =>
		Object.freeze({ ...turn, status: recover && turn.status === "running" ? "interrupted" : turn.status });
	return Object.freeze({
		...record,
		status: recover && record.status === "running" ? "interrupted" : record.status,
		...(record.followUps ? { followUps: Object.freeze(record.followUps.map(snapshotTurn)) } : {}),
	});
}

function recordFileName(id: string): string {
	// The prefix also prevents Windows device names (CON, NUL, etc.).
	return `entry-${id}.json`;
}

async function readRecord(filePath: string): Promise<BtwHistoryRecord | undefined> {
	try {
		const stat = await fs.lstat(filePath);
		if (!stat.isFile()) throw new Error("Expected a regular file");
		const value: unknown = await Bun.file(filePath).json();
		const record = parseRecord(value);
		if (path.basename(filePath) !== recordFileName(record.id)) {
			throw new Error("Record id does not match its filename");
		}
		return record;
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw new Error(`Failed to read BTW history ${filePath}: ${toError(error).message}`, { cause: error });
	}
}

/** Session-local sidecar storage; never reads or writes the main session journal. */
export class BtwHistoryStore {
	readonly #directory: string | undefined;
	readonly #records = new Map<string, BtwHistoryRecord>();
	#snapshot: readonly BtwHistoryRecord[] = Object.freeze([]);
	#pending: Promise<void> = Promise.resolve();
	#writeError: Error | undefined;

	constructor(directory: string | undefined) {
		this.#directory = directory;
	}

	static async open(artifactsDir: string | undefined): Promise<BtwHistoryStore> {
		const store = new BtwHistoryStore(
			artifactsDir === undefined ? undefined : path.join(artifactsDir, "btw-history"),
		);
		if (store.#directory === undefined) return store;
		let names: string[];
		try {
			names = await fs.readdir(store.#directory);
		} catch (error) {
			if (isEnoent(error)) return store;
			throw error;
		}
		for (const name of names.sort()) {
			if (!name.endsWith(".json")) continue;
			const record = await readRecord(path.join(store.#directory, name));
			if (!record) continue;
			// Recovery is a view, not a write: another process may still own this
			// record. Never overwrite its newer checkpoint or resubmit its question.
			store.#records.set(record.id, snapshotRecord(record, true));
		}
		store.#refreshSnapshot();
		return store;
	}

	getRecords(): readonly BtwHistoryRecord[] {
		return this.#snapshot;
	}

	async upsert(record: BtwHistoryRecord): Promise<void> {
		if (this.#writeError) throw this.#writeError;
		// Capture before yielding: callers may keep mutating their streaming record.
		const snapshot = snapshotRecord(parseRecord(record));
		this.#records.set(snapshot.id, snapshot);
		this.#refreshSnapshot();
		if (this.#directory === undefined) return;
		const directory = this.#directory;
		const content = `${JSON.stringify(snapshot)}\n`;
		const write = this.#pending.then(async () => {
			if (this.#writeError) throw this.#writeError;
			await fs.mkdir(directory, { recursive: true, mode: 0o700 });
			if (process.platform !== "win32") await fs.chmod(directory, 0o700);
			const filePath = path.join(directory, recordFileName(snapshot.id));
			// Refuse to destroy corruption introduced after open, too.
			await readRecord(filePath);
			const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
			try {
				await fs.writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
				await replaceFileAtomically(temporaryPath, filePath);
			} finally {
				await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
			}
		});
		// Keep the queue handled while retaining the original failure for callers
		// and every later flush/upsert. A successful drain must not hide data loss.
		this.#pending = write.catch(error => {
			this.#writeError ??= toError(error);
		});
		await write;
	}

	async flush(): Promise<void> {
		let pending: Promise<void>;
		do {
			pending = this.#pending;
			await pending;
		} while (pending !== this.#pending);
		if (this.#writeError) throw this.#writeError;
	}

	#refreshSnapshot(): void {
		this.#snapshot = Object.freeze(
			[...this.#records.values()].sort(
				(a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
			),
		);
	}
}
