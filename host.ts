/**
 * host: a stand-in for the pi host, for tests of the jobs extension.
 *
 * Why this file exists. The jobs extension acts only through the host: it
 * registers tools, subscribes to lifecycle events, appends entries, and asks
 * the host to start a turn. A test must drive that surface, so a test reads
 * what the host received and never reaches inside the extension.
 *
 * Host rules kept faithful, from dist/core/extensions/types.d.ts:
 *   - registerTool receives one object with name, description, parameters, and
 *     execute(toolCallId, params, signal, onUpdate, ctx).
 *   - sendUserMessage always triggers a turn. With the agent streaming, the
 *     caller passes deliverAs "followUp". Idle delivery takes no options, so a
 *     test can tell the two paths apart by the second argument alone.
 *   - appendEntry stays out of the model context.
 *   - registerToolRenderer receives one resolver, (toolName, next). The
 *     resolver returns renderCall and renderResult for a name, or calls next().
 *     The renderer functions receive a theme and a context with durationMs.
 *   - ctx.mode is one of "tui", "rpc", "json", "print". Only "tui" and "rpc"
 *     have UI methods. ctx.isIdle() reports whether the agent streams.
 *
 * Deliberately shallow: no transcript, no provider, no real turn. A test that
 * needs a real turn runs the RPC script at ./jobs-rpc.ts.
 */

export interface SentMessage {
	text: string;
	options?: { deliverAs?: string };
}

export interface RecordedEntry {
	type: string;
	data: any;
}

interface ToolDefinition {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	namespace?: { name: string; description?: string; instructions?: string };
	parameters: unknown;
	outputSchema?: unknown;
	annotations?: Record<string, boolean>;
	execute: (
		toolCallId: string,
		params: any,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown; structuredContent: { jobs: any[] } }>;
}

/** What one tool resolver returned. The real type is ToolRenderers. */
export interface CapturedRenderers {
	renderShell?: "default" | "self";
	renderCall?: (args: any, theme: any, context: any) => { render(width: number): string[] };
	renderResult?: (result: any, options: any, theme: any, context: any) => { render(width: number): string[] };
}

/** A theme that returns plain text, so a test reads what the renderer chose to say. */
export function plainTheme(): any {
	return {
		fg: (_token: string, text: string) => text,
		bold: (text: string) => text,
		colors: {},
	};
}

export class JobsHost {
	readonly tools = new Map<string, ToolDefinition>();
	readonly commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
	readonly messages: SentMessage[] = [];
	readonly entries: RecordedEntry[] = [];
	readonly notifications: string[] = [];
	readonly widgets = new Map<string, string[] | undefined>();
	/** Resolvers passed to registerToolRenderer, in registration order. */
	readonly renderers: Array<(toolName: string, next: () => CapturedRenderers | undefined) => CapturedRenderers | undefined> = [];
	private readonly handlers = new Map<string, Array<(event: any, ctx: any) => Promise<void>>>();

	private idle = true;
	private mode: "tui" | "rpc" | "json" | "print" = "tui";

	/** Value of ctx.cwd handed to every tool call. */
	cwd = "/tmp";

	/** Every setStatus call, by key. undefined means the key was cleared. */
	readonly statuses = new Map<string, string | undefined>();

	readonly ctx: any = {
		mode: this.mode,
		hasUI: true,
		isIdle: () => this.idle,
		ui: {
			notify: (message: string) => this.notifications.push(message),
			setWidget: (key: string, lines: string[] | undefined) => this.widgets.set(key, lines),
			setStatus: (key: string, text: string | undefined) => this.statuses.set(key, text),
			theme: plainTheme(),
		},
		get cwd() {
			return "/tmp";
		},
	};

	/** The object the extension factory receives. */
	readonly api: any = {
		registerTool: (tool: ToolDefinition) => this.tools.set(tool.name, tool),
		registerCommand: (name: string, options: { description: string; handler: any }) => this.commands.set(name, options),
		on: (event: string, handler: (event: any, ctx: any) => Promise<void>) => {
			const list = this.handlers.get(event) ?? [];
			list.push(handler);
			this.handlers.set(event, list);
			return () => {};
		},
		appendEntry: (type: string, data: any) => this.entries.push({ type, data }),
		sendUserMessage: (text: string, options?: { deliverAs?: string }) => this.messages.push({ text, options }),
		sendMessage: () => {},
		registerToolRenderer: (resolver: (name: string, next: () => CapturedRenderers | undefined) => CapturedRenderers | undefined) => {
			this.renderers.push(resolver);
		},
	};

	/** Replay a host lifecycle event. Handlers run in registration order. */
	async emit(event: string, data: any = {}): Promise<void> {
		for (const handler of this.handlers.get(event) ?? []) await handler(data, this.ctx);
	}

	/** Move the host between idle and streaming. */
	setIdle(idle: boolean): void {
		this.idle = idle;
	}

	/** Move the host between run modes. */
	setMode(mode: "tui" | "rpc" | "json" | "print"): void {
		this.mode = mode;
		this.ctx.mode = mode;
		this.ctx.hasUI = mode === "tui" || mode === "rpc";
	}

	/** Call one tool the way the host does. */
	call(name: string, params: any) {
		const tool = this.tools.get(name);
		if (!tool) throw new Error(`no tool named ${name}`);
		return tool.execute(`call-${name}-${this.tools.size}-${Math.random()}`, params, undefined, undefined, this.ctx);
	}

	/** Call a registered `/` command the way the host does. */
	async runCommand(name: string, args = ""): Promise<void> {
		const command = this.commands.get(name);
		if (!command) throw new Error(`no command named ${name}`);
		await command.handler(args, this.ctx);
	}

	/** Renderers the resolver chain gives for one tool name. */
	renderersFor(toolName: string): CapturedRenderers {
		for (const resolver of this.renderers) {
			const found = resolver(toolName, () => undefined);
			if (found) return found;
		}
		return {};
	}

	/** Lines a renderer component draws at a wide terminal width. */
	static lines(component: { render(width: number): string[] } | undefined, width = 400): string[] {
		return component ? component.render(width) : [];
	}

	/** Model-facing text of a tool result. */
	static text(result: { content: Array<{ type: "text"; text: string }> }): string {
		return result.content.map((part) => part.text).join("\n");
	}

	/** Jobs recorded in the durable entry log for one state. */
	statesOf(state: string): RecordedEntry[] {
		return this.entries.filter((entry) => entry.type === "jobs" && entry.data.state === state);
	}

	/** Let the wake-ups of this test land, then forget them. Each test drains its own jobs. */
	async quiet(ms = 600): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, ms));
		this.messages.length = 0;
	}
}
