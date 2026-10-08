/**
 * End-to-end check of the jobs extension against a real model.
 *
 * Costs tokens. Run it after a change to jobs.ts.
 *
 * The script starts one pi agent over RPC. The model starts a job, the first
 * run settles, the job exit opens a new turn, and the model reads the log path
 * from that wake-up. Each step must happen in that order.
 *
 * A provider that answers nothing is not an extension failure. When a run ends
 * with no tool call and an empty reply, the script starts a fresh agent once
 * more. If both runs come back empty, it reports a provider failure and exits 2,
 * so a dead model server does not look like four failed checks.
 *
 * Two scenarios, chosen by the environment.
 *
 *   wake (default)  the job outlives the run, so its exit must open a new turn.
 *   wait            the model collects the exit inside the run with the `wait`
 *                   parameter, so no turn may open afterwards.
 *
 * Checks for wake:
 *   1. the model called job_start
 *   2. the first run settled while the job still ran
 *   3. the job exit opened a new run that settled
 *   4. the model read the log path that the wake-up named
 *
 * Checks for wait:
 *   1. the model called job_start and job_status
 *   2. the run settled after the job exited, so the tool output carried the exit
 *   3. no second run opened after that settle
 *   4. the reply names the state the model read
 *
 * Run: bun run jobs-rpc.ts
 *      JOBS_RPC_SCENARIO=wait bun run jobs-rpc.ts
 * The extension comes from this directory. PI_JOBS_EXTENSION points it at another
 * checkout.
 * Exit code: 0 pass, 1 extension failure, 2 provider failure.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The extension under test sits beside this file in any install layout. Set
// PI_JOBS_EXTENSION to point the harness at another checkout.
const EXTENSION = process.env.PI_JOBS_EXTENSION ?? join(import.meta.dir, "jobs.ts");

const DEADLINE_MS = 240_000;
const MAX_ATTEMPTS = 2;
// After a settle, time to watch for a turn that must not open.
const QUIET_WATCH_MS = 8_000;

const SCENARIO = process.env.JOBS_RPC_SCENARIO === "wait" ? "wait" : "wake";
const JOB_COMMAND = SCENARIO === "wait" ? "sleep 6; echo WAIT_MARKER" : "sleep 45; echo WAKE_MARKER";
const PROMPT =
	SCENARIO === "wait"
		? "call job_start with command: " + JOB_COMMAND + "\n" +
			"then call job_status with that job id and wait 20.\n" +
			"reply with the state and the exit code you saw, and nothing else."
		: "call job_start with command: " + JOB_COMMAND + "\n" +
			"reply with STARTED and nothing else. do not wait for the job.\n" +
			"when a message about a finished job arrives, call read on the log path from that message. reply with READ.";

class Log {
	lines: string[] = [];
	t0 = Date.now();

	get ms(): number {
		return Date.now() - this.t0;
	}

	at(ms: number): string {
		return String(ms).padStart(7, " ");
	}

	note(text: string, at?: number): void {
		this.lines.push(`${this.at(at ?? this.ms)}ms ${text}`);
		console.log(this.lines[this.lines.length - 1]);
	}
}

interface Attempt {
	index: number;
	log: Log;
	jobStartMs: number;
	settledMs: number;
	wakeRunMs: number | undefined;
	wakeSettledMs: number | undefined;
	/** Every agent_settled time, relative to the run clock. */
	settles: number[];
	reads: string[];
	reply: string;
	retried: number;
	starts: number[];
	jobLogPath: string;
	toolCalls: string[];
}

function pathOf(args: unknown): string | undefined {
	const candidate = args as { path?: unknown } | undefined;
	return typeof candidate?.path === "string" ? candidate.path : undefined;
}

