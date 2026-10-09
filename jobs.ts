/**
 * Jobs Extension
 *
 * Runs a shell command as a background **job** and starts a new turn when that
 * job exits. The agent does not hold a turn open while it waits.
 *
 * One job is one command, one log file, one exit code.
 *
 * Tools:
 *   job_start   start a job, return at once
 *   job_status  report state, exit code, elapsed time, log tail. Can block.
 *   job_stop    signal a job and its children
 *
 * Command:
 *   /jobs       open work above the editor, no model turn
 *   /jobs all   the whole session, finished rows included, and it stays
 *   /jobs clear take the table away
 *   `running` means the same as no argument, it is the default.
 *
 * The wake-up path:
 *   child exits -> push to a pending list -> arm one debounce timer ->
 *   drain the list into ONE message -> pi.sendUserMessage().
 *   Several jobs that exit together produce one turn. A job that exits while
 *   the agent streams is delivered as a follow-up, after the current turn. A
 *   job the agent stopped with job_stop opens no turn, because the tool output
 *   of that call already carries the result. A `wait` in job_status that ends
 *   with the exit pulls that job out of the batch for the same reason.
 *
 * A run you cancelled with Escape holds the wake-ups. An exit inside the hold
 * still writes its durable entry, and /jobs still lists the job. The next input
 * you type or send over RPC releases the hold, and the batch then opens a turn
 * after that run settles. See the `agent_settled` and `input` handlers.
 *
 * Rendering:
 *   The three tools draw one line per job. The default tool shell keeps its own
 *   padding, so `outputPad` from the render context applies with no work here.
 *   `durationMs` from that context is the time `execute()` took, which is how
 *   long a `wait` in job_status blocked.
 *
 * What the human sees without asking:
 *   The footer carries a running count, `2 jobs running`, cleared when nothing
 *   runs. Pi joins every extension status on one line sorted by key, so the text
 *   stays short, one line, no path. `PI_JOBS_FOOTER=0` leaves the footer alone.
 *   `/jobs` puts a table above the editor: a header with the count of the whole
 *   session, then one aligned row per open job. The table is redrawn on every
 *   settle and taken away when its kind has no row left, so a table of open work
 *   cannot rot with finished rows. While a job runs it also repaints once a
 *   second, so its seconds move with no key press. A log path costs 60 columns,
 *   so the widget leaves it out and the plain listing in other modes keeps it.
 *
 * Lifetime:
 *   A job is a child of this Pi process. `session_shutdown` signals every
 *   running job, for every reason including `reload`, then gives it two seconds
 *   to finish its own cleanup before it signals the process group again. No job
 *   outlives the runtime that started it, so nothing is rebuilt on
 *   `session_start`.
 *
 * Print and JSON modes have no idle agent to wake. There the model collects a
 * result with the `wait` parameter of job_status, and the run ending stops any
 * job still running.
 *
  * Log files:
 *   One file per job, named <id>-<pid>.log. The pid is the Pi process that wrote
 *   it. The number continues after the highest one this pid left in the
 *   directory, so a reload cannot land on an earlier log and cut it off. Two Pi
 *   processes never collide, each owns the name carrying its own pid, and the
 *   seed reads the directory, so a pid handed back by the operating system keeps
 *   counting too. The number restarts only in an empty directory.
 *
 *   Prune runs on `session_start`, while the session is idle and no path is in
 *   use yet. Two triggers, either one is enough: a log older than
 *   PI_JOBS_KEEP_DAYS whose Pi process is gone, and the oldest logs of dead
 *   processes beyond the newest PI_JOBS_KEEP. A log whose Pi process still runs
 *   is never touched, so the ceiling can only reach runs that ended. Only the
 *   name pattern j<number>-<pid>.log is pruned, so a foreign file in a shared
 *   PI_JOBS_DIR survives. The directory is 0700 and a log is 0600: mkdir and
 *   open mask the mode with the umask, so tighten sets it again after the call,
 *   and the sweep tightens what an older version left behind.
 *
 * Settings (environment variables):
 *   PI_JOBS_DEBOUNCE_MS  window that coalesces exits into one turn (default 400)
 *   PI_JOBS_WAIT_MAX_S   largest `wait` accepted by job_status (default 300).
 *                        It caps only what the model asks for. The internal
 *                        waits of job_stop keep their own fixed limits.
 *   PI_JOBS_TAIL_BYTES   log bytes read into a report or a wake-up (default 3000)
 *   PI_JOBS_FOOTER       0 leaves the Pi footer alone, so no job count shows there
 *   PI_JOBS_TICK_MS      repaint interval of an open table (default 1000). Zero
 *                        keeps it still. The timer runs only while the table is
 *                        open and a job is running, and it is unref'd, so it
 *                        never holds the process open.
 *   PI_JOBS_DIR          log directory (default <tmpdir>/pi-jobs)
 *   PI_JOBS_KEEP_DAYS    age a dead process's log may reach (default 7). Zero
 *                        turns the prune off altogether.
 *   PI_JOBS_KEEP         how many logs of dead processes the ceiling spares
 *                        (default 200). Zero turns the ceiling off.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
	type ThemeColor,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const DEBOUNCE_MS = Number(process.env.PI_JOBS_DEBOUNCE_MS ?? 400);
const WAIT_MAX_S = Number(process.env.PI_JOBS_WAIT_MAX_S ?? 300);
const TAIL_BYTES = Number(process.env.PI_JOBS_TAIL_BYTES ?? 3000);
// The footer count is on unless the human turns it off.
const FOOTER = process.env.PI_JOBS_FOOTER !== "0";
// How often an open table repaints itself, so its seconds move. 0 keeps it still.
const TICK_MS = Number(process.env.PI_JOBS_TICK_MS ?? 1000);
const LOG_DIR = process.env.PI_JOBS_DIR ?? join(tmpdir(), "pi-jobs");
const KEEP_DAYS = Number(process.env.PI_JOBS_KEEP_DAYS ?? 7);
const KEEP_FILES = Number(process.env.PI_JOBS_KEEP ?? 200);
const MAX_TRACKED = 50;
// Time a job gets to finish its own cleanup after the signal at shutdown. It
// matches the ceiling job_stop keeps.
const STOP_GRACE_MS = 2000;

type JobState = "running" | "ok" | "fail" | "stopped";

interface Job {
	id: string;
	name: string;
	command: string;
	cwd: string;
	pid?: number;
	state: JobState;
	exitCode: number | null;
	signal: string | null;
	logPath: string;
	startedAt: number;
	endedAt: number | null;
	stopRequested: boolean;
	// True once a tool result carried this exit to the agent. The wake-up then
	// has nothing left to say, so the job leaves the pending batch.
	reported: boolean;
	child: ChildProcess | null;
}

// A type alias, not an interface. TypeScript gives an alias an implicit index
// signature, so a view satisfies the JsonValue of structuredContent. An
// interface does not, and the tool result then fails to type check.
type JobView = {
	id: string;
	name: string;
	command: string;
	state: string;
	exit_code: number | null;
	signal: string | null;
	pid: number | null;
	log: string;
	elapsed_sec: number;
	tail: string;
};

const jobs = new Map<string, Job>();
const waiters = new Map<string, Array<() => void>>();
let pending: Job[] = [];
let seq = 0;
// The table above the editor: which rows it holds, or null when none is drawn.
let tableMode: "running" | "all" | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
// The one-second repaint of an open table. Null when nothing needs repainting.
let ticker: ReturnType<typeof setInterval> | null = null;
let closed = false;
let seen: ExtensionContext | null = null;
let api: ExtensionAPI | null = null;
// A run the user cancelled leaves the agent idle. Wake-ups then open a turn the
// user did not ask for, so they wait while `held` is true. `pendingRelease` is
// one human message in flight: it clears the hold when its run settles.
let held = false;
let pendingRelease = false;
let batchWaited = false;

/** Wait for a while. Used to watch jobs end during shutdown. */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellBinary(): string {
	for (const candidate of [process.env.SHELL, "/bin/bash", "/bin/sh"]) {
		if (candidate && existsSync(candidate)) return candidate;
	}
	return "/bin/sh";
}

