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

// ---- LLM 语音降级链路（voice-pet LLM voice）----
// 浏览器不能直接调 magpie 网关（CORS/密钥），这里由宿主 Node 侧代理。
// 优先级：LLM 语音开启 → 调网关生成自然回复 → 经 HA piper 在 Echo Dot 播出；
//         LLM 关闭或失败 → 自动降级到原有的 Voice Prompt 场景音效。
const MAGPIE_BASE = process.env.MAGPIE_BASE || "http://127.0.0.1:3425/v1";
const MAGPIE_KEY = process.env.MAGPIE_GATEWAY_KEY || "";
const LLM_MODEL = process.env.VOICE_PET_LLM_MODEL || "kilo/kilo-auto/free";
const LLM_TIMEOUT_MS = Number.parseInt(process.env.VOICE_PET_LLM_TIMEOUT_MS || "8000", 10);

/** 每个场景对应的 LLM 系统提示词：只输出一句适合小喇叭播的口语回复。 */
const SCENARIO_PROMPTS = {
	task_done: "你是桌面上的语音宠物。任务完成了，用一句自然的中文口语提醒用户，最多 20 字，不要 markdown、不要客套开头、不要反问。",
	error: "你是桌面上的语音宠物。任务失败或超时了，用一句自然的中文口语提醒用户注意，最多 20 字，语气平稳不惊慌。",
	session_end: "你是桌面上的语音宠物。会话结束了，用一句自然的中文口语道别，最多 20 字。",
	startup: "你是桌面上的语音宠物。系统刚启动，用一句自然的中文口语问候用户（按当时时段），最多 20 字，不要 markdown。",
	conversation: "你是 Echo Dot 音箱上的中文语音助手。根据用户的话直接口语回答：不要 markdown、不要编号列表、不要星号、不要客套开场，最多 40 字，适合直接朗读。"
};

async function llmHealth() {
	try {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), 4000);
		const res = await fetch(MAGPIE_BASE.replace(/\/v1$/, "") + "/v1/models", {
			method: "GET",
			headers: MAGPIE_KEY ? { Authorization: "Bearer " + MAGPIE_KEY } : {},
			signal: ctrl.signal
		});
		clearTimeout(t);
		return res.ok;
	} catch {
		return false;
	}
}

async function llmGenerate(scenario, userText) {
	const systemPrompt = SCENARIO_PROMPTS[scenario] || SCENARIO_PROMPTS.task_done;
	const messages = [
		{ role: "system", content: systemPrompt },
		{ role: "user", content: (userText && userText.trim()) ? userText.trim() : "请给出这个场景的回复。" }
	];
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
	let res;
	try {
		res = await fetch(MAGPIE_BASE + "/chat/completions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(MAGPIE_KEY ? { Authorization: "Bearer " + MAGPIE_KEY } : {})
			},
			body: JSON.stringify({ model: LLM_MODEL, messages, max_tokens: 800, stream: false }),
			signal: ctrl.signal
		});
	} catch {
		return { ok: false, error: "llm-unreachable" };
	} finally {
		clearTimeout(t);
	}
	if (!res.ok) {
		return { ok: false, error: "llm-http-" + res.status };
	}
	let data;
	try {
		data = await res.json();
	} catch {
		return { ok: false, error: "llm-bad-json" };
	}
	const text = data?.choices?.[0]?.message?.content;
	if (typeof text !== "string" || !text.trim()) {
		return { ok: false, error: "llm-empty" };
	}
	return { ok: true, text: stripForSpeech(text.trim()) };
}

/** 把 LLM 的 markdown/编号/表情清洗成适合 TTS 朗读的纯文本。 */
function stripForSpeech(text) {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[*_`#>|~]+/g, "")
		.replace(/^\s*\d+[.)、]\s*/gm, "")
		.replace(/^\s*[-•]\s+/gm, "")
		.replace(/\s+/g, " ")
		.trim();
}

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
	const llmRoutes = [
		{
			kind: "exact",
			path: "/api/voice-pet/llm/health",
			handler: (req, res) => {
				if (!guard(req, res)) return;
				(async () => {
					const ok = await llmHealth();
					writeJson(res, 200, { ok, model: LLM_MODEL, magpie: MAGPIE_BASE });
				})().catch(() => writeJson(res, 500, { ok: false, error: "llm-health-failed" }));
			}
		},
		{
			kind: "exact",
			path: "/api/voice-pet/llm/text",
			handler: (req, res) => {
				if (!guard(req, res)) return;
				let body = {};
				try {
					const chunks = [];
					req.on("data", (c) => chunks.push(c));
					req.on("end", async () => {
						try {
							const raw = Buffer.concat(chunks).toString("utf-8");
							if (raw) body = JSON.parse(raw);
						} catch {
							body = {};
						}
						const scenario = body?.scenario || "task_done";
						const result = await llmGenerate(scenario, body?.userText || "");
						writeJson(res, result.ok ? 200 : 503, result);
					});
				} catch (error) {
					writeJson(res, 500, { ok: false, error: String(error) });
				}
			}
		}
	];
	const disposers = [...routes, ...llmRoutes].map((route) => ctx.webServer.register(route));
	ctx.effect(() => () => {
		for (const dispose of disposers) dispose();
	}, "voice-pet: routes");
};

export { apply, inject, name };
