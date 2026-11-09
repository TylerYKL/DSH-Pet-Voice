// DSH Voice Pet Plugin - Host half (cordis plugin)
// Listens to official session events and exposes a pollable event feed
// plus the voice asset files to the Web GUI client half.
//
// Verified contract (from @linxin666/dsh-pet @ 0.4.15):
//   export { name, inject, apply }
//   ctx.on("session/event", (session, event) => ...)
//   event.type ∈ turn/start | step/start | assistant/message | tool/call
//              | tool/result | turn/end | assistant-stream
//   turn/end: event.data.reason.kind ∈ completed|error|max-tokens|interrupted|blocked|aborted
//   ctx.on("session/disposed", (session) => ...)
//   ctx.webServer.register({ kind: "exact"|"prefix", path, handler(req, res) })

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const VOICES_DIR = join(PACKAGE_ROOT, "assets", "voices");

/** Ring buffer of projected scenarios; ids grow forever for client cursors. */
const MAX_BUFFER = 32;
let latestId = 0;
const buffer = [];

function pushScenario(scenario) {
	latestId += 1;
	buffer.push({
		id: latestId,
		scenario,
		ts: Date.now()
	});
	if (buffer.length > MAX_BUFFER) buffer.shift();
}

/** Project one official session event into voice scenarios. */
function projectSessionEvent(event) {
	switch (event?.type) {
		case "turn/end": {
			const kind = event.data?.reason?.kind;
			if (kind === "completed") pushScenario("task_done");
			else if (kind === "error" || kind === "max-tokens") pushScenario("error");
			// interrupted/blocked/aborted are quiet by design
			return;
		}
		default:
			return; // step/tool activity is too chatty for voice
	}
}

/** Loopback-only guard, mirroring dsh-pet's route guard. */
function guard(req, res) {
	const remote = req.socket?.remoteAddress ?? "";
	const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
	if (!loopback) {
		res.writeHead(403, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: false, error: "forbidden: loopback-only" }));
		return false;
	}
	return true;
}

function writeJson(res, status, value) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(value));
}

const AUDIO_MIME = new Map([
	[".mp3", "audio/mpeg"],
	[".wav", "audio/wav"],
	[".ogg", "audio/ogg"]
]);

/** Serve one voice file under /api/voice-pet/voices/. */
function makeVoiceHandler() {
	return (req, res) => {
		if (!guard(req, res)) return;
		const url = new URL(req.url ?? "/", "http://voice-pet.local");
		const rel = decodeURIComponent(url.pathname.slice("/api/voice-pet/voices/".length));
		const resolved = normalize(join(VOICES_DIR, rel));
		if (!resolved.startsWith(VOICES_DIR + sep)) {
			writeJson(res, 403, { ok: false, error: "forbidden" });
			return;
		}
		if (!existsSync(resolved)) {
			writeJson(res, 404, { ok: false, error: "not-found" });
			return;
		}
		const ext = resolved.slice(resolved.lastIndexOf(".")).toLowerCase();
		res.writeHead(200, {
			"content-type": AUDIO_MIME.get(ext) ?? "application/octet-stream",
			"content-length": statSync(resolved).size,
			"cache-control": "no-cache"
		});
		res.end(readFileSync(resolved));
	};
}

const name = "voice-pet";
const inject = ["webServer", "loader"];

const apply = (ctx) => {
	ctx.on("session/event", (session, event) => {
		try {
			projectSessionEvent(event);
		} catch (error) {
			ctx.console?.warn?.("[VoicePet] project event failed:", error);
		}
	});
	ctx.on("session/disposed", () => {
		try {
			pushScenario("session_end");
		} catch {}
	});

	const routes = [
		{
			kind: "exact",
			path: "/api/voice-pet/events",
			handler: (req, res) => {
				if (!guard(req, res)) return;
				const url = new URL(req.url ?? "/", "http://voice-pet.local");
				const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0;
				writeJson(res, 200, { ok: true, latest: latestId, events: buffer.filter((ev) => ev.id > after) });
			}
		},
		{
			kind: "prefix",
			path: "/api/voice-pet/voices",
			handler: makeVoiceHandler()
		},
		{
			kind: "exact",
			path: "/api/voice-pet/debug",
			handler: (req, res) => {
				if (!guard(req, res)) return;
				const out = { ok: true };
				try {
					out.loaderEntries = ctx.loader.entries().map((entry) => ({
						name: entry.options?.name,
						disabled: entry.disabled === true,
						mounted: entry.fiber !== void 0
					}));
				} catch (error) {
					out.loaderEntries = `error: ${String(error)}`;
				}
				try {
					const cm = ctx.get?.("clientModules");
					if (cm?.graph) {
						const graph = cm.graph();
						out.clientModules = {
							release: cm.release,
							graphRev: graph.rev,
							entries: graph.entries,
							batches: graph.batches
						};
					} else {
						out.clientModules = "service unavailable";
					}
				} catch (error) {
					out.clientModules = `error: ${String(error)}`;
				}
				writeJson(res, 200, out);
			}
		}
	];
	const disposers = routes.map((route) => ctx.webServer.register(route));
	ctx.effect(() => () => {
		for (const dispose of disposers) dispose();
	}, "voice-pet: routes");
};

export { apply, inject, name };