/** Read the last bytes of a log file. */
function tail(path: string, maxBytes: number): string {
	let size = 0;
	try {
		size = statSync(path).size;
	} catch {
		return "";
	}
	const length = Math.min(size, maxBytes);
	if (length === 0) return "";
	const buffer = Buffer.alloc(length);
	let handle: number;
	try {
		handle = openSync(path, "r");
	} catch {
		return "";
	}
	try {
		readSync(handle, buffer, 0, length, size - length);
	} finally {
		closeSync(handle);
	}
	const prefix = size > length ? `... ${size - length} bytes above ...\n` : "";
	return prefix + buffer.toString("utf8").replace(/\s+$/, "");
}

/** True when a pid still has a process behind it. The log name carries the pid that wrote it. */
function ownerAlive(pid: string): boolean {
	try {
		process.kill(Number(pid), 0);
		return true;
	} catch {
		return false;
	}
}

/** Remove one log file. Another run may have reached it first. */
function drop(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// Gone already, or not ours to remove.
	}
}

/**
 * Set an exact mode. mkdir and open mask the mode they are given with the umask, so the mode is set
 * again after the call. A file another account owns resists, and that is left alone.
 */
function tighten(path: string, mode: number): void {
	try {
		chmodSync(path, mode);
	} catch {
		// Not ours to tighten.
	}
}

