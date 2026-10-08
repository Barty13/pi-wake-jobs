/**
 * jobs tests.
 *
 * Run: bun test ~/.pi/agent/extensions/jobs/jobs.test.ts
 *
 * Why this file sits in the extension directory. Pi loads one entry per
 * directory: package.json names "jobs.ts", so a sibling here stays private and
 * is never loaded as an extension. A *.ts file placed directly in
 * ~/.pi/agent/extensions would be loaded. Keep the tests inside this directory.
 *
 * Seam: the host surface the extension registers. Every case drives that surface
 * through JobsHost and reads what the host received: the tool result, the
 * message that opens a turn, the durable entry, the widget text. No test reads
 * a variable inside the extension.
 *
 * The behaviour under test is the wake-up: a job exits, and the extension opens
 * one turn for a batch of exits. Order matters. The suite runs top to bottom on
 * one loaded extension, because a job table is per runtime. Each test drains
 * its own wake-ups with host.quiet(), so it cannot add a job to the debounce
 * window of the next test. The last case shuts the runtime down, so nothing may
 * follow it.
 *
 * The end-to-end case with a real model and a real turn lives in jobs-rpc.ts.
 * It costs tokens and takes about a minute, so it stays out of this file.
 *
 * Three cases end a runtime. Each one that is not last opens the runtime again
 * with session_start, so a shutdown never leaks into the next case.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JobsHost, plainTheme } from "./host.ts";

// Set the knobs before the extension loads. It reads them once, at module load.
const LOG_DIR = `/tmp/pi-jobs-test-${process.pid}`;
process.env.PI_JOBS_DIR = LOG_DIR;
process.env.PI_JOBS_DEBOUNCE_MS = "250";
process.env.PI_JOBS_TAIL_BYTES = "600";
// A small ceiling makes the clamp observable in a test.
process.env.PI_JOBS_WAIT_MAX_S = "1";

const { default: jobsExtension } = await import("./jobs.ts");

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const host = new JobsHost();
jobsExtension(host.api);

/** Processes alive in the process group a job leads. */
function groupMembers(pid: number): string[] {
	const result = Bun.spawnSync(["pgrep", "-g", String(pid)]);
	return result.stdout
		.toString()
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

/** Text a job log holds at this moment. */
function tailOf(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

function alive(pid: number): boolean {
	return Bun.spawnSync(["ps", "-p", String(pid)]).stdout.toString().trim().split("\n").length > 1;
}

describe("registration", () => {
	test("three tools and one command", () => {
		expect([...host.tools.keys()]).toEqual(["job_start", "job_status", "job_stop"]);
		expect(host.commands.has("jobs")).toBe(true);
	});

	test("the family carries the long rules, not the declarations", () => {
		const family = host.tools.get("job_start")!.namespace!;
		expect(family.name).toBe("jobs");
		expect(family.instructions!.split("\n").length).toBeGreaterThanOrEqual(4);
		expect(host.tools.get("job_start")!.promptGuidelines!.length).toBeLessThanOrEqual(2);
	});

	test("results carry structured content for scripts", () => {
		expect(host.tools.get("job_start")!.outputSchema).toBeDefined();
		expect(host.tools.get("job_status")!.outputSchema).toBeDefined();
	});

	test("nothing spawns before the first call", () => {
		expect(existsSync(LOG_DIR)).toBe(false);
		expect(host.messages.length).toBe(0);
	});
});

describe("job_start", () => {
	test("returns while the command still runs", async () => {
		await host.emit("session_start", { reason: "startup" });
		const result = await host.call("job_start", { command: "echo starting; sleep 1; echo finished", name: "sleeper" });
		const job = result.structuredContent.jobs[0]!;
		expect(job.state).toBe("running");
		expect(job.name).toBe("sleeper");
		expect(job.log.startsWith(LOG_DIR)).toBe(true);
		expect(existsSync(job.log)).toBe(true);
		expect(host.messages.length).toBe(0);
		expect(host.entries.at(-1)!.data.state).toBe("running");
	});

	test("the exit opens one turn that names the job and the result", async () => {
		await sleep(1900);
		expect(host.messages.length).toBe(1);
		const message = host.messages[0]!;
		expect(message.text).toContain("sleeper");
		expect(message.text).toContain("exit code 0");
		expect(message.text).toContain("finished");
		expect(message.text).toContain("Read each log");
		expect(message.options).toBeUndefined();
		expect(host.entries.at(-1)!.data.state).toBe("ok");
	});
});

describe("a long log reaches the model as its tail", () => {
	test("the tail ends on the last line and says what it dropped", async () => {
		const started = await host.call("job_start", {
			command: "seq 1 400 | sed 's/^/pad-line-aaaa-/'; echo SENTINEL_AT_END",
			name: "longlog",
		});
		const id = started.structuredContent.jobs[0]!.id;
		const done = await host.call("job_status", { job_id: id, wait: 10, tail_bytes: 300 });
		const log = done.structuredContent.jobs[0]!.tail as string;
		expect(log.endsWith("SENTINEL_AT_END")).toBe(true);
		expect(log).toMatch(/^\.\.\. \d+ bytes above \.\.\.\n/);
		expect(log.length).toBeLessThanOrEqual(340);
		expect(JobsHost.text(done)).toContain("bytes above");
		await host.quiet();
	});
});

describe("cwd of a job", () => {
	test("an absolute cwd runs the command there", async () => {
		const started = await host.call("job_start", { command: "pwd", cwd: "/usr", name: "abs-cwd" });
		const id = started.structuredContent.jobs[0]!.id;
		await host.call("job_status", { job_id: id, wait: 5 });
		expect((await host.call("job_status", { job_id: id })).structuredContent.jobs[0]!.tail).toBe("/usr");
		await host.quiet();
	});

	test("a relative cwd falls back to the session directory", async () => {
		const started = await host.call("job_start", { command: "pwd", cwd: "relative/path", name: "rel-cwd" });
		const id = started.structuredContent.jobs[0]!.id;
		await host.call("job_status", { job_id: id, wait: 5 });
		const log = (await host.call("job_status", { job_id: id })).structuredContent.jobs[0]!.tail;
		expect(log).toBe(realpathSync(host.cwd));
		await host.quiet();
	});
});

describe("one turn per batch", () => {
	test("three exits inside the window share one message", async () => {
		host.messages.length = 0;
		await host.call("job_start", { command: "echo a", name: "c1" });
		await host.call("job_start", { command: "echo b", name: "c2" });
		await host.call("job_start", { command: "exit 3", name: "c3" });
		await sleep(1200);
		expect(host.messages.length).toBe(1);
		expect(host.messages[0]!.text).toContain("3 background jobs finished in one batch");
		expect(host.messages[0]!.text).toContain("exit code 3");
		expect(host.messages[0]!.text).toContain("c1");
	});
});

describe("delivery follows the run state", () => {
	test("a streaming agent gets a follow-up", async () => {
		host.messages.length = 0;
		host.setIdle(false);
		await host.call("job_start", { command: "echo busy", name: "busy" });
		await sleep(1200);
		expect(host.messages.length).toBe(1);
		expect(host.messages[0]!.options).toEqual({ deliverAs: "followUp" });
		host.setIdle(true);
	});

	test("print mode opens no turn", async () => {
		host.messages.length = 0;
		host.setMode("print");
		await host.call("job_start", { command: "echo printed", name: "printed" });
		await sleep(1200);
		expect(host.messages.length).toBe(0);
		host.setMode("tui");
	});
});

describe("job_status", () => {
	test("lists the session", async () => {
		const listed = await host.call("job_status", {});
		expect(listed.structuredContent.jobs.length).toBeGreaterThanOrEqual(3);
	});

	test("waits for one job and says so", async () => {
		const started = await host.call("job_start", { command: "sleep 0.3; echo waited", name: "waiter" });
		const id = started.structuredContent.jobs[0]!.id;
		const waited = await host.call("job_status", { job_id: id, wait: 15 });
		expect(waited.structuredContent.jobs[0]!.state).not.toBe("running");
		expect(JobsHost.text(waited)).toContain("ended while waiting");
	});

	test("a wait that runs out reports the open job", async () => {
		const started = await host.call("job_start", { command: "sleep 30", name: "open" });
		const id = started.structuredContent.jobs[0]!.id;
		const short = await host.call("job_status", { job_id: id, wait: 1 });
		expect(JobsHost.text(short)).toContain("Still running after 1s");
		expect(short.structuredContent.jobs[0]!.state).toBe("running");
		await host.call("job_stop", { job_id: id });
	});

	test("a wait above the ceiling names the time it really waited", async () => {
		const started = await host.call("job_start", { command: "sleep 30", name: "over-wait" });
		const id = started.structuredContent.jobs[0]!.id;
		const t0 = Date.now();
		const result = await host.call("job_status", { job_id: id, wait: 600 });
		expect(Date.now() - t0).toBeLessThan(5000);
		const text = JobsHost.text(result);
		expect(text).toContain("Still running after 1s");
		expect(text).not.toContain("600s");
		await host.call("job_stop", { job_id: id });
	});

	test("tail_bytes 0 drops the log body", async () => {
		const listed = await host.call("job_status", { tail_bytes: 0 });
		for (const job of listed.structuredContent.jobs) expect(job.tail).toBe("");
	});

	test("an unknown id fails the call", async () => {
		expect(host.call("job_status", { job_id: "j9999" })).rejects.toThrow(/No job with id j9999/);
	});
});

describe("the /jobs command", () => {
	test("draws the table above the editor", async () => {
		await host.runCommand("jobs");
		const lines = host.widgets.get("jobs")!;
		expect(lines.length).toBeGreaterThanOrEqual(3);
		expect(lines[0]).toMatch(/^j\d+ \S+ \[(running|ok|fail|stopped)\] exit=/);
	});

	test("the running filter shortens it", async () => {
		const started = await host.call("job_start", { command: "sleep 20", name: "live" });
		const liveId = started.structuredContent.jobs[0]!.id;
		await host.runCommand("jobs", "running");
		const lines = host.widgets.get("jobs")!;
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain("[running]");
		await host.runCommand("jobs");
		expect(host.widgets.get("jobs")!.length).toBeGreaterThan(1);
		// Drain the job here. Its exit must not land in a later test.
		await host.call("job_stop", { job_id: liveId });
		await host.quiet(300);
	});
});

describe("the job table stays bounded", () => {
	test("finished jobs leave first, a running job stays", async () => {
		const live = await host.call("job_start", { command: "sleep 30", name: "keep-me" });
		const liveId = live.structuredContent.jobs[0]!.id;
		const filled: string[] = [];
		for (let batch = 0; batch < 3; batch++) {
			for (let i = 0; i < 20; i++) {
				const started = await host.call("job_start", { command: "echo x", name: `fill-${batch}-${i}` });
				filled.push(started.structuredContent.jobs[0]!.id);
			}
			// Let the batch end. Only a finished job can leave the table.
			await sleep(350);
		}
		const listed = (await host.call("job_status", {})).structuredContent.jobs;
		expect(listed.length).toBeLessThan(filled.length + 1);
		expect(listed.some((job) => job.id === liveId)).toBe(true);
		expect(listed.some((job) => job.id === filled[0])).toBe(false);
		await host.call("job_stop", { job_id: liveId });
		await host.quiet(400);
	});
});

describe("job_stop", () => {
	test("reaches the children the job started", async () => {
		const started = await host.call("job_start", { command: "sleep 120 & sleep 121 & wait", name: "group" });
		const job = started.structuredContent.jobs[0]!;
		await sleep(400);
		expect(groupMembers(job.pid).length).toBeGreaterThan(1);
		const stopped = await host.call("job_stop", { job_id: job.id });
		await sleep(400);
		expect(stopped.structuredContent.jobs[0]!.state).toBe("stopped");
		expect(groupMembers(job.pid).length).toBe(0);
	});

	test("a job that ignores SIGTERM still ends", async () => {
		const started = await host.call("job_start", { command: "trap '' TERM; sleep 60", name: "stubborn" });
		const job = started.structuredContent.jobs[0]!;
		await sleep(400);
		const t0 = Date.now();
		const stopped = await host.call("job_stop", { job_id: job.id });
		expect(Date.now() - t0).toBeLessThan(4000);
		const ended = stopped.structuredContent.jobs[0]!;
		expect(ended.state).toBe("stopped");
		expect(ended.signal).toBe("SIGKILL");
		await sleep(400);
		expect(groupMembers(job.pid!)).toEqual([]);
	});

	test("a second stop reports the state it found", async () => {
		const started = await host.call("job_start", { command: "sleep 40", name: "stop-twice" });
		const id = started.structuredContent.jobs[0]!.id;
		await host.call("job_stop", { job_id: id });
		const again = await host.call("job_stop", { job_id: id });
		expect(JobsHost.text(again)).toContain("already ended");
	});

	test("a stop the agent asked for opens no second turn", async () => {
		const started = await host.call("job_start", { command: "sleep 40", name: "self-stop" });
		const id = started.structuredContent.jobs[0]!.id;
		// Let any wake-up from an earlier stop land first.
		await sleep(400);
		host.messages.length = 0;
		const stopped = await host.call("job_stop", { job_id: id });
		expect(JobsHost.text(stopped)).toContain("Stopped job");
		expect(stopped.structuredContent.jobs[0]!.state).toBe("stopped");
		await sleep(1000);
		expect(host.messages).toEqual([]);
		expect(host.statesOf("stopped").some((entry) => entry.data.id === id)).toBe(true);
	});
});

describe("a wait that ends the job cancels the wake-up", () => {
	// The result of a waited job already sits in the tool output. A wake-up there
	// opens a second turn for news the model holds. Measured in one session:
	// four jobs, four results collected with wait, four turns that added nothing.
	test("the waited job opens no turn", async () => {
		await host.quiet();
		const started = await host.call("job_start", { command: "sleep 0.3; echo collected", name: "collected" });
		const id = started.structuredContent.jobs[0]!.id;
		const waited = await host.call("job_status", { job_id: id, wait: 15 });
		expect(JobsHost.text(waited)).toContain("ended while waiting");
		await sleep(700);
		expect(host.messages).toEqual([]);
		// The job stays a job: the durable entry is still written.
		expect(host.statesOf("ok").some((entry) => entry.data.id === id)).toBe(true);
	});

	test("a sibling nobody waited for still wakes", async () => {
		await host.quiet();
		const first = await host.call("job_start", { command: "sleep 0.3; echo sibling-a", name: "waited-a" });
		const idA = first.structuredContent.jobs[0]!.id;
		await host.call("job_status", { job_id: idA, wait: 15 });
		const second = await host.call("job_start", { command: "echo sibling-b", name: "unwaited-b" });
		const idB = second.structuredContent.jobs[0]!.id;
		await sleep(700);
		expect(host.messages.length).toBe(1);
		expect(host.messages[0]!.text).toContain("unwaited-b");
		expect(host.messages[0]!.text).toContain(idB);
		expect(host.messages[0]!.text).not.toContain("waited-a");
		await host.quiet();
	});

	test("a waited job leaves nothing for the hold to deliver", async () => {
		await host.quiet();
		await host.emit("agent_settled", { aborted: true });
		const started = await host.call("job_start", { command: "sleep 0.3; echo held-and-waited", name: "held-waited" });
		const id = started.structuredContent.jobs[0]!.id;
		await host.call("job_status", { job_id: id, wait: 15 });
		await host.emit("input", { text: "continue", source: "interactive" });
		await host.emit("agent_settled", { aborted: false });
		await sleep(700);
		// Nothing was held back, so the release delivers nothing.
		expect(host.messages).toEqual([]);

		// The empty batch must also clear the note about the cancelled run, or the
		// next wake-up would claim it waited through that hold.
		await host.call("job_start", { command: "echo after-hold", name: "after-hold" });
		await sleep(700);
		expect(host.messages.length).toBe(1);
		expect(host.messages[0]!.text).toContain("after-hold");
		expect(host.messages[0]!.text).not.toContain("while the run was cancelled");
		await host.quiet();
	});
});

describe("a cancelled run holds the wake-up", () => {
	test("Escape holds it, the next run you start delivers it", async () => {
		host.messages.length = 0;
		await host.emit("agent_settled", { aborted: true });
		await host.call("job_start", { command: "echo held", name: "held" });
		await sleep(900);
		// The exit is recorded, but no turn opens after a run the user stopped.
		expect(host.messages).toEqual([]);
		expect(host.statesOf("ok").some((entry) => entry.data.name === "held")).toBe(true);

		await host.emit("input", { text: "continue", source: "interactive" });
		await sleep(600);
		expect(host.messages).toEqual([]);

		// The run that message started has now settled. The batch lands after it.
		await host.emit("agent_settled", { aborted: false });
		await sleep(600);
		expect(host.messages.length).toBe(1);
		expect(host.messages[0]!.text).toContain("held");
		expect(host.messages[0]!.text).toContain("while the run was cancelled");
		host.messages.length = 0;
	});

	test("a message from an extension does not release the hold", async () => {
		host.messages.length = 0;
		await host.emit("agent_settled", { aborted: true });
		await host.call("job_start", { command: "echo held2", name: "held2" });
		await sleep(900);
		await host.emit("input", { text: "wake", source: "extension" });
		await host.emit("agent_settled", { aborted: false });
		await sleep(600);
		expect(host.messages).toEqual([]);

		await host.emit("input", { text: "continue", source: "interactive" });
		await host.emit("agent_settled", { aborted: false });
		await sleep(600);
		expect(host.messages.length).toBe(1);
		expect(host.messages[0]!.text).toContain("held2");
		host.messages.length = 0;
	});
});

describe("the transcript line", () => {
	test("job_start draws the call and one result line per job", async () => {
		const started = await host.call("job_start", { command: "echo rendered", name: "shown" });
		const id = started.structuredContent.jobs[0]!.id;
		const renderers = host.renderersFor("job_start");
		const call = JobsHost.lines(renderers.renderCall?.({ command: "echo rendered", name: "shown" }, plainTheme(), {}));
		expect(call.length).toBe(1);
		expect(call[0]).toContain("shown");
		expect(call[0]).toContain("echo rendered");

		const done = await host.call("job_status", { job_id: id, wait: 10 });
		const line = JobsHost.lines(
			renderers.renderResult?.(done, { expanded: false, isPartial: false }, plainTheme(), { durationMs: 1234 }),
		);
		expect(line.length).toBe(2);
		expect(line[0]).toContain("[ok]");
		expect(line[0]).toContain("exit=0");
		expect(line[1]).toContain("tool 1.2s");
		await host.quiet(400);
	});

	test("expanded output shows the log path and the tail", async () => {
		const started = await host.call("job_start", { command: "echo tail-line; echo second-line", name: "expand" });
		const id = started.structuredContent.jobs[0]!.id;
		const done = await host.call("job_status", { job_id: id, wait: 10 });
		const renderers = host.renderersFor("job_status");
		const lines = JobsHost.lines(
			renderers.renderResult?.(done, { expanded: true, isPartial: false }, plainTheme(), { durationMs: 5 }),
		);
		expect(lines.some((line) => line.includes("tail-line"))).toBe(true);
		expect(lines.some((line) => line.includes("second-line"))).toBe(true);
		expect(lines.some((line) => line.includes("tool 5ms"))).toBe(true);
		await host.quiet(400);
	});

	test("a tool outside the family keeps the renderer it had", () => {
		expect(host.renderersFor("read").renderCall).toBeUndefined();
	});
});

describe("log retention", () => {
	/** A pid no process holds. A log file carries the pid of the process that wrote it. */
	function deadPid(): number {
		for (let pid = 999_999; pid > 1; pid--) {
			if (!alive(pid)) return pid;
		}
		throw new Error("no free pid found");
	}

	let planted = 0;
	const DAY = 86_400_000;

	/** A log file of this extension, with a chosen age and a chosen owner. */
	function plant(ageMs: number, pid: number): string {
		mkdirSync(LOG_DIR, { recursive: true });
		const path = join(LOG_DIR, `j9${++planted}-${pid}.log`);
		writeFileSync(path, "a line the run already read\n");
		const when = new Date(Date.now() - ageMs);
		utimesSync(path, when, when);
		return path;
	}

	test("an old log of a dead process is gone after a session start", async () => {
		const path = plant(8 * DAY, deadPid());
		await host.emit("session_start", { reason: "startup" });
		expect(existsSync(path)).toBe(false);
	});

	test("a log the session just wrote stays", async () => {
		const path = plant(0, deadPid());
		await host.emit("session_start", { reason: "startup" });
		expect(existsSync(path)).toBe(true);
		rmSync(path, { force: true });
	});

	test("an old log of a process that still runs stays", async () => {
		const path = plant(8 * DAY, process.pid);
		await host.emit("session_start", { reason: "startup" });
		expect(existsSync(path)).toBe(true);
		rmSync(path, { force: true });
	});

	test("the ceiling trims a pile of fresh logs before the window closes", async () => {
		const dead = deadPid();
		const paths: string[] = [];
		// 250 logs, none past the window. A larger index is a newer file.
		for (let i = 0; i < 250; i++) paths.push(plant((250 - i) * 1000, dead));
		await host.emit("session_start", { reason: "startup" });
		const kept = paths.filter((path) => existsSync(path));
		expect(kept.length).toBe(200);
		expect(kept).toContain(paths.at(-1)!);
		expect(paths.filter((path) => !existsSync(path))).toContain(paths[0]!);
		for (const path of kept) rmSync(path, { force: true });
	});

	test("the age window clears a whole old week", async () => {
		const dead = deadPid();
		const paths: string[] = [];
		for (let i = 0; i < 40; i++) paths.push(plant(8 * DAY + (40 - i) * 1000, dead));
		await host.emit("session_start", { reason: "startup" });
		expect(paths.filter((path) => existsSync(path)).length).toBe(0);
	});

	test("a second session start changes nothing", async () => {
		const dead = deadPid();
		const old = plant(8 * DAY, dead);
		const fresh = plant(0, dead);
		await host.emit("session_start", { reason: "reload" });
		const afterFirst = readdirSync(LOG_DIR).sort();
		await host.emit("session_start", { reason: "reload" });
		expect(readdirSync(LOG_DIR).sort()).toEqual(afterFirst);
		expect(existsSync(old)).toBe(false);
		rmSync(fresh, { force: true });
	});

	// The keep window is read once, when the module loads, and one process holds
	// one value. So the switch to "never prune" is proven in a child process that
	// loads the extension with PI_JOBS_KEEP_DAYS=0 and runs this same case.
	const disabled = "an old log of a dead process survives when the keep window is zero";
	const noCeiling = "fresh logs survive when the ceiling is zero";

	/** Run a case in a child that loads the extension with its own knob values. */
	function inChildWith(env: Record<string, string>): { stderr: string; exitCode: number } {
		const child = Bun.spawnSync([process.execPath, "test", "jobs.test.ts", "-t", env.PI_JOBS_CASE ?? ""], {
			cwd: import.meta.dir,
			env: { ...process.env, ...env },
		});
		return { stderr: child.stderr.toString(), exitCode: child.exitCode ?? 1 };
	}

	if (process.env.PI_JOBS_KEEP_DAYS === "0") {
		test(disabled, async () => {
			const path = plant(8 * DAY, deadPid());
			await host.emit("session_start", { reason: "startup" });
			expect(existsSync(path)).toBe(true);
			rmSync(path, { force: true });
		});
	} else if (process.env.PI_JOBS_KEEP === "0") {
		test(noCeiling, async () => {
			const dead = deadPid();
			const fresh = [plant(0, dead), plant(0, dead), plant(0, dead)];
			await host.emit("session_start", { reason: "startup" });
			expect(fresh.filter((path) => existsSync(path)).length).toBe(3);
			for (const path of fresh) rmSync(path, { force: true });
		});
	} else {
		test(disabled, () => {
			const child = inChildWith({ PI_JOBS_KEEP_DAYS: "0", PI_JOBS_CASE: disabled });
			expect(child.stderr).toContain("1 pass");
			expect(child.exitCode).toBe(0);
		});

		test(noCeiling, () => {
			const child = inChildWith({ PI_JOBS_KEEP: "0", PI_JOBS_CASE: noCeiling });
			expect(child.stderr).toContain("1 pass");
			expect(child.exitCode).toBe(0);
		});
	}
});

describe("who can read a job log", () => {
	/** Mode of a path, with the file type bits removed. */
	function modeOf(path: string): number {
		return statSync(path).mode & 0o777;
	}

	test("a new log and its directory are open to your account alone", async () => {
		const previousUmask = process.umask(0o022);
		await host.emit("session_start", { reason: "startup" });
		const started = await host.call("job_start", { command: "echo secret-line", name: "private" });
		process.umask(previousUmask);
		const log = started.structuredContent.jobs[0]!.log;
		expect(modeOf(LOG_DIR)).toBe(0o700);
		expect(modeOf(log)).toBe(0o600);
		await host.quiet();
	});

	test("a directory that already exists gets tightened", async () => {
		chmodSync(LOG_DIR, 0o755);
		await host.emit("session_start", { reason: "startup" });
		await host.call("job_start", { command: "echo still-private", name: "tighten" });
		expect(modeOf(LOG_DIR)).toBe(0o700);
		await host.quiet();
	});

	test("a log an older version left world readable gets tightened", async () => {
		const legacy = join(LOG_DIR, "j7777-1.log");
		writeFileSync(legacy, "left behind by 0.1.0\n");
		chmodSync(legacy, 0o644);
		await host.emit("session_start", { reason: "startup" });
		expect(existsSync(legacy)).toBe(true);
		expect(modeOf(legacy)).toBe(0o600);
		rmSync(legacy);
		await host.quiet();
	});

	test("a session that starts no job still tightens the directory", async () => {
		chmodSync(LOG_DIR, 0o755);
		await host.emit("session_start", { reason: "startup" });
		expect(modeOf(LOG_DIR)).toBe(0o700);
		await host.quiet(100);
	});

	test("a file the extension never wrote keeps its own mode", async () => {
		const foreign = join(LOG_DIR, "not-a-job-log.txt");
		writeFileSync(foreign, "yours\n");
		chmodSync(foreign, 0o644);
		await host.emit("session_start", { reason: "startup" });
		await host.call("job_start", { command: "echo peek", name: "peek" });
		expect(modeOf(foreign)).toBe(0o644);
		rmSync(foreign);
		await host.quiet();
	});
});

describe("session_shutdown", () => {
	test("a job that cleans up on the signal is allowed to finish cleaning", async () => {
		await host.emit("session_start", { reason: "startup" });
		const started = await host.call("job_start", {
			command: `trap 'echo start-cleaning; sleep 0.4; echo done-cleaning; exit 0' TERM; while :; do sleep 0.2; done`,
			name: "cleanup",
		});
		const job = started.structuredContent.jobs[0]!;
		await sleep(500);
		await host.emit("session_shutdown", { reason: "quit" });
		const deadline = Date.now() + 4000;
		while (alive(job.pid!) && Date.now() < deadline) await sleep(50);
		expect(alive(job.pid!)).toBe(false);
		expect(tailOf(job.log)).toContain("start-cleaning");
		expect(tailOf(job.log)).toContain("done-cleaning");
	});

	test("a job that ignores the signal dies inside the ceiling", async () => {
		await host.emit("session_start", { reason: "reload" });
		const started = await host.call("job_start", { command: `trap '' TERM; while :; do sleep 0.2; done`, name: "stubborn" });
		const job = started.structuredContent.jobs[0]!;
		await sleep(300);
		await host.emit("session_shutdown", { reason: "quit" });
		const deadline = Date.now() + 4000;
		while (alive(job.pid!) && Date.now() < deadline) await sleep(50);
		expect(alive(job.pid!)).toBe(false);
	});

	test("stops open work, twice if asked", async () => {
		await host.emit("session_start", { reason: "reload" });
		const started = await host.call("job_start", { command: "sleep 60", name: "survivor" });
		const pid = started.structuredContent.jobs[0]!.pid;
		await sleep(300);
		expect(alive(pid)).toBe(true);
		host.messages.length = 0;
		await host.emit("session_shutdown", { reason: "quit" });
		await host.emit("session_shutdown", { reason: "quit" });
		await sleep(400);
		expect(alive(pid)).toBe(false);
		expect(host.notifications.some((note) => note.includes("background job"))).toBe(true);
		const after = await host.call("job_status", {});
		expect(after.structuredContent.jobs.length).toBe(0);
		expect(host.messages.length).toBe(0);
	});
});

afterAll(() => {
	rmSync(LOG_DIR, { recursive: true, force: true });
});
