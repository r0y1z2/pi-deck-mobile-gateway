import { getDeckDevicesPath } from "./config.ts";
import { startDeckHttpServer } from "./deck/http-server.ts";
import { startServerRuntime, waitForServerShutdown } from "./serve.ts";
import { supervisor } from "./supervisor.ts";

export interface DeckOptions {
	port: number;
	workspacePaths: string[];
}

export async function deck(options: DeckOptions): Promise<void> {
	const runtime = await startServerRuntime();
	let http: Awaited<ReturnType<typeof startDeckHttpServer>>;
	try {
		http = await startDeckHttpServer({
			port: options.port,
			workspacePaths: options.workspacePaths,
			deviceStorePath: getDeckDevicesPath(),
			supervisor,
		});
	} catch (error) {
		await runtime.close();
		throw error;
	}

	console.log(`Pi Deck listening on http://127.0.0.1:${http.port}`);
	console.log(`Pairing code: ${http.pairingCode} (valid for 10 minutes, one use)`);
	console.log(`Tailscale: tailscale serve --bg http://127.0.0.1:${http.port}`);
	await waitForServerShutdown(async () => {
		await http.close();
		await runtime.close();
	});
}