/**
 * Drop log files no run needs any more. Two triggers, either one is enough.
 *
 * The owner of a log is the process that wrote it, and its pid sits in the file
 * name. A log whose owner still runs never leaves, so both triggers can only
 * reach files of runs that ended. An old log of a dead owner leaves on its own.
 * The pile of young logs of dead owners shrinks to the ceiling, oldest first,
 * so a burst of short runs cannot fill the disk between two sweeps.
 *
 * PI_JOBS_KEEP_DAYS=0 turns the sweep off. PI_JOBS_KEEP=0 turns the ceiling off.
 */
/**
 * Number the next job after the highest number this process left in the log directory. A reload keeps
 * the pid and resets the counter, so the next job would land on an existing path, and open with "w"
 * cuts that log off. Only this pid is read, so logs of other runs never push the number around.
 */
function seedSeq(): void {
	let names: string[];
	try {
		names = readdirSync(LOG_DIR);
	} catch {
		return;
	}
	const mine = new RegExp(`^j(\\d+)-${process.pid}\\.log$`);
	for (const name of names) {
		const match = mine.exec(name);
		if (match) seq = Math.max(seq, Number(match[1]));
	}
}

function pruneLogs(): void {
	// Access control does not wait for retention, and does not wait for a job. A missing directory
	// resists the chmod, and tighten keeps quiet about it.
	tighten(LOG_DIR, 0o700);
	if (KEEP_DAYS <= 0) return;
	let names: string[];
	try {
		names = readdirSync(LOG_DIR);
	} catch {
		return;
	}
	const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
	const young: Array<{ path: string; mtime: number }> = [];
	for (const name of names) {
		const match = /^j\d+-(\d+)\.log$/.exec(name);
		if (!match) continue;
		const path = join(LOG_DIR, name);
		let mtime: number;
		try {
			mtime = statSync(path).mtimeMs;
		} catch {
			continue;
		}
		const owned = ownerAlive(match[1]!);
		if (!owned && mtime <= cutoff) {
			drop(path);
			continue;
		}
		// Keep, so make it read-only to the rest of the machine. This also fixes logs an older
		// version wrote world readable.
		tighten(path, 0o600);
		// A log whose Pi process still runs is never a candidate for the ceiling.
		if (!owned && mtime > cutoff) young.push({ path, mtime });
	}
	if (KEEP_FILES <= 0 || young.length <= KEEP_FILES) return;
	young.sort((a, b) => a.mtime - b.mtime);
	while (young.length > KEEP_FILES) drop(young.shift()!.path);
}

function indent(text: string, pad = "    "): string {
	if (!text) return `${pad}(no output)`;
	return text
		.split("\n")
		.map((part) => `${pad}${part}`)
		.join("\n");
}

function seconds(job: Job): number {
	return Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000);
}

function outcome(job: Job): string {
	if (job.state === "stopped") return `stopped, signal ${job.signal ?? "unknown"}`;
	return `exit code ${job.exitCode ?? "null"}`;
}

function view(job: Job, tailBytes: number): JobView {
	return {
		id: job.id,
		name: job.name,
		command: job.command,
		state: job.state,
		exit_code: job.exitCode,
		signal: job.signal,
		pid: job.pid ?? null,
		log: job.logPath,
		elapsed_sec: seconds(job),
		tail: tailBytes > 0 ? tail(job.logPath, tailBytes) : "",
	};
}

function signalJob(job: Job, signal: NodeJS.Signals): void {
	if (!job.pid) return;
	// A detached child leads its own process group, so the negative id reaches
	// the commands the job started. Fall back to the direct child.
	try {
		process.kill(-job.pid, signal);
		return;
	} catch {
		// Group gone, or the child is not a group leader.
	}
	try {
		process.kill(job.pid, signal);
	} catch {
		// Already exited.
	}
}

function record(job: Job): void {
	if (closed || !api) return;
	// Durable record. It stays out of the model context, so /jobs and a resumed
	// session can still show what ran here.
	api.appendEntry("jobs", {
		id: job.id,
		name: job.name,
		command: job.command,
		state: job.state,
		exit_code: job.exitCode,
		signal: job.signal,
		log: job.logPath,
		elapsed_sec: seconds(job),
	});
}

