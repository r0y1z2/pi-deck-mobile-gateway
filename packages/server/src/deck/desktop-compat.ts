const WEB_ENTRY_PATTERN = /\.\/assets\/(web-[A-Za-z0-9_-]+)\.js/;
const COMPAT_WEB_ASSET_PATTERN = /^\/assets\/(web-[A-Za-z0-9_-]+)\.deck-compat\.js$/;

const CHAT_RECREATION_BLOCK = `  if (shouldRecreateChat) {
    chatRef.current = "chat" in options ? options.chat : new Chat(chatOptions);
  }
`;

const LEGACY_MESSAGES_BLOCK = `  const subscribeToMessages = reactExports.useCallback(
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
`;

const STABLE_MESSAGES_BLOCK = `  /* pi-deck-mobile-compat: stable throttled chat snapshots */
  const chat = chatRef.current;
  const messagesSnapshotRef = reactExports.useRef({
    chat,
    messages: chat.messages
  });
  if (messagesSnapshotRef.current.chat !== chat) {
    messagesSnapshotRef.current = { chat, messages: chat.messages };
  }
  const subscribeToMessages = reactExports.useCallback(
    (update) => {
      let isSubscribed = true;
      const updateMessages = () => {
        if (!isSubscribed || messagesSnapshotRef.current.chat !== chat) return;
        messagesSnapshotRef.current = { chat, messages: chat.messages };
        update();
      };
      const unsubscribe = chat["~registerMessagesCallback"](updateMessages, throttleWaitMs);
      messagesSnapshotRef.current = { chat, messages: chat.messages };
      return () => {
        isSubscribed = false;
        unsubscribe();
      };
    },
    [chat, throttleWaitMs]
  );
  const getMessagesSnapshot = reactExports.useCallback(
    () => messagesSnapshotRef.current.messages,
    []
  );
  const messages = reactExports.useSyncExternalStore(
    subscribeToMessages,
    getMessagesSnapshot,
    getMessagesSnapshot
  );
  const subscribeToStatus = reactExports.useCallback(
    (update) => chat["~registerStatusCallback"](() => {
      if (messagesSnapshotRef.current.chat !== chat) return;
      if (chat.status === "ready" || chat.status === "error") {
        messagesSnapshotRef.current = { chat, messages: chat.messages };
      }
      update();
    }),
    [chat]
  );
  const getStatusSnapshot = reactExports.useCallback(() => chat.status, [chat]);
  const status = reactExports.useSyncExternalStore(
    subscribeToStatus,
    getStatusSnapshot,
    getStatusSnapshot
  );
`;

const LEGACY_WEB_CHAT_OPTIONS = `  const { messages, sendMessage, status, stop, setMessages, error } = useChat({
    id: activeSessionId,
    transport: new DefaultChatTransport({ api: "/api/chat" })
  });`;

const THROTTLED_WEB_CHAT_OPTIONS = `  const { messages, sendMessage, status, stop, setMessages, error } = useChat({
    id: activeSessionId,
    throttle: 100,
    transport: new DefaultChatTransport({ api: "/api/chat" })
  });`;

const STREAMING_MESSAGE_CACHE_BLOCK = `  reactExports.useEffect(() => {
    if (!activeSessionId || !streaming) return;
    messagesBySessionRef.current[activeSessionId] = messages;
    loadedSessionsRef.current.add(activeSessionId);
  }, [messages, activeSessionId, streaming]);`;

const STREAM_COMPLETION_RECOVERY_BLOCK = `${STREAMING_MESSAGE_CACHE_BLOCK}
  reactExports.useEffect(() => {
    /* pi-deck-mobile-compat: reconcile a missing chat stream terminator */
    if (!streaming || !activeSessionId || (activeRuntime == null ? void 0 : activeRuntime.status) !== "idle") return;
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || lastMessage.role !== "assistant") return;
    const timer = setTimeout(() => {
      if (activeSessionIdRef.current === activeSessionId) void stop();
    }, 6e3);
    return () => clearTimeout(timer);
  }, [streaming, activeSessionId, activeRuntime == null ? void 0 : activeRuntime.status, messages, stop]);`;

export class DesktopCompatibilityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DesktopCompatibilityError";
	}
}

function replaceExactlyOnce(source: string, expected: string, replacement: string, description: string): string {
	const first = source.indexOf(expected);
	if (first < 0 || source.indexOf(expected, first + expected.length) >= 0) {
		throw new DesktopCompatibilityError(`Desktop PiDeck ${description} marker did not match exactly once`);
	}
	return `${source.slice(0, first)}${replacement}${source.slice(first + expected.length)}`;
}

export function rewriteDesktopHtml(html: string): string {
	const match = html.match(WEB_ENTRY_PATTERN);
	if (!match || html.slice((match.index ?? 0) + match[0].length).match(WEB_ENTRY_PATTERN)) {
		throw new DesktopCompatibilityError("Desktop PiDeck web entry marker did not match exactly once");
	}
	return html.replace(WEB_ENTRY_PATTERN, `./assets/${match[1]}.deck-compat.js`);
}

export function desktopCompatUpstreamPath(pathname: string): string | undefined {
	const match = pathname.match(COMPAT_WEB_ASSET_PATTERN);
	return match ? `/assets/${match[1]}.js` : undefined;
}

export function rewriteDesktopWebBundle(bundle: string): string {
	if (
		bundle.includes("pi-deck-mobile-compat: stable throttled chat snapshots") &&
		bundle.includes("pi-deck-mobile-compat: reconcile a missing chat stream terminator")
	) {
		return bundle;
	}
	let rewritten = replaceExactlyOnce(
		bundle,
		`${CHAT_RECREATION_BLOCK}${LEGACY_MESSAGES_BLOCK}`,
		`${CHAT_RECREATION_BLOCK}${STABLE_MESSAGES_BLOCK}`,
		"AI SDK message snapshot",
	);
	rewritten = replaceExactlyOnce(rewritten, LEGACY_WEB_CHAT_OPTIONS, THROTTLED_WEB_CHAT_OPTIONS, "WebChatApp useChat");
	rewritten = replaceExactlyOnce(
		rewritten,
		STREAMING_MESSAGE_CACHE_BLOCK,
		STREAM_COMPLETION_RECOVERY_BLOCK,
		"WebChatApp stream completion recovery",
	);
	return rewritten;
}
