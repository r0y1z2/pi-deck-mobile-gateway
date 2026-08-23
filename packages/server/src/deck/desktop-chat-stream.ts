const EVENT_SEPARATOR = /\r?\n\r?\n/;
const FINISH_EVENT = 'data: {"type":"finish"}\n\n';
const DONE_EVENT = "data: [DONE]\n\n";

interface DesktopRuntimeState {
	sessionId?: unknown;
	status?: unknown;
}

interface DesktopSessionState {
	id?: unknown;
	updatedAt?: unknown;
}

interface DesktopMessageState {
	role?: unknown;
	timestamp?: unknown;
}

export interface DesktopStateSnapshot {
	runtimes?: DesktopRuntimeState[];
	sessions?: DesktopSessionState[];
	messagesBySession?: Record<string, DesktopMessageState[]>;
}

export interface DesktopChatStreamChunk {
	wire: string;
	complete: boolean;
}

function timestampAtOrAfter(value: unknown, threshold: number): boolean {
	return typeof value === "number" && Number.isFinite(value) && value >= threshold;
}

export function isDesktopChatSettled(state: DesktopStateSnapshot, sessionId: string, requestStartAt: number): boolean {
	const runtime = state.runtimes?.find((candidate) => candidate.sessionId === sessionId);
	if (runtime?.status !== "idle") return false;
	const session = state.sessions?.find((candidate) => candidate.id === sessionId);
	if (!timestampAtOrAfter(session?.updatedAt, requestStartAt)) return false;
	const messages = state.messagesBySession?.[sessionId];
	const lastMessage = messages?.[messages.length - 1];
	return lastMessage?.role === "assistant" && timestampAtOrAfter(lastMessage.timestamp, requestStartAt);
}

export class DesktopChatStreamTracker {
	private pending = "";
	private lastPayloadAt: number;
	private complete = false;
	private readonly openTextBlocks = new Set<string>();
	private readonly openReasoningBlocks = new Set<string>();

	constructor(now = Date.now()) {
		this.lastPayloadAt = now;
	}

	push(chunk: string, now = Date.now()): DesktopChatStreamChunk {
		if (this.complete) return { wire: "", complete: true };
		this.pending += chunk;
		let wire = "";
		for (;;) {
			const separator = this.pending.match(EVENT_SEPARATOR);
			if (!separator || separator.index === undefined) break;
			const end = separator.index + separator[0].length;
			const event = this.pending.slice(0, end);
			this.pending = this.pending.slice(end);
			const data = event
				.split(/\r?\n/)
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n");
			if (!data) {
				wire += event;
				continue;
			}
			if (data === "[DONE]") {
				wire += FINISH_EVENT + DONE_EVENT;
				this.complete = true;
				this.pending = "";
				break;
			}
			let frame: { type?: unknown; id?: unknown } | undefined;
			try {
				frame = JSON.parse(data) as { type?: unknown; id?: unknown };
			} catch {
				wire += event;
				continue;
			}
			if (frame.type === "finish") {
				wire += event + DONE_EVENT;
				this.complete = true;
				this.pending = "";
				break;
			}
			this.lastPayloadAt = now;
			if (typeof frame.id === "string") {
				if (frame.type === "text-start") this.openTextBlocks.add(frame.id);
				if (frame.type === "text-end") this.openTextBlocks.delete(frame.id);
				if (frame.type === "reasoning-start") this.openReasoningBlocks.add(frame.id);
				if (frame.type === "reasoning-end") this.openReasoningBlocks.delete(frame.id);
			}
			wire += event;
		}
		return { wire, complete: this.complete };
	}

	shouldRecover(stateSettled: boolean, now: number, silenceMs: number): boolean {
		return !this.complete && stateSettled && now - this.lastPayloadAt >= silenceMs;
	}

	recoveryWire(): string {
		if (this.complete) return "";
		let wire = this.pending;
		this.pending = "";
		for (const id of this.openTextBlocks) wire += `data: ${JSON.stringify({ type: "text-end", id })}\n\n`;
		for (const id of this.openReasoningBlocks) wire += `data: ${JSON.stringify({ type: "reasoning-end", id })}\n\n`;
		this.openTextBlocks.clear();
		this.openReasoningBlocks.clear();
		this.complete = true;
		return wire + FINISH_EVENT + DONE_EVENT;
	}

	flush(): string {
		const wire = this.pending;
		this.pending = "";
		return wire;
	}
}