function settle(job: Job, exitCode: number | null, signal: string | null): void {
	if (job.state !== "running") return;
	job.endedAt = Date.now();
	job.exitCode = exitCode;
	job.signal = signal;
	job.state = job.stopRequested ? "stopped" : exitCode === 0 ? "ok" : "fail";
	job.child = null;
	record(job);
	if (seen) drawHud(seen);
	const callbacks = waiters.get(job.id) ?? [];
	waiters.delete(job.id);
	for (const callback of callbacks) callback();
	if (closed) return;
	// A stop the agent asked for reports its own result in the tool output. A
	// wake-up there would open a second turn for news the model already holds.
	if (job.stopRequested) return;
	pending.push(job);
	// A long hold must not grow without a limit. The oldest held exit leaves.
	while (pending.length > MAX_TRACKED) pending.shift();
	arm();
}

function arm(): void {
	if (timer !== null || pending.length === 0) return;
	timer = setTimeout(flush, DEBOUNCE_MS);
	timer.unref?.();
}

/**
 * Take a job out of the batch, because a tool result already carried its exit.
 * A batch that already went out cannot be recalled, so the wake-up still lands
 * when the debounce timer beat the caller.
 */
function collect(job: Job): void {
	job.reported = true;
	const at = pending.indexOf(job);
	if (at === -1) return;
	pending.splice(at, 1);
	// An empty batch leaves no news behind. Without this, the note about a
	// cancelled run would attach to the next batch.
	if (pending.length === 0) batchWaited = false;
}

function describe(job: Job): string {
	const label = job.name === job.id ? job.id : `${job.id} ${job.name}`;
	return `- ${label}: ${outcome(job)} after ${seconds(job)}s. Command: ${job.command}\n  Log: ${job.logPath}\n  Last output:\n${indent(tail(job.logPath, TAIL_BYTES), "  ")}`;
}

function flush(): void {
	timer = null;
	if (held) {
		// Keep the batch for the next run the human starts. No timer is armed, so
		// the `agent_settled` handler that ends the hold calls arm() again.
		if (pending.length) batchWaited = true;
		return;
	}
	const batch = pending;
	pending = [];
	if (closed || batch.length === 0) return;
	const ctx = seen;
	if (!api || !ctx) return;
	// Print and JSON modes have no idle agent. A message there can extend a run
	// that already decided to exit.
	if (ctx.mode === "print" || ctx.mode === "json") return;
	const waited = batchWaited;
	batchWaited = false;
	const head = headLine(batch, waited);
	const text = `${head}\n${batch.map(describe).join("\n")}\n\nRead each log, then continue the task that started the job.`;
	if (ctx.isIdle()) api.sendUserMessage(text);
	else api.sendUserMessage(text, { deliverAs: "followUp" });
}

/** Title of a wake-up message. It says when the jobs finished relative to the run. */
function headLine(batch: Job[], waited: boolean): string {
	const count = batch.length === 1 ? "One background job" : `${batch.length} background jobs`;
	if (waited) return `${count} finished while the run was cancelled:`;
	return batch.length === 1 ? `${count} finished:` : `${count} finished in one batch:`;
}

function startJob(params: { command: string; name?: string; cwd?: string }, ctx: ExtensionContext): Job {
	mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
	// recursive: true leaves the mode of a directory that already existed.
	tighten(LOG_DIR, 0o700);
	const id = `j${++seq}`;
	const job: Job = {
		id,
		name: params.name?.trim() || id,
		command: params.command,
		cwd: params.cwd && isAbsolute(params.cwd) ? params.cwd : ctx.cwd,
		state: "running",
		exitCode: null,
		signal: null,
		logPath: join(LOG_DIR, `${id}-${process.pid}.log`),
		startedAt: Date.now(),
		endedAt: null,
		stopRequested: false,
		reported: false,
		child: null,
	};
	const handle = openSync(job.logPath, "w", 0o600);
	tighten(job.logPath, 0o600);
	let child: ChildProcess;
	try {
		child = spawn(shellBinary(), ["-c", params.command], {
			cwd: job.cwd,
			detached: true,
			stdio: ["ignore", handle, handle],
			env: process.env,
		});
	} finally {
		closeSync(handle);
	}
	job.child = child;
	job.pid = child.pid;
	child.on("error", (error) => settle(job, null, `spawn-error: ${error.message}`));
	child.on("close", (code, signal) => settle(job, code, signal));
	jobs.set(job.id, job);
	// Keep the table bounded. The oldest finished job leaves first. A running
	// job is never dropped.
	while (jobs.size > MAX_TRACKED) {
		const oldestFinished = [...jobs.values()].find((other) => other.state !== "running");
		if (!oldestFinished) break;
		jobs.delete(oldestFinished.id);
	}
	record(job);
	return job;
}

