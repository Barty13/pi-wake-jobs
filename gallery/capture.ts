// Capture the widget and the footer at three moments of one run.
// The image in assets/gallery.png is drawn from this output, so it is real
// output, not a mock-up. Run: bun gallery/capture.ts > /tmp/cap.json
process.env.PI_JOBS_DIR = "/tmp/pi-jobs-shot";
process.env.PI_JOBS_KEEP_DAYS = "0";
import { JobsHost } from "../host.ts";
const { default: jobs } = await import("../jobs.ts");

const host = new JobsHost();
jobs(host.api);
await host.emit("session_start", { reason: "startup" });
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
const frame = () =>
	JSON.parse(
		JSON.stringify({
			footer: host.statuses.get("jobs") ?? null,
			table: host.widgets.get("jobs") ?? null,
		}),
	);

const slow = await host.call("job_start", { command: "sleep 6; echo build", name: "kernel-build" });
await host.call("job_start", { command: "sleep 3; echo index", name: "fetch index" });
await host.call("job_start", { command: "sleep 1; exit 2", name: "docs" });
await host.runCommand("jobs", "all");
const started = frame();

await wait(3200);
await host.quiet(600);
await host.runCommand("jobs", "all");
const midway = frame();

await host.call("job_stop", { job_id: slow.structuredContent.jobs[0]!.id });
await host.quiet(600);
await host.runCommand("jobs", "all");
const ended = frame();

await host.emit("session_shutdown", { reason: "quit" });
console.log(JSON.stringify({ started, midway, ended }));
