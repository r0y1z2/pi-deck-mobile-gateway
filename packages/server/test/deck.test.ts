import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import type {
	AgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { DECK_JS, DECK_SERVICE_WORKER } from "../src/deck/assets.ts";
import { DeckAuth } from "../src/deck/auth.ts";
import { DesktopChatStreamTracker, isDesktopChatSettled } from "../src/deck/desktop-chat-stream.ts";
import { desktopCompatUpstreamPath, rewriteDesktopHtml, rewriteDesktopWebBundle } from "../src/deck/desktop-compat.ts";
import { DECK_JS_FEATURES } from "../src/deck/features.ts";
import { type DeckSupervisor, startDeckHttpServer } from "../src/deck/http-server.ts";
import { parseRpcBody } from "../src/deck/validation.ts";
import { ServerSupervisor } from "../src/supervisor.ts";
import type { InstanceRecord } from "../src/types.ts";

class FakeSupervisor implements DeckSupervisor {
	instances: InstanceRecord[] = [];
	commands: RpcCommand[] = [];
	streamCloses = 0;

	listInstances(): InstanceRecord[] {
		return this.instances;
	}

	getInstance(instanceId: string): InstanceRecord | undefined {
		return this.instances.find((instance) => instance.id === instanceId);
	}

	isInstanceLive(instanceId: string): boolean {
		return this.instances.some((instance) => instance.id === instanceId && instance.status !== "stopped");
	}

	async spawnInstance(options: { cwd: string; label?: string }): Promise<InstanceRecord> {
		const instance: InstanceRecord = {
			id: `instance-${this.instances.length + 1}`,
			status: "ready",
			cwd: options.cwd,
			label: options.label,
			createdAt: new Date().toISOString(),
		};
		this.instances.push(instance);
		return instance;
	}

	async stopInstance(instanceId: string): Promise<InstanceRecord | undefined> {
		const instance = this.getInstance(instanceId);
		if (!instance) return undefined;
		const stopped = { ...instance, status: "stopped" as const };
		this.instances = this.instances.map((candidate) => (candidate.id === instanceId ? stopped : candidate));
		return stopped;
	}

	async resumeInstance(instanceId: string): Promise<InstanceRecord | undefined> {
		const instance = this.getInstance(instanceId);
		if (!instance) return undefined;
		const resumed = { ...instance, status: "ready" as const };
		this.instances = this.instances.map((candidate) => (candidate.id === instanceId ? resumed : candidate));
		return resumed;
	}

	async deleteInstance(instanceId: string): Promise<boolean> {
		const previousLength = this.instances.length;
		this.instances = this.instances.filter((candidate) => candidate.id !== instanceId);
		return this.instances.length !== previousLength;
	}

	readInstanceMessages(instanceId: string): unknown[] | undefined {
		return this.getInstance(instanceId) ? [] : undefined;
	}

	async handleRpc(_instanceId: string, command: RpcCommand): Promise<RpcResponse> {
		this.commands.push(command);
		return { type: "response", command: command.type, success: false, error: "fake response" };
	}

	openRpcStream(
		_instanceId: string,
		_onEvent: (event: AgentSessionEvent) => void,
		_onUiRequest: (request: RpcExtensionUIRequest) => void,
	): {
		handleRpc(command: RpcCommand): Promise<RpcResponse>;
		handleUiResponse(response: RpcExtensionUIResponse): void;
		close(): void;
	} {
		return {
			handleRpc: (command) => this.handleRpc(_instanceId, command),
			handleUiResponse: () => undefined,
			close: () => {
				this.streamCloses += 1;
			},
		};
	}
}

const temporaryPaths: string[] = [];

const LEGACY_WEB_BUNDLE = `  if (shouldRecreateChat) {
    chatRef.current = "chat" in options ? options.chat : new Chat(chatOptions);
  }
  const subscribeToMessages = reactExports.useCallback(
    (update) => chatRef.current["~registerMessagesCallback"](update, throttleWaitMs),
    // \`chatRef.current.id\` is required to trigger re-subscription when the chat ID changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [throttleWaitMs, chatRef.current.id]
  );
  const messages = reactExports.useSyncExternalStore(
    subscribeToMessages,
    () => chatRef.current.messages,
    () => chatRef.current.messages
  );
  const status = reactExports.useSyncExternalStore(
    chatRef.current["~registerStatusCallback"],
    () => chatRef.current.status,
    () => chatRef.current.status
  );
  reactExports.useEffect(() => {
    if (!activeSessionId || !streaming) return;
    messagesBySessionRef.current[activeSessionId] = messages;
    loadedSessionsRef.current.add(activeSessionId);
  }, [messages, activeSessionId, streaming]);
  const { messages, sendMessage, status, stop, setMessages, error } = useChat({
    id: activeSessionId,
    transport: new DefaultChatTransport({ api: "/api/chat" })
  });`;

function temporaryDirectory(): string {
	const path = mkdtempSync(join(tmpdir(), "pi-deck-test-"));
	temporaryPaths.push(path);
	return path;
}

async function listenOnLoopback(server: Server): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
	return address.port;
}