/** Wait for a job to settle. The caller owns the limit, in seconds. */
function waitUntil(job: Job, limit: number): Promise<boolean> {
	if (job.state !== "running") return Promise.resolve(true);
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timeout);
			resolve(true);
		};
		const list = waiters.get(job.id) ?? [];
		list.push(done);
		waiters.set(job.id, list);
		const timeout = setTimeout(() => {
			const rest = (waiters.get(job.id) ?? []).filter((callback) => callback !== done);
			if (rest.length) waiters.set(job.id, rest);
			else waiters.delete(job.id);
			resolve(false);
		}, limit * 1000);
		timeout.unref?.();
	});
}

/** Jobs of this session, oldest first. */
function list(): Job[] {
	return [...jobs.values()];
}

function pickOne(jobId: string): Job {
	const job = jobs.get(jobId);
	if (!job) throw new Error(`No job with id ${jobId}. Known ids: ${[...jobs.keys()].join(", ") || "none"}.`);
	return job;
}

const jobViewSchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	command: Type.String(),
	state: Type.String({ description: "running, ok, fail, or stopped" }),
	exit_code: Type.Union([Type.Number(), Type.Null()]),
	signal: Type.Union([Type.String(), Type.Null()]),
	pid: Type.Union([Type.Number(), Type.Null()]),
	log: Type.String(),
	elapsed_sec: Type.Number(),
	tail: Type.String(),
});

const outputSchema = Type.Object({
	jobs: Type.Array(jobViewSchema, { description: "One entry per job" }),
});

function report(list: Job[], note?: string, tailBytes = TAIL_BYTES) {
	const views = list.map((job) => view(job, tailBytes));
	const body = views.length
		? views
				.map(
					(job) =>
						`${job.id} ${job.name} [${job.state}] exit=${job.exit_code ?? "null"} ${job.elapsed_sec}s pid=${job.pid ?? "-"}\nlog: ${job.log}\n${indent(job.tail)}`,
				)
				.join("\n\n")
		: "No job in this session.";
	return {
		content: [{ type: "text" as const, text: note ? `${note}\n\n${body}` : body }],
		details: views,
		structuredContent: { jobs: views },
	};
}

/** Job arguments as the renderer sees them. The renderer runs on stored calls. */
type JobCallArgs = { command?: string; name?: string; job_id?: string; wait?: number };

/** The render context fields this extension reads. Pi hands over more of them. */
type JobRenderContext = { durationMs?: number };