async function wait(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runAttempt(index: number, log: Log): Promise<Attempt> {
	const dir = mkdtempSync(join(tmpdir(), "jobs-rpc-"));
	const child: ChildProcess = spawn(
		"pi",
		[
			"--mode", "rpc",
			"--no-session",
			// Load only the extension named below. Discovery would also pick up a
			// copy under ~/.pi/agent/extensions, and two copies cannot register the
			// same tool names.
			"--no-extensions",
			"--extension", EXTENSION,
			"--tools", "read,job_start,job_status",
			"--approve",
		],
		{ stdio: ["pipe", "pipe", "pipe"], cwd: dir },
	);

	let buffer = "";
	const starts: number[] = [];
	const settles: number[] = [];
	const jobStarts: number[] = [];
	const toolCalls: string[] = [];
	const reads: string[] = [];
	const retried: number[] = [];
	let texts: string[] = [];
	let failed = "";
	let jobLogPath = "";

	// A JSON record can span several stdout chunks. Keep the tail of each chunk
	// and parse only whole lines.
	const feed = (chunk: Buffer | string): void => {
		buffer += chunk.toString();
		for (;;) {
			const end = buffer.indexOf("\n");
			if (end < 0) return;
			const line = buffer.slice(0, end).trim();
			buffer = buffer.slice(end + 1);
			if (!line) continue;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				log.note(`stdout raw ${line.slice(0, 100)}`);
				continue;
			}
			const at = log.ms;
			if (event.type === "agent_start") {
				starts.push(at);
				texts = [];
				log.note(`agent_start #${starts.length}`);
			} else if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
				texts.push(event.assistantMessageEvent.delta ?? "");
			} else if (event.type === "tool_execution_start") {
				toolCalls.push(event.toolName);
				if (event.toolName === "job_start") {
					jobStarts.push(at);
					log.note(`tool job_start ${JSON.stringify(event.args ?? {}).slice(0, 90)}`);
				} else if (event.toolName === "read") {
					const path = pathOf(event.args);
					reads.push(path ?? "(no path)");
					log.note(`read ${path ?? "(no path)"}`);
				} else {
					log.note(`tool ${event.toolName}`);
				}
			} else if (event.type === "tool_execution_end") {
				// The tool result text names the log path.
				if (event.toolName === "job_start" && !jobLogPath) {
					const structured = event.result?.structuredContent?.log;
					const text = typeof event.result?.content?.[0]?.text === "string"
						? event.result.content[0].text
						: JSON.stringify(event.result ?? "");
					const match = text.match(/\/[^\s"]+\.log/);
					jobLogPath = typeof structured === "string" ? structured : (match?.[0] ?? "");
					if (jobLogPath) log.note(`job log ${jobLogPath}`);
				}
			} else if (event.type === "entry_appended") {
				// The extension writes its own record. Its log path is the trusted one.
				const data = event.entry?.customType === "jobs" ? event.entry.data : undefined;
				if (data?.log && !jobLogPath) {
					jobLogPath = String(data.log);
					log.note(`job record ${jobLogPath} state=${data.state}`);
				}
			} else if (event.type === "auto_retry_end") {
				retried.push(at);
			} else if (event.type === "auto_retry_start") {
				log.note(`host auto_retry #${event.attempt ?? ""}`);
			} else if (event.type === "agent_settled") {
				settles.push(at);
				log.note(`agent_settled #${settles.length}`);
			} else if (event.type === "extension_error") {
				failed = `extension_error ${JSON.stringify(event.error ?? event)}`.slice(0, 300);
				log.note(failed);
			} else if (event.type === "tool_execution_error") {
				failed = `tool_execution_error ${event.toolName} ${JSON.stringify(event.error ?? event)}`.slice(0, 300);
				log.note(failed);
			} else if (event.type === "error") {
				failed = `error ${JSON.stringify(event)}`.slice(0, 300);
				log.note(failed);
			}
		}
	};

	child.stdout!.on("data", feed);
	child.stderr!.on("data", (chunk: Buffer) => {
		const text = chunk.toString().trim();
		if (text) log.note(`stderr ${text.slice(0, 200)}`);
	});
	child.on("exit", (code, signal) => log.note(`child exit code=${code} signal=${signal}`));

	await wait(300);
	child.stdin!.write(JSON.stringify({ type: "prompt", message: PROMPT }) + "\n");
	log.note("prompt sent");

	// Event times are relative to the Log clock. Measure the run from this mark,
	// so every duration below stays on one clock.
	const base = log.ms;
	const deadline = Date.now() + DEADLINE_MS;
	while (settles.length < 1 && Date.now() < deadline) await wait(200);
	if (settles.length < 1) {
		throw new Error(`first run did not settle within ${DEADLINE_MS}ms:\n${log.lines.slice(-20).join("\n")}`);
	}
	const settledMs = settles[0]! - base;

	let wakeRunMs: number | undefined;
	let wakeSettledMs: number | undefined;
	if (SCENARIO === "wait") {
		// The exit belongs to this run. Watch for a turn that must never start.
		await wait(QUIET_WATCH_MS);
		log.note(`quiet watch over: runs=${starts.length} settles=${settles.length}`);
	} else if (jobStarts.length > 0) {
		const startDeadline = Date.now() + DEADLINE_MS;
		while (Date.now() < startDeadline) {
			const wake = starts.find((at) => at > base + settledMs + 500);
			if (wake !== undefined) {
				wakeRunMs = wake - base;
				log.note(`wake run opened at ${wakeRunMs}ms`);
				break;
			}
			await wait(100);
		}
		if (wakeRunMs === undefined) {
			throw new Error(`job exit opened no new run within ${DEADLINE_MS}ms:\n${log.lines.slice(-20).join("\n")}`);
		}
		while (settles.length < 2 && Date.now() < startDeadline) await wait(100);
		if (settles.length < 2) {
			throw new Error(`wake run did not settle within ${DEADLINE_MS}ms:\n${log.lines.slice(-20).join("\n")}`);
		}
		wakeSettledMs = settles[1]! - base;
	}

	const reply = texts.join("");
	const attempt: Attempt = {
		index,
		log,
		jobStartMs: jobStarts.length ? jobStarts[0]! - base : 0,
		settledMs,
		wakeRunMs,
		wakeSettledMs,
		settles,
		reads,
		reply,
		retried: retried.length,
		starts,
		jobLogPath,
		toolCalls,
	};

	if (!failed) {
		child.stdin!.write(JSON.stringify({ type: "abort" }) + "\n");
		await wait(250);
	}
	if (child.exitCode === null) {
		child.stdin!.end();
		child.kill("SIGTERM");
	}
	return attempt;
}

function providerSuspect(attempt: Attempt): boolean {
	return attempt.toolCalls.length === 0 && (attempt.reply.trim() === "" || attempt.retried > 0);
}

function summarize(attempt: Attempt): string {
	return `attempt ${attempt.index}: tools=${attempt.toolCalls.length ? attempt.toolCalls.join(",") : "none"} reply=${JSON.stringify(attempt.reply.slice(0, 60))} retries=${attempt.retried}`;
}

async function main(): Promise<number> {
	const log = new Log();
	let last: Attempt | undefined;

	for (let index = 1; index <= MAX_ATTEMPTS; index++) {
		try {
			last = await runAttempt(index, log);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			console.log(reason);
			console.log(`\njobs-rpc ${SCENARIO}: provider failure (run did not complete)`);
			return 2;
		}
		console.log(summarize(last));
		if (!providerSuspect(last)) break;
		if (index < MAX_ATTEMPTS) log.note("empty reply, retrying with a fresh agent");
	}

	if (!last) {
		console.log(`jobs-rpc ${SCENARIO}: no attempt ran`);
		return 2;
	}

	const jobLogPath = last.jobLogPath;

	const checks: Array<[boolean, string]> =
		SCENARIO === "wait"
			? [
				[
					last.jobStartMs > 0 && last.toolCalls.includes("job_status"),
					`the model started the job and waited for it :: tools=${last.toolCalls.join(",")}`,
				],
				[
					last.settles.length === 1 && last.settledMs > 6_000,
					`one run settled, after the job exited inside it :: settles=${last.settles.length} settled=${last.settledMs}ms`,
				],
				[
					last.starts.length === 1,
					`no second run opened after that settle :: runs=${last.starts.length} watched=${QUIET_WATCH_MS}ms`,
				],
				[
					/ok|exit=0/.test(last.reply),
					`the reply carries the exit the tool output held :: reply=${JSON.stringify(last.reply.slice(0, 60))}`,
				],
			]
			: [
				[last.jobStartMs > 0, `the model called job_start`],
				[
					last.settledMs > 0 && last.jobStartMs > 0 && (!last.wakeRunMs || last.settledMs < last.wakeRunMs),
					`the first run settled while the job still ran :: settles=${last.settledMs}ms job_start=${last.jobStartMs}ms`,
				],
				[
					last.wakeRunMs !== undefined && last.wakeSettledMs !== undefined && last.wakeSettledMs > last.wakeRunMs,
					`the job exit opened a new run that settled :: wake_run=${last.wakeRunMs} wake_settled=${last.wakeSettledMs}`,
				],
				[
					jobLogPath !== "" && last.reads.includes(jobLogPath),
					`the model read the log the job wrote :: reads=${JSON.stringify(last.reads)}`,
				],
			];

	for (const [passed, text] of checks) {
		console.log(`\n  ${passed ? "ok  " : "FAIL"} ${text}`);
	}
	console.log("");

	if (providerSuspect(last)) {
		console.log(`jobs-rpc ${SCENARIO}: provider failure (empty reply after two agents)`);
		return 2;
	}
	const failures = checks.filter(([passed]) => !passed).length;
	console.log(`jobs-rpc ${SCENARIO}: ${failures === 0 ? "pass" : `${failures} failure(s)`}`);
	return failures === 0 ? 0 : 1;
}

process.exit(await main());