async function closeTestServer(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

afterEach(() => {
	for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Deck authentication", () => {
	it("stores only a token hash and revokes paired devices", () => {
		const directory = temporaryDirectory();
		const storePath = join(directory, "devices.json");
		const auth = new DeckAuth(storePath, { now: 1_000, pairingCode: "123456" });
		const paired = auth.pair("123456", "Phone", "127.0.0.1", 2_000);
		const stored = readFileSync(storePath, "utf8");

		expect(stored).not.toContain(paired.token);
		expect(auth.authenticate(paired.token)?.id).toBe(paired.device.id);
		expect(auth.revoke(paired.device.id)).toBe(true);
		expect(auth.authenticate(paired.token)).toBeUndefined();
	});

	it("makes pairing codes single-use", () => {
		const auth = new DeckAuth(join(temporaryDirectory(), "devices.json"), { now: 1_000, pairingCode: "123456" });
		auth.pair("123456", "Phone", "one", 2_000);
		expect(() => auth.pair("123456", "Tablet", "two", 2_001)).toThrow("already been used");
	});
});

describe("Deck RPC validation", () => {
	it("allows only the documented command whitelist", () => {
		expect(parseRpcBody({ command: "prompt", message: "hello" }).command).toEqual({
			type: "prompt",
			message: "hello",
		});
		expect(() => parseRpcBody({ command: "bash", commandText: "whoami" })).toThrow("not allowed");
		expect(() => parseRpcBody({ command: "switch_session", sessionPath: "secret" })).toThrow("not allowed");
		expect(parseRpcBody({ command: "set_thinking_level", level: "high" }).command).toEqual({
			type: "set_thinking_level",
			level: "high",
		});
		expect(() => parseRpcBody({ command: "set_thinking_level", level: "unlimited" })).toThrow(
			"Invalid thinking level",
		);
	});
});

describe("Deck task persistence", () => {
	it("marks active records interrupted after restart without resuming them", async () => {
		const directory = temporaryDirectory();
		const previousServerDir = process.env.PI_SERVER_DIR;
		process.env.PI_SERVER_DIR = directory;
		try {
			writeFileSync(
				join(directory, "instances.json"),
				JSON.stringify([
					{ id: "running", status: "running", cwd: directory, createdAt: new Date(0).toISOString() },
					{ id: "done", status: "completed", cwd: directory, createdAt: new Date(0).toISOString() },
				]),
			);
			const supervisor = new ServerSupervisor();
			await supervisor.recoverAfterRestart();
			expect(supervisor.getInstance("running")?.status).toBe("interrupted");
			expect(supervisor.isInstanceLive("running")).toBe(false);
			expect(supervisor.getInstance("done")?.status).toBe("completed");
		} finally {
			if (previousServerDir === undefined) delete process.env.PI_SERVER_DIR;
			else process.env.PI_SERVER_DIR = previousServerDir;
		}
	});

	it("rejects a stored session whose header belongs to another workspace", () => {
		const directory = temporaryDirectory();
		const workspace = join(directory, "allowed");
		const otherWorkspace = join(directory, "other");
		mkdirSync(workspace);
		mkdirSync(otherWorkspace);
		const sessionFile = join(directory, "session.jsonl");
		writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: new Date(0).toISOString(), cwd: otherWorkspace })}\n`,
		);
		const previousServerDir = process.env.PI_SERVER_DIR;
		process.env.PI_SERVER_DIR = directory;
		try {
			writeFileSync(
				join(directory, "instances.json"),
				JSON.stringify([
					{
						id: "task-1",
						status: "interrupted",
						cwd: workspace,
						createdAt: new Date(0).toISOString(),
						sessionId: "session-1",
						sessionFile,
					},
				]),
			);
			const supervisor = new ServerSupervisor();
			expect(() => supervisor.readInstanceMessages("task-1")).toThrow("workspace does not match");
		} finally {
			if (previousServerDir === undefined) delete process.env.PI_SERVER_DIR;
			else process.env.PI_SERVER_DIR = previousServerDir;
		}
	});
});

describe("Deck browser assets", () => {
	it("ships a syntactically valid browser bundle", () => {
		expect(() => new Script(`${DECK_JS}\n${DECK_JS_FEATURES}`)).not.toThrow();
		expect(DECK_JS_FEATURES).toContain("task-filter");
		expect(DECK_JS_FEATURES).toContain("/api/devices");
		expect(DECK_JS_FEATURES).toContain("location.replace('/')");
		expect(DECK_JS_FEATURES).not.toContain("tokenHash");
		expect(DECK_SERVICE_WORKER).toContain("pi-deck-v4");
		expect(DECK_SERVICE_WORKER).not.toContain("const CORE=['/'");
	});
});

describe("Desktop PiDeck compatibility", () => {
	it("rewrites the web entry to a cache-busting compatibility asset", () => {
		const html = '<script type="module" src="./assets/web-current_hash.js"></script>';
		const rewritten = rewriteDesktopHtml(html);

		expect(rewritten).toContain("./assets/web-current_hash.deck-compat.js");
		expect(desktopCompatUpstreamPath("/assets/web-current_hash.deck-compat.js")).toBe("/assets/web-current_hash.js");
		expect(desktopCompatUpstreamPath("/assets/vendor-react.js")).toBeUndefined();
		expect(() => rewriteDesktopHtml("<title>Unsupported</title>")).toThrow("web entry marker");
	});

	it("publishes stable message snapshots only through throttled callbacks", () => {
		const rewritten = rewriteDesktopWebBundle(LEGACY_WEB_BUNDLE);

		expect(rewritten).toContain("pi-deck-mobile-compat: stable throttled chat snapshots");
		expect(rewritten).toContain('chat["~registerMessagesCallback"](updateMessages, throttleWaitMs)');
		expect(rewritten).toContain("() => messagesSnapshotRef.current.messages");
		expect(rewritten).not.toContain("() => chatRef.current.messages");
		expect(rewritten).toContain("throttle: 100");
		expect(rewritten).toContain("pi-deck-mobile-compat: reconcile a missing chat stream terminator");
		expect(rewritten).toContain('activeRuntime.status) !== "idle"');
		expect(rewritten).toContain('lastMessage.role !== "assistant"');
		expect(rewritten).toContain("if (activeSessionIdRef.current === activeSessionId) void stop()");
		expect(rewritten).toContain("}, 6e3)");
		expect(() => rewriteDesktopWebBundle("unsupported bundle")).toThrow("message snapshot marker");
	});

	it("recovers a silent chat stream only after a new assistant result is settled", () => {
		const requestStartAt = 10_000;
		const tracker = new DesktopChatStreamTracker(requestStartAt);
		const first = tracker.push(
			'data: {"type":"start","messageId":"m1"}\n\ndata: {"type":"text-start","id":"t1"}\n',
			10_100,
		);
		const second = tracker.push(
			'\ndata: {"type":"text-delta","id":"t1","delta":"ok"}\n\ndata: {"type":"text-end","id":"t1"}\n\n',
			10_200,
		);
		expect(first.wire).toContain('"type":"start"');
		expect(second.wire).toContain('"type":"text-end"');

		const settledState = {
			runtimes: [{ sessionId: "session-1", status: "idle" }],
			sessions: [{ id: "session-1", updatedAt: 10_300 }],
			messagesBySession: { "session-1": [{ role: "assistant", timestamp: 10_250 }] },
		};
		expect(isDesktopChatSettled(settledState, "session-1", requestStartAt)).toBe(true);
		expect(tracker.shouldRecover(true, 16_199, 6_000)).toBe(false);
		expect(tracker.shouldRecover(true, 16_200, 6_000)).toBe(true);
		expect(tracker.recoveryWire()).toBe('data: {"type":"finish"}\n\ndata: [DONE]\n\n');
		expect(
			isDesktopChatSettled(
				{
					...settledState,
					messagesBySession: { "session-1": [{ role: "assistant", timestamp: 9_999 }] },
				},
				"session-1",
				requestStartAt,
			),
		).toBe(false);
	});

	it("adds a finish frame when upstream sends only DONE or no payload", () => {
		const doneOnly = new DesktopChatStreamTracker(1_000);
		const tracked = doneOnly.push("data: [DO", 1_100);
		expect(tracked.wire).toBe("");
		expect(doneOnly.push("NE]\n\n", 1_200)).toEqual({
			wire: 'data: {"type":"finish"}\n\ndata: [DONE]\n\n',
			complete: true,
		});

		const empty = new DesktopChatStreamTracker(1_000);
		expect(empty.shouldRecover(true, 7_000, 6_000)).toBe(true);
	});
});

describe("Deck HTTP gateway", () => {
	it("proxies the authenticated desktop PiDeck UI, API, mutations, and SSE without leaking credentials", async () => {
		let observedHeaders: IncomingHttpHeaders = {};
		let observedPath = "";
		let observedBundlePath = "";
		let promptBody = "";
		let directChatRequests = 0;
		const chatStreams: ServerResponse[] = [];
		const chatPrompts: Array<{ requestId: string; message: string }> = [];
		const chatPromptHeaders: IncomingHttpHeaders[] = [];
		const settledTimestamp = Date.now() + 60_000;
		const upstream = createServer(async (request, response) => {
			if (request.url === "/") {
				observedHeaders = request.headers;
				response.writeHead(200, {
					"Content-Type": "text/html",
					"Cache-Control": "public, max-age=31536000, immutable",
				});
				response.end(
					'<!doctype html><title>Desktop PiDeck</title><script type="module" src="./assets/web-test.js"></script><link rel="modulepreload" href="./assets/vendor-test.js">',
				);
				return;
			}
			if (request.url === "/assets/web-test.js") {
				observedBundlePath = request.url;
				response.writeHead(200, {
					"Content-Type": "text/javascript",
					"Cache-Control": "public, max-age=31536000, immutable",
				});
				response.end(LEGACY_WEB_BUNDLE);
				return;
			}
			if (request.url === "/assets/vendor-test.js") {
				response.writeHead(200, { "Content-Type": "text/javascript" });
				response.end("export const vendor = true;");
				return;
			}
			if (request.url === "/api/state") {
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end(
					JSON.stringify({
						runtimes: [{ sessionId: "session-chat", status: "idle" }],
						sessions: [{ id: "session-chat", updatedAt: settledTimestamp }],
						messagesBySession: {
							"session-chat": [{ role: "assistant", timestamp: settledTimestamp }],
						},
					}),
				);
				return;
			}
			if (request.url?.startsWith("/api/state")) {
				observedPath = request.url;
				response.writeHead(200, {
					"Content-Type": "application/json",
					"Set-Cookie": "desktop-secret=leak",
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Headers": "*",
					Connection: "X-Upstream-Secret",
					"X-Upstream-Secret": "leak",
					"X-Upstream": "yes",
				});
				response.end(JSON.stringify({ tasks: 24 }));
				return;
			}
			if (request.method === "POST" && request.url === "/api/chat") {
				directChatRequests += 1;
				response.writeHead(500).end();
				return;
			}
			if (request.method === "GET" && request.url === "/api/sessions/session-chat/stream") {
				response.writeHead(200, {
					"Content-Type": "text/event-stream",
					"X-Vercel-Ai-Ui-Message-Stream": "v1",
				});
				response.flushHeaders();
				chatStreams.push(response);
				return;
			}
			if (request.method === "POST" && request.url === "/api/sessions/session-chat/prompt") {
				chatPromptHeaders.push(request.headers);
				let requestBody = "";
				for await (const chunk of request) requestBody += chunk.toString();
				const prompt = JSON.parse(requestBody) as { requestId: string; message: string };
				chatPrompts.push(prompt);
				const accepted = prompt.requestId !== "reject-request-3";
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end(JSON.stringify({ result: { accepted } }));
				const stream = chatStreams.shift();
				if (!stream) throw new Error("Chat prompt arrived before its stream");
				if (!accepted) return;
				const index = chatPrompts.length;
				stream.write(`data: {"type":"start","messageId":"m${index}"}\n\n`);
				stream.write(`data: {"type":"text-start","id":"t${index}"}\n\n`);
				if (index === 1) {
					const multibyte = Buffer.from("中");
					stream.write(
						Buffer.concat([
							Buffer.from('data: {"type":"text-delta","id":"t1","delta":"'),
							multibyte.subarray(0, 1),
						]),
					);
					await new Promise((resolve) => setTimeout(resolve, 10));
					stream.write(
						Buffer.concat([
							multibyte.subarray(1),
							Buffer.from('文"}\n\ndata: {"type":"text-end","id":"t1"}\n\n'),
						]),
					);
				} else {
					stream.end(
						'data: {"type":"text-delta","id":"t2","delta":"second"}\n\ndata: {"type":"text-end","id":"t2"}\n\ndata: {"type":"finish"}\n\ndata: [DONE]\n\n',
					);
				}
				return;
			}
			if (request.method === "POST" && request.url === "/api/sessions/session-1/prompt") {
				for await (const chunk of request) promptBody += chunk.toString();
				response.writeHead(202, { "Content-Type": "application/json" });
				response.end(JSON.stringify({ accepted: true }));
				return;
			}
			if (request.url === "/api/sessions/session-1/stream") {
				response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
				response.flushHeaders();
				response.write("data: first\n\n");
				setTimeout(() => response.end("data: second\n\n"), 30);
				return;
			}
			response.writeHead(404).end();
		});
		const upstreamPort = await listenOnLoopback(upstream);
		const directory = temporaryDirectory();
		const workspace = join(directory, "allowed");
		mkdirSync(workspace);
		const deck = await startDeckHttpServer({
			port: 0,
			workspacePaths: [workspace],
			deviceStorePath: join(directory, "devices.json"),
			supervisor: new FakeSupervisor(),
			desktopWebPort: upstreamPort,
		});
		const base = `http://127.0.0.1:${deck.port}`;
		let upstreamClosed = false;
		try {
			const pairingPage = await fetch(base);
			expect(pairingPage.status).toBe(200);
			expect(await pairingPage.text()).not.toContain("Desktop PiDeck");
			expect((await fetch(`${base}/api/state`)).status).toBe(401);

			const pairResponse = await fetch(`${base}/api/pair`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ code: deck.pairingCode, name: "Proxy phone" }),
			});
			const cookie = pairResponse.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
			expect(pairResponse.status).toBe(201);
			expect(cookie).not.toBe("");

			const desktopPage = await fetch(base, {
				headers: { Cookie: cookie, Origin: base, Authorization: "Bearer must-not-leak" },
			});
			expect(desktopPage.status).toBe(200);
			const desktopHtml = await desktopPage.text();
			expect(desktopHtml).toContain("Desktop PiDeck");
			expect(desktopHtml).toContain("./assets/web-test.deck-compat.js");
			expect(desktopHtml).toContain("./assets/vendor-test.js");
			expect(desktopPage.headers.get("cache-control")).toBe("no-store");
			expect(observedHeaders.cookie).toBeUndefined();
			expect(observedHeaders.origin).toBeUndefined();
			expect(observedHeaders.authorization).toBeUndefined();
			expect(observedHeaders.host).toBe(`127.0.0.1:${upstreamPort}`);

			const compatBundle = await fetch(`${base}/assets/web-test.deck-compat.js`, {
				headers: { Cookie: cookie },
			});
			expect(compatBundle.status).toBe(200);
			expect(compatBundle.headers.get("cache-control")).toBe("no-store");
			expect(await compatBundle.text()).toContain("pi-deck-mobile-compat: stable throttled chat snapshots");
			expect(observedBundlePath).toBe("/assets/web-test.js");
			const vendorBundle = await fetch(`${base}/assets/vendor-test.js`, { headers: { Cookie: cookie } });
			expect(await vendorBundle.text()).toBe("export const vendor = true;");

			const stateResponse = await fetch(`${base}/api/state?view=all`, { headers: { Cookie: cookie } });
			expect(stateResponse.status).toBe(200);
			expect(await stateResponse.json()).toEqual({ tasks: 24 });
			expect(observedPath).toBe("/api/state?view=all");
			expect(stateResponse.headers.get("x-upstream")).toBe("yes");
			expect(stateResponse.headers.get("set-cookie")).toBeNull();
			expect(stateResponse.headers.get("access-control-allow-origin")).toBeNull();
			expect(stateResponse.headers.get("access-control-allow-headers")).toBeNull();
			expect(stateResponse.headers.get("x-upstream-secret")).toBeNull();

			const chatRequestBody = JSON.stringify({
				id: "session-chat",
				messages: [{ id: "user-1", role: "user", parts: [{ type: "text", text: "hello" }] }],
			});
			const chatStartedAt = Date.now();
			const chatResponse = await fetch(`${base}/api/chat`, {
				method: "POST",
				headers: {
					Cookie: cookie,
					Authorization: "Bearer must-not-leak",
					"Content-Type": "application/json",
				},
				body: chatRequestBody,
			});
			expect(chatResponse.status).toBe(200);
			const chatWire = await chatResponse.text();
			const chatDuration = Date.now() - chatStartedAt;
			expect(chatDuration).toBeGreaterThanOrEqual(5_500);
			expect(chatDuration).toBeLessThan(12_000);
			expect(chatWire).toContain('"delta":"中文"');
			expect(chatWire).not.toContain("�");
			expect(chatWire).toContain('data: {"type":"finish"}\n\n');
			expect(chatWire).toContain("data: [DONE]\n\n");

			const secondChatResponse = await fetch(`${base}/api/chat`, {
				method: "POST",
				headers: { Cookie: cookie, "Content-Type": "application/json" },
				body: JSON.stringify({
					id: "session-chat",
					messageId: "explicit-request-2",
					messages: [{ id: "user-2", role: "user", content: "second message" }],
				}),
			});
			expect(secondChatResponse.status).toBe(200);
			const secondChatWire = await secondChatResponse.text();
			expect(secondChatWire).toContain('"delta":"second"');
			expect(secondChatWire).toContain("data: [DONE]\n\n");
			const rejectedChatResponse = await fetch(`${base}/api/chat`, {
				method: "POST",
				headers: { Cookie: cookie, "Content-Type": "application/json" },
				body: JSON.stringify({
					id: "session-chat",
					messageId: "reject-request-3",
					messages: [{ role: "user", content: "rejected message" }],
				}),
			});
			const rejectedChatWire = await rejectedChatResponse.text();
			expect(rejectedChatWire).toContain('"type":"error"');
			expect(rejectedChatWire).toContain('data: {"type":"finish"}\n\n');
			expect(rejectedChatWire).toContain("data: [DONE]\n\n");
			expect(directChatRequests).toBe(0);
			expect(chatPrompts).toEqual([
				{ requestId: "user-1", message: "hello" },
				{ requestId: "explicit-request-2", message: "second message" },
				{ requestId: "reject-request-3", message: "rejected message" },
			]);
			expect(chatPrompts[0].requestId).not.toBe(chatPrompts[1].requestId);
			expect(chatPromptHeaders).toHaveLength(3);
			for (const headers of chatPromptHeaders) {
				expect(headers.cookie).toBeUndefined();
				expect(headers.authorization).toBeUndefined();
			}

			const prompt = JSON.stringify({ message: "continue on desktop" });
			const promptResponse = await fetch(`${base}/api/sessions/session-1/prompt`, {
				method: "POST",
				headers: { Cookie: cookie, "Content-Type": "application/json" },
				body: prompt,
			});
			expect(promptResponse.status).toBe(202);
			expect(promptBody).toBe(prompt);

			const streamResponse = await fetch(`${base}/api/sessions/session-1/stream`, {
				headers: { Cookie: cookie },
			});
			expect(streamResponse.status).toBe(200);
			expect(streamResponse.headers.get("content-type")).toBe("text/event-stream");
			const reader = streamResponse.body?.getReader();
			if (!reader) throw new Error("SSE response did not expose a stream");
			const first = await reader.read();
			expect(new TextDecoder().decode(first.value)).toContain("data: first");
			let remainder = "";
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				remainder += new TextDecoder().decode(chunk.value);
			}
			expect(remainder).toContain("data: second");

			await closeTestServer(upstream);
			upstreamClosed = true;
			const offline = await fetch(`${base}/api/state`, { headers: { Cookie: cookie } });
			expect(offline.status).toBe(503);
			expect(await offline.json()).toEqual({ error: "Desktop PiDeck is unavailable" });
		} finally {
			await deck.close();
			if (!upstreamClosed) await closeTestServer(upstream);
		}
	}, 15_000);

	it("enforces pairing, workspace IDs, RPC whitelist, revocation, and SSE cleanup", async () => {
		const directory = temporaryDirectory();
		const workspace = join(directory, "allowed");
		mkdirSync(workspace);
		const supervisor = new FakeSupervisor();
		let sseCount = 0;
		const deck = await startDeckHttpServer({
			port: 0,
			workspacePaths: [workspace],
			deviceStorePath: join(directory, "devices.json"),
			supervisor,
			onSseConnectionChange: (count) => {
				sseCount = count;
			},
		});
		const base = `http://127.0.0.1:${deck.port}`;
		try {
			expect(
				(
					await fetch(`${base}/api/health`, {
						headers: { Origin: base, "Sec-Fetch-Site": "cross-site" },
					})
				).status,
			).toBe(200);
			expect(
				(
					await fetch(`${base}/api/health`, {
						headers: { "Sec-Fetch-Site": "cross-site" },
					})
				).status,
			).toBe(200);
			expect(
				(
					await fetch(`${base}/api/pair`, {
						method: "POST",
						headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
						body: JSON.stringify({ code: deck.pairingCode, name: "Blocked phone" }),
					})
				).status,
			).toBe(403);
			expect((await fetch(`${base}/api/workspaces`)).status).toBe(401);
			const pairResponse = await fetch(`${base}/api/pair`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ code: deck.pairingCode, name: "Test phone" }),
			});
			expect(pairResponse.status).toBe(201);
			const cookie = pairResponse.headers.get("set-cookie")?.split(";", 1)[0];
			expect(cookie).toBeTruthy();

			const workspaces = (await (
				await fetch(`${base}/api/workspaces`, { headers: { Cookie: cookie ?? "" } })
			).json()) as {
				workspaces: Array<{ id: string }>;
			};
			const denied = await fetch(`${base}/api/instances`, {
				method: "POST",
				headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
				body: JSON.stringify({ workspaceId: "outside" }),
			});
			expect(denied.status).toBe(403);

			const spawn = await fetch(`${base}/api/instances`, {
				method: "POST",
				headers: { Cookie: cookie ?? "", "Content-Type": "application/json", "X-Request-Id": "spawn-1" },
				body: JSON.stringify({ workspaceId: workspaces.workspaces[0].id, label: "Task" }),
			});
			expect(spawn.status).toBe(201);
			await fetch(`${base}/api/instances`, {
				method: "POST",
				headers: { Cookie: cookie ?? "", "Content-Type": "application/json", "X-Request-Id": "spawn-1" },
				body: JSON.stringify({ workspaceId: workspaces.workspaces[0].id, label: "Task" }),
			});
			expect(supervisor.instances).toHaveLength(1);

			const forbiddenRpc = await fetch(`${base}/api/instances/instance-1/rpc`, {
				method: "POST",
				headers: { Cookie: cookie ?? "", "Content-Type": "application/json" },
				body: JSON.stringify({ command: "bash", commandText: "whoami" }),
			});
			expect(forbiddenRpc.status).toBe(400);
			expect(supervisor.commands).toHaveLength(0);

			const originalListInstances = supervisor.listInstances.bind(supervisor);
			supervisor.listInstances = () => {
				throw new Error("sensitive local path");
			};
			const internalError = await fetch(`${base}/api/instances`, { headers: { Cookie: cookie ?? "" } });
			expect(internalError.status).toBe(500);
			expect(await internalError.json()).toEqual({ error: "Internal server error" });
			supervisor.listInstances = originalListInstances;

			const abortController = new AbortController();
			const events = await fetch(`${base}/api/instances/instance-1/events`, {
				headers: { Cookie: cookie ?? "" },
				signal: abortController.signal,
			});
			expect(events.status).toBe(200);
			expect(sseCount).toBe(1);
			abortController.abort();
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(sseCount).toBe(0);
			expect(supervisor.streamCloses).toBe(1);

			const stop = await fetch(`${base}/api/instances/instance-1/stop`, {
				method: "POST",
				headers: { Cookie: cookie ?? "", "X-Request-Id": "stop-1" },
			});
			expect(stop.status).toBe(200);
			expect(supervisor.instances).toHaveLength(1);
			expect(supervisor.instances[0].status).toBe("stopped");
			const history = await fetch(`${base}/api/instances/instance-1/messages`, {
				headers: { Cookie: cookie ?? "" },
			});
			expect(history.status).toBe(200);
			const resume = await fetch(`${base}/api/instances/instance-1/resume`, {
				method: "POST",
				headers: { Cookie: cookie ?? "", "X-Request-Id": "resume-1" },
			});
			expect(resume.status).toBe(200);
			expect(supervisor.instances[0].status).toBe("ready");
			const remove = await fetch(`${base}/api/instances/instance-1`, {
				method: "DELETE",
				headers: { Cookie: cookie ?? "", "X-Request-Id": "delete-1" },
			});
			expect(remove.status).toBe(200);
			expect(supervisor.instances).toHaveLength(0);

			const devicesResponse = await fetch(`${base}/api/devices`, { headers: { Cookie: cookie ?? "" } });
			const devices = (await devicesResponse.json()) as { devices: Array<{ id: string }> };
			const revoke = await fetch(`${base}/api/devices/${devices.devices[0].id}`, {
				method: "DELETE",
				headers: { Cookie: cookie ?? "", "X-Request-Id": "revoke-1" },
			});
			expect(revoke.status).toBe(200);
			expect((await fetch(`${base}/api/workspaces`, { headers: { Cookie: cookie ?? "" } })).status).toBe(401);
		} finally {
			await deck.close();
		}
	}, 15_000);
});