/** Flatten and shorten one field for a single transcript line. */
function flat(text: string, max: number): string {
	const one = text.replace(/\s+/g, " ").trim();
	return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** Widest name the table prints before it shortens. */
const NAME_COL = 18;

/** One row, split into the cells the table pads. */
type JobCell = { id: string; name: string; state: string; exit: string; elapsed: string; pid: string };

function cellOf(job: JobView): JobCell {
	return {
		id: job.id,
		name: flat(job.name, NAME_COL),
		state: `[${job.state}]`,
		exit: `exit=${job.exit_code ?? "null"}`,
		elapsed: `${job.elapsed_sec}s`,
		pid: job.pid ? `pid=${job.pid}` : "",
	};
}

/** Column widths from the rows at hand, so a job past j999 does not skew the table. */
function columnWidth(cells: JobCell[]): { id: number; name: number } {
	return {
		id: Math.max(3, ...cells.map((cell) => cell.id.length)),
		name: Math.min(NAME_COL, Math.max(...cells.map((cell) => cell.name.length), 6)),
	};
}

/** Plain aligned row for the widget, where color is not available. */
function plainRow(cell: JobCell, width: { id: number; name: number }): string {
	return `${cell.id.padEnd(width.id)} ${cell.name.padEnd(width.name)} ${cell.state.padEnd(10)} ${cell.exit.padEnd(9)}${cell.elapsed.padStart(6)}${cell.pid ? ` ${cell.pid}` : ""}`;
}

/**
 * Header of the human table. It counts the whole table, not the rows on screen, so
 * `/jobs running` cannot report "1 of 1" while three jobs exist.
 */
function tableHeader(all: JobView[], shown: number): string {
	const running = all.filter((job) => job.state === "running").length;
	const head = `${running} running of ${all.length}`;
	return shown === all.length ? head : `${head}, ${shown} shown`;
}

/** Stop the one-second repaint. Safe to call when none is running. */
function stopTicker(): void {
	if (ticker === null) return;
	clearInterval(ticker);
	ticker = null;
}

/**
 * Keep the ticker matched to the table. It runs only while a table is open and
 * a job is still going, the only rows whose seconds move. An unref'd timer lets
 * the process exit on its own terms.
 */
function syncTicker(running: number): void {
	if (TICK_MS <= 0 || tableMode === null || running === 0) {
		stopTicker();
		return;
	}
	if (ticker !== null) return;
	ticker = setInterval(() => {
		const ctx = seen;
		if (closed || tableMode === null || ctx === null || ctx.mode !== "tui") {
			stopTicker();
			return;
		}
		drawTable(ctx);
	}, TICK_MS);
	ticker.unref?.();
}

/** Footer text for the running count. Short, because every extension shares one line. */
function footerText(running: number): string | undefined {
	if (running === 0) return undefined;
	return `${running} ${running === 1 ? "job" : "jobs"} running`;
}

/** Count and table together. Both answer "what is still going", one line each. */
function drawHud(ctx: ExtensionContext): void {
	if (FOOTER && ctx.mode === "tui") {
		ctx.ui.setStatus("jobs", footerText(list().filter((job) => job.state === "running").length));
	}
	drawTable(ctx);
}

/**
 * Redraw the table above the editor. A table of open work that has no open work
 * left is taken away, not left to rot with finished rows. A table of all jobs
 * stays until a human clears it or asks for another view.
 */
function drawTable(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui" || tableMode === null) return;
	const all = list().map((job) => view(job, 0));
	const shown = tableMode === "running" ? all.filter((job) => job.state === "running") : all;
	if (!shown.length) {
		tableMode = null;
		ctx.ui.setWidget("jobs", undefined);
		syncTicker(0);
		return;
	}
	ctx.ui.setWidget("jobs", tableLines(ctx, all, shown), { placement: "aboveEditor" });
	syncTicker(all.filter((job) => job.state === "running").length);
}

/** Header plus aligned rows. The widget leaves the log path out, plain output keeps it. */
function tableLines(ctx: ExtensionContext, all: JobView[], shown: JobView[]): string[] {
	const cells = shown.map(cellOf);
	const width = columnWidth(cells);
	const head = tableHeader(all, shown.length);
	return ctx.mode === "tui"
		? [head, ...cells.map((cell) => plainRow(cell, width))]
		: [head, ...cells.map((cell, at) => `${plainRow(cell, width)}  ${shown[at]!.log}`)];
}

function stateColor(state: string): ThemeColor {
	if (state === "fail") return "error";
	if (state === "stopped") return "warning";
	if (state === "ok") return "success";
	return "muted";
}

function milliseconds(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Read the fields the renderer draws. Pi hands over the stored arguments of a
 * past call, so their shape is unknown until they land here. */
function callArgs(value: unknown): JobCallArgs {
	const args = (value ?? {}) as Partial<JobCallArgs>;
	return { command: args.command, name: args.name, job_id: args.job_id, wait: args.wait };
}

/** One line that names the call: the tool, its target, and the shortened command. */
function renderCall(toolName: string, args: JobCallArgs, theme: Theme): Text {
	let text = theme.fg("toolTitle", theme.bold(toolName));
	if (toolName === "job_start") {
		const label = args.name?.trim();
		if (label) text += theme.fg("accent", ` ${flat(label, 24)}`);
		if (args.command) text += theme.fg("dim", ` ${flat(args.command, 60)}`);
	} else {
		const target = args.job_id ?? (toolName === "job_status" ? "all" : "?");
		text += theme.fg("accent", ` ${target}`);
		if (typeof args.wait === "number") text += theme.fg("dim", ` wait=${args.wait}s`);
	}
	return new Text(text, 0, 0);
}

/** One line per job. Expanded, the log tail follows. */
function renderJobsResult(
	result: AgentToolResult<JobView[]>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: JobRenderContext,
): Text {
	const shown = result.details ?? [];
	if (shown.length === 0) {
		if (options.isPartial) return new Text(theme.fg("dim", "waiting"), 0, 0);
		return new Text(theme.fg("muted", "no job in this session"), 0, 0);
	}
	const cells = shown.map(cellOf);
	const width = columnWidth(cells);
	const lines = shown.map(
		(_job, at) =>
			theme.fg("toolTitle", cells[at]!.id.padEnd(width.id)) +
			theme.fg("text", ` ${cells[at]!.name.padEnd(width.name)}`) +
			theme.fg(stateColor(cells[at]!.state), ` ${cells[at]!.state.padEnd(10)}`) +
			theme.fg("muted", ` ${cells[at]!.exit.padEnd(9)}${cells[at]!.elapsed.padStart(6)}`) +
			(cells[at]!.pid ? theme.fg("dim", ` ${cells[at]!.pid}`) : ""),
	);
	// The tool duration is the useful number here: it is how long a `wait` blocked.
	if (typeof context.durationMs === "number") lines.push(theme.fg("dim", `tool ${milliseconds(context.durationMs)}`));
	if (options.expanded) {
		for (const job of shown) {
			if (!job.tail) continue;
			lines.push(theme.fg("dim", `  ${job.log}`));
			for (const part of job.tail.split("\n")) lines.push(theme.fg("toolOutput", `  ${part}`));
		}
	}
	return new Text(lines.join("\n"), 0, 0);
}

const jobStart = defineTool({
	name: "job_start",
	label: "Start job",
	description:
		"Background job: run a shell command now and return its id at once. Use it when the work outlives the current step, so the step keeps moving. A new turn arrives when the command exits. Use bash when the next step needs the output.",
	promptSnippet: "Run a shell command as a background job, wake on exit",
	promptGuidelines: [
		"Give each job a short name. The wake-up and /jobs show that name.",
		"Read the whole log with the read tool. A wake-up carries only a tail.",
	],
	parameters: Type.Object({
		command: Type.String({ description: "Shell command to run in the background" }),
		name: Type.Optional(Type.String({ description: "Short label shown in the wake-up and /jobs" })),
		cwd: Type.Optional(Type.String({ description: "Absolute working directory. Defaults to the session directory" })),
	}),
	namespace: {
		name: "jobs",
		description: "Background shell jobs that wake the agent when they exit.",
		instructions: [
			"A job is one command, one log file, one exit code.",
			"A job ends when the process exits, when job_stop signals it, or when the session shuts down. A reload stops every job.",
			"A job stopped with job_stop reports its result in that call and opens no wake-up turn.",
			"An exit adds one message with the state and a log tail. Several exits inside the debounce window share one message and one turn.",
			"Print and JSON modes receive no wake-up message. There, pass wait to job_status to collect a result.",
			"A watch process that never exits produces no wake-up. Stop it with job_stop.",
		].join("\n"),
	},
	annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
	outputSchema,
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		seen = ctx;
		const job = startJob(params, ctx);
		drawHud(ctx);
		return report([job], `Started job ${job.id} (${job.name}). pid ${job.pid}. Log ${job.logPath}.`);
	},
});

const jobStatus = defineTool({
	name: "job_status",
	label: "Job status",
	description:
		"Report background jobs: state, exit code, elapsed seconds, log tail. Pass wait to block until one job ends. Use it when this turn needs the result or when a wake-up may have been missed.",
	promptSnippet: "Report background jobs, optionally blocking until one ends",
	promptGuidelines: ["Pass one job id with wait when this turn needs that job's result."],
	parameters: Type.Object({
		job_id: Type.Optional(Type.String({ description: "One job id. Omit to list every job in this session" })),
		tail_bytes: Type.Optional(Type.Number({ description: `Log bytes to include. 0 drops the log. Default ${TAIL_BYTES}` })),
		wait: Type.Optional(
		Type.Number({
			description: `Seconds to wait for a running job to end. Max ${WAIT_MAX_S}. A wait that ends with the exit also cancels the wake-up for that job.`,
		}),
	),
	}),
	annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	outputSchema,
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		seen = ctx;
		const one = params.job_id ? pickOne(params.job_id) : undefined;
		const target = one ? [one] : list();
		const running = target.filter((job) => job.state === "running");
		let note: string | undefined;
		if (params.wait && one && running.length === 1) {
			const limit = Math.min(Math.max(params.wait, 0), WAIT_MAX_S);
			const settled = await waitUntil(one, limit);
			// The result is in this tool output, so the wake-up for this job would
			// open a second turn for news the model already holds.
			if (settled) collect(one);
			note = settled ? `Job ${one.id} ended while waiting.` : `Still running after ${limit}s.`;
		} else if (running.length) {
			note = `${running.length} job(s) still running. Pass one job_id with wait to block.`;
		}
		return report(target, note, params.tail_bytes ?? TAIL_BYTES);
	},
});

