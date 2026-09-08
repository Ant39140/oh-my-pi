import { beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

function createMoveContext(sourceDir: string, settingsFlush?: () => Promise<void>) {
	const state = { cwd: sourceDir, movedTo: undefined as string | undefined, completedBtwVisible: true };
	const present = vi.fn();
	const applyCwdChange = vi.fn(async (cwd: string) => {
		expect(state.cwd).toBe(cwd);
		return true;
	});
	const moveSession = vi.fn(async (cwd: string) => {
		state.cwd = cwd;
		state.movedTo = cwd;
	});
	const sessionDir = `${sourceDir}/.sessions`;
	const captureState = vi.fn(() => ({ cwd: state.cwd, sessionDir, movedTo: state.movedTo }));
	const restoreState = vi.fn((snapshot: { cwd: string }) => {
		state.cwd = snapshot.cwd;
	});
	const rollbackMove = vi.fn(async (snapshot: { cwd: string }) => {
		state.cwd = snapshot.cwd;
		state.movedTo = snapshot.cwd;
		restoreState(snapshot);
	});
	const shutdown = vi.fn(async () => {});
	const withBtwSessionMove = vi.fn(async (operation: () => Promise<boolean>) => {
		const moved = await operation();
		if (moved) state.completedBtwVisible = false;
		return moved;
	});
	const ctx = {
		session: { isStreaming: false, moveSession },
		sessionManager: {
			getCwd: () => state.cwd,
			captureState,
			restoreState,
			rollbackMove,
			dropSession: vi.fn(async () => {}),
		},
		settings: {
			flush: vi.fn(settingsFlush ?? (async () => {})),
		},
		showHookCustom: vi.fn(),
		showHookConfirm: vi.fn(),
		showError: vi.fn(),
		showWarning: vi.fn(),
		applyCwdChange,
		withBtwSessionMove,
		updateEditorBorderColor: vi.fn(),
		reloadTodos: vi.fn(async () => {}),
		ui: { requestRender: vi.fn() },
		present,
		shutdown,
	} as unknown as InteractiveModeContext;
	return { ctx, state, present, captureState, restoreState, rollbackMove, shutdown, sessionDir, withBtwSessionMove };
}

describe("CommandController /move", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	it("relocates the active session before re-scoping cwd-derived state", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-target-"));
		try {
			const { ctx, state, present } = createMoveContext(sourceDir);
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(state.movedTo).toBe(targetDir);
			expect(state.completedBtwVisible).toBe(false);
			expect(ctx.sessionManager.dropSession).not.toHaveBeenCalled();
			expect(ctx.applyCwdChange).toHaveBeenCalledWith(targetDir);
			expect(ctx.updateEditorBorderColor).toHaveBeenCalled();
			expect(ctx.reloadTodos).toHaveBeenCalled();
			expect(ctx.ui.requestRender).toHaveBeenCalledWith();
			expect(present).toHaveBeenCalled();
			expect(ctx.showError).not.toHaveBeenCalled();
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});

	it("restores captured manager state when cwd application fails", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-target-"));
		try {
			const { ctx, state, captureState, restoreState, rollbackMove, shutdown, withBtwSessionMove } =
				createMoveContext(sourceDir);
			let applyCount = 0;
			ctx.applyCwdChange = vi.fn(async () => {
				applyCount += 1;
				return applyCount > 1;
			});
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(ctx.session.moveSession).toHaveBeenCalledTimes(1);
			expect(rollbackMove).toHaveBeenCalledWith(captureState.mock.results[0]?.value);
			expect(state.cwd).toBe(sourceDir);
			expect(state.completedBtwVisible).toBe(true);
			expect(await withBtwSessionMove.mock.results[0]?.value).toBe(false);
			expect(restoreState).toHaveBeenCalledWith(captureState.mock.results[0]?.value);
			expect(shutdown).not.toHaveBeenCalled();
			expect(ctx.updateEditorBorderColor).not.toHaveBeenCalled();
			expect(ctx.reloadTodos).not.toHaveBeenCalled();
			expect(ctx.ui.requestRender).not.toHaveBeenCalled();
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});
	it("shuts down when rollback and workspace realignment both fail", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-target-"));
		try {
			const { ctx, shutdown, rollbackMove } = createMoveContext(sourceDir);
			let applyCount = 0;
			ctx.applyCwdChange = vi.fn(async () => {
				applyCount += 1;
				if (applyCount === 1) throw new Error("target setup failed");
				return false;
			});
			rollbackMove.mockRejectedValueOnce(new Error("rollback denied"));
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(shutdown).toHaveBeenCalledTimes(1);
			expect(ctx.present).not.toHaveBeenCalled();
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});
	it("stops recovery after aligning with the moved session", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-target-"));
		try {
			const { ctx, shutdown, rollbackMove } = createMoveContext(sourceDir);
			ctx.applyCwdChange = vi
				.fn()
				.mockRejectedValueOnce(new Error("target setup failed"))
				.mockResolvedValueOnce(true)
				.mockResolvedValueOnce(true);
			rollbackMove.mockRejectedValueOnce(new Error("rollback denied"));
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(ctx.applyCwdChange).toHaveBeenCalledTimes(2);
			expect(ctx.applyCwdChange).toHaveBeenNthCalledWith(1, targetDir);
			expect(ctx.applyCwdChange).toHaveBeenNthCalledWith(2, targetDir);
			expect(shutdown).not.toHaveBeenCalled();
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});

	it("aborts /move when pending settings flush fails, leaving cwd untouched", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-target-"));
		try {
			const { ctx, state, withBtwSessionMove } = createMoveContext(sourceDir, async () => {
				throw new Error("disk full");
			});
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("disk full"));
			expect(ctx.session.moveSession).not.toHaveBeenCalled();
			expect(ctx.applyCwdChange).not.toHaveBeenCalled();
			expect(withBtwSessionMove).not.toHaveBeenCalled();
			expect(state.completedBtwVisible).toBe(true);
			expect(state.movedTo).toBeUndefined();
			expect(state.cwd).toBe(sourceDir);
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});

	it.each(["cancelled picker", "empty path", "missing parent", "declined creation", "streaming"] as const)(
		"preserves the session and BTW state before migration on %s",
		async rejection => {
			const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
			try {
				const { ctx, state, withBtwSessionMove } = createMoveContext(sourceDir);
				const targetDir = path.join(sourceDir, "destination");
				let targetPath: string | undefined = targetDir;
				switch (rejection) {
					case "cancelled picker":
						targetPath = undefined;
						break;
					case "empty path":
						targetPath = '""';
						break;
					case "missing parent":
						targetPath = path.join(targetDir, "nested");
						break;
					case "declined creation":
						ctx.showHookConfirm = vi.fn(async () => false);
						break;
					case "streaming":
						Object.defineProperty(ctx.session, "isStreaming", { value: true });
						break;
				}
				const controller = new CommandController(ctx);

				await controller.handleMoveCommand(targetPath);

				expect(withBtwSessionMove).not.toHaveBeenCalled();
				expect(ctx.session.moveSession).not.toHaveBeenCalled();
				expect(ctx.applyCwdChange).not.toHaveBeenCalled();
				expect(state.cwd).toBe(sourceDir);
				expect(state.movedTo).toBeUndefined();
				expect(state.completedBtwVisible).toBe(true);
				expect(ctx.present).not.toHaveBeenCalled();
				await expect(fs.stat(targetDir)).rejects.toMatchObject({ code: "ENOENT" });
			} finally {
				await fs.rm(sourceDir, { recursive: true, force: true });
			}
		},
	);

	it("does not relocate session files or cwd when the BTW migration gate refuses", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-target-"));
		try {
			const { ctx, state } = createMoveContext(sourceDir);
			const sourceFile = path.join(sourceDir, "session.jsonl");
			const targetFile = path.join(targetDir, "session.jsonl");
			await Bun.write(sourceFile, "session data\n");
			ctx.session.moveSession = vi.fn(async cwd => {
				await fs.rename(sourceFile, targetFile);
				state.cwd = cwd;
				state.movedTo = cwd;
			});
			ctx.withBtwSessionMove = vi.fn(async () => false);
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(await Bun.file(sourceFile).text()).toBe("session data\n");
			expect(await Bun.file(targetFile).exists()).toBe(false);
			expect(state.cwd).toBe(sourceDir);
			expect(state.movedTo).toBeUndefined();
			expect(state.completedBtwVisible).toBe(true);
			expect(ctx.applyCwdChange).not.toHaveBeenCalled();
			expect(ctx.present).not.toHaveBeenCalled();
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});

	it("preserves completed BTW state when moving the session fails", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-target-"));
		try {
			const { ctx, state, withBtwSessionMove } = createMoveContext(sourceDir);
			ctx.session.moveSession = vi.fn(async () => {
				throw new Error("session move denied");
			});
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(await withBtwSessionMove.mock.results[0]?.value).toBe(false);
			expect(state.completedBtwVisible).toBe(true);
			expect(state.cwd).toBe(sourceDir);
			expect(state.movedTo).toBeUndefined();
			expect(ctx.applyCwdChange).not.toHaveBeenCalled();
			expect(ctx.present).not.toHaveBeenCalled();
			expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("session move denied"));
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});
});
