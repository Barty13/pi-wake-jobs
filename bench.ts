/**
 * bench: measures the two numbers the README quotes. No model is involved, so
 * any machine with Bun can repeat it.
 *
 *   Table A  Time from a job exit to the wake-up the host receives. A batch of
 *            one, three and ten jobs, five repeats each. The exit moment comes
 *            from the durable entry the extension writes as it settles, the
 *            arrival moment from sendUserMessage. Both cross the host seam.
 *
 *   Table B  Size of one wake-up message, for a job whose log is empty, about
 *            1.7 KB, and about 20 KB. Bytes, and the token count Pi's own
 *            estimateTokens gives for the same text.
 *
 * Run: bun bench.ts
 * Keep it out of `bun test`: the file is not a *.test.ts on purpose.
 */

import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { JobsHost } from "./host.ts";

const LOG_DIR = `/tmp/pi-wake-bench-${process.pid}`;
process.env.PI_JOBS_DIR = LOG_DIR;
process.env.PI_JOBS_DEBOUNCE_MS = "400";
process.env.PI_JOBS_TAIL_BYTES = "3000";

const { default: jobsExtension } = await import("./jobs.ts");

const host = new JobsHost();
jobsExtension(host.api);

/** Timestamp of every appendEntry and sendUserMessage, in arrival order. */
const appended: Array<{ at: number; id: string; state: string }> = [];
const delivered: number[] = [];

const rawAppend = host.api.appendEntry;
host.api.appendEntry = (type: string, data: any) => {
	appended.push({ at: Date.now(), id: data?.id ?? "", state: data?.state ?? "" });
	return rawAppend(type, data);
};
const rawSend = host.api.sendUserMessage;
host.api.sendUserMessage = (text: string, options?: { deliverAs?: string }) => {
	delivered.push(Date.now());
	return rawSend(text, options);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Milliseconds from the last exit in a batch to the message that carries it. */
function lastGap(startIndex: number): number {
	const exits = appended.filter((entry, index) => index >= startIndex && entry.state !== "running");
	const arrived = delivered[delivered.length - 1] ?? 0;
	const lastExit = Math.max(...exits.map((entry) => entry.at));
	return arrived - lastExit;
}

/** One batch of `count` jobs that exit together. Returns the worst gap in it. */
async function batch(count: number): Promise<number> {
	const mark = appended.length;
	const before = delivered.length;
	const ids: string[] = [];
	for (let i = 0; i < count; i++) {
		const started = await host.call("job_start", { command: "sleep 1; echo done", name: `b${count}-${i}` });
		ids.push(started.structuredContent.jobs[0]!.id);
	}
	// Wait for the batch to arrive, with room for a slow machine.
	const deadline = Date.now() + 20_000;
	while (delivered.length === before && Date.now() < deadline) await sleep(5);
	const gap = lastGap(mark);
	const settled = await host.call("job_status", { job_id: ids[0]!, tail_bytes: 0 });
	void settled;
	return gap;
}

/**
 * Wake-up message size for a job whose log holds about `bytes` of output.
 *
 * The command stays short on purpose. The wake-up quotes the command, so a
 * command that carries its own data inflates the message past the log tail.
 */
async function wakeSize(bytes: number): Promise<{ text: string; logBytes: number; commandBytes: number }> {
	const command = bytes === 0 ? "true" : `head -c ${bytes} /dev/zero | tr '\\0' 'x'`;
	const started = await host.call("job_start", { command, name: `size-${bytes}` });
	const id = started.structuredContent.jobs[0]!.id;
	const before = delivered.length;
	const deadline = Date.now() + 20_000;
	while (delivered.length === before && Date.now() < deadline) await sleep(5);
	const text = host.messages[host.messages.length - 1]?.text ?? "";
	const logBytes = statSync(join(LOG_DIR, `${id}-${process.pid}.log`)).size;
	return { text, logBytes, commandBytes: new TextEncoder().encode(command).length };
}

/** The receipt `job_start` returns, as the model sees it. */
async function receiptOf(command: string, name: string): Promise<{ text: string; pathBytes: number }> {
	const started = await host.call("job_start", { command, name });
	const text = (started.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("");
	const log = started.structuredContent.jobs[0]!.log as string;
	await host.quiet(600);
	return { text, pathBytes: new TextEncoder().encode(log).length };
}

/** Tokens Pi counts for this text. Pi's own estimator, not a guess. */
function tokensOf(text: string): number {
	return estimateTokens({ role: "user", content: text, timestamp: Date.now() });
}

function percentile(values: number[], at: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.ceil((at / 100) * sorted.length) - 1);
	return sorted[index]!;
}

const lines: string[] = [];
lines.push(`pi-wake-jobs bench  host ${Bun.env.HOME ? "local" : "ci"}  bun ${Bun.version}  ${new Date().toISOString()}`);
lines.push(`debounce ${process.env.PI_JOBS_DEBOUNCE_MS}ms  tail ${process.env.PI_JOBS_TAIL_BYTES}B  keep_days ${process.env.PI_JOBS_KEEP_DAYS ?? "default"}  repeat 5`);
lines.push("");
lines.push("Table A  exit to wake-up, milliseconds");
lines.push("batch  p50  p95  max  n");

const REPEATS = 5;
for (const count of [1, 3, 10]) {
	const gaps: number[] = [];
	for (let repeat = 0; repeat < REPEATS; repeat++) gaps.push(await batch(count));
	await host.quiet(600);
	lines.push(
		`${String(count).padEnd(6)}${String(percentile(gaps, 50)).padEnd(5)}${String(percentile(gaps, 95)).padEnd(5)}${String(Math.max(...gaps)).padEnd(5)}${gaps.length}`,
	);
}

lines.push("");
lines.push("Table B  one wake-up message");
lines.push("log_bytes  message_bytes  pi_tokens  command_bytes  note");
for (const target of [0, 1700, 20_000]) {
	const { text, logBytes, commandBytes } = await wakeSize(target);
	const bytes = new TextEncoder().encode(text).length;
	const note = logBytes > 3000 && bytes < logBytes ? "tail capped by PI_JOBS_TAIL_BYTES" : "";
	lines.push(
		`${String(logBytes).padEnd(11)}${String(bytes).padEnd(15)}${String(tokensOf(text)).padEnd(11)}${String(commandBytes).padEnd(15)}${note}`,
	);
	await host.quiet(600);
}

lines.push("");
lines.push("Table C  the receipt job_start returns");
lines.push("command_bytes  log_path_bytes  receipt_bytes  pi_tokens");
for (const command of ["true", "head -c 20000 /dev/zero | tr '\\0' 'x'"]) {
	const { text, pathBytes } = await receiptOf(command, "noisy");
	lines.push(
		`${String(new TextEncoder().encode(command).length).padEnd(14)}${String(pathBytes).padEnd(15)}${String(new TextEncoder().encode(text).length).padEnd(14)}${tokensOf(text)}`,
	);
}
lines.push(`note  the receipt quotes the log path twice, so it grows with the length of PI_JOBS_DIR`);

lines.push("");
console.log(lines.join("\n"));

await host.emit("session_shutdown", { reason: "quit" });
rmSync(LOG_DIR, { recursive: true, force: true });