const jobStop = defineTool({
	name: "job_stop",
	label: "Stop job",
	description: "Stop one background job and the commands it started. Report the exit code it ended with.",
	promptSnippet: "Stop a background job and its children",
	parameters: Type.Object({ job_id: Type.String({ description: "Job id from job_start" }) }),
	annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
	outputSchema,
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		seen = ctx;
		const job = pickOne(params.job_id);
		if (job.state !== "running") return report([job], `Job ${job.id} already ended with state ${job.state}.`);
		job.stopRequested = true;
		signalJob(job, "SIGTERM");
		const hardStop = setTimeout(() => {
			if (job.state === "running") signalJob(job, "SIGKILL");
		}, 2000);
		hardStop.unref?.();
		const settled = await waitUntil(job, 10);
		return report([job], settled ? `Stopped job ${job.id}.` : `Job ${job.id} did not exit within 10s.`);
	},
});

export default function (pi: ExtensionAPI) {
	api = pi;

	pi.registerTool(jobStart);
	pi.registerTool(jobStatus);
	pi.registerTool(jobStop);

	// One resolver for the family. The default shell draws the row and its
	// padding, so these two functions only supply the text.
	pi.registerToolRenderer((toolName, next) => {
		if (toolName !== "job_start" && toolName !== "job_status" && toolName !== "job_stop") return next();
		return {
			renderCall: (args: unknown, theme: Theme) => renderCall(toolName, callArgs(args), theme),
			renderResult: renderJobsResult,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		seen = ctx;
		closed = false;
		held = false;
		pendingRelease = false;
		batchWaited = false;
		seedSeq();
		pruneLogs();
		tableMode = null;
		drawHud(ctx);
	});

	// A cancelled run holds the wake-ups. A settle that was not a cancellation
	// ends the hold that a human message armed, then delivers what waited.
	pi.on("agent_settled", async (event) => {
		if (event.aborted) {
			held = true;
			return;
		}
		if (pendingRelease) {
			held = false;
			pendingRelease = false;
		}
		arm();
	});

	// Only input the human sent arms the release. A wake-up this extension sent
	// itself carries source "extension" and must not lift its own hold.
	pi.on("input", async (event) => {
		if (event.source === "interactive" || event.source === "rpc") pendingRelease = true;
	});

	pi.on("agent_start", async (_event, ctx) => {
		seen = ctx;
	});

	pi.on("turn_end", async (_event, ctx) => {
		seen = ctx;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		closed = true;
		stopTicker();
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		pending = [];
		for (const list of waiters.values()) for (const callback of list) callback();
		waiters.clear();
		const running = [...jobs.values()].filter((job) => job.state === "running");
		for (const job of running) {
			job.stopRequested = true;
			signalJob(job, "SIGTERM");
		}
		// Let a job that cleans up on the signal finish the cleanup. Watch every
		// 50 ms, so a job that ends at once does not pay for the whole grace.
		const ceiling = Date.now() + STOP_GRACE_MS;
		while (Date.now() < ceiling && running.some((job) => job.state === "running")) {
			await sleep(50);
		}
		for (const job of running) {
			if (job.state === "running") signalJob(job, "SIGKILL");
		}
		jobs.clear();
		seen = null;
		api = null;
		held = false;
		pendingRelease = false;
		batchWaited = false;
		if (running.length && ctx.hasUI) {
			ctx.ui.notify(`jobs: stopped ${running.length} background job(s)`, "info");
		}
	});

	pi.registerCommand("jobs", {
		description: "Open background jobs above the editor. `all` adds finished ones, `clear` hides the table",
		handler: async (args, ctx) => {
			seen = ctx;
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "clear") {
				tableMode = null;
				stopTicker();
				ctx.ui.setWidget("jobs", undefined);
				return;
			}
			tableMode = arg === "all" ? "all" : "running";
			const all = list().map((job) => view(job, 0));
			const shown = tableMode === "all" ? all : all.filter((job) => job.state === "running");
			if (!shown.length) {
				const hint = tableMode === "all"
					? "No job in this session."
					: "No job is running. `jobs all` lists the finished ones.";
				if (ctx.mode === "tui") {
					tableMode = null;
					stopTicker();
					ctx.ui.setWidget("jobs", undefined);
					ctx.ui.notify(hint, "info");
				} else {
					ctx.ui.notify(hint, "info");
				}
				return;
			}
			if (ctx.mode === "tui") drawTable(ctx);
			else ctx.ui.notify(tableLines(ctx, all, shown).join("\n"), "info");
		},
	});

}
