window.__ModuleLoader__.load({ id: "dsh-plugin-voice-pet", factory: (require) => {

	var module = { exports: {} };
	var exports = module.exports;
	Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

	const react_jsx_runtime = require("react/jsx-runtime");
	const react = require("react");

	// DSH Voice Pet Plugin - Client half
	// Only the voice module is kept. Pet-related UI (floating pet, figures, GIFs)
	// has been removed because pet functionality lives in other plugins.
	// DSH Settings ("dsh-pet-voice") 标签页：总开关 + 每个场景独立开关 + 音量 + Echo Dot 输出/麦克风。
	// 总开关关闭时，所有单一开关进入 disabled 状态，禁止操作。
	// Client plugin contract: exports { name, inject, apply }.

	const POLL_MS = 1000;
	const DEBOUNCE_MS = 30000;
	const PLUGIN_ID = "dsh-plugin-voice-pet";
	const NS = "settings.voicePet";

	// Echo Dot / ASR bridge (asr_server.py v2, ESPHome API route)
	const ASR_BASE = "http://127.0.0.1:8767";
	const MIC_POLL_MS = 3000; // poll mic transcription every 3s when enabled

	// LLM 语音降级链路开关 key
	const LLM_VOICE_KEY = "llmVoice";     // LLM 语音功能总开关
	const VOICE_PROMPT_KEY = "enabled";   // 原有 Voice Prompt 场景音效总开关
	const LLM_PROXY = "/api/voice-pet/llm/text";   // 宿主半代理到 magpie 网关
	const LLM_HEALTH = "/api/voice-pet/llm/health";
	const ASR_SPEAK = "http://127.0.0.1:8767/speak_text";

	const FILE_MAP = {
		cute: { complete: "cute_complete.mp3", error: "cute_error.mp3", idle: "cute_idle.mp3" },
		mech: { complete: "mech_complete.mp3", error: "mech_error.mp3", idle: "mech_idle.mp3" },
		tech: {
			complete: "tech_task_done.mp3",
			complete_2: "tech_task_done_2.mp3",
			error: "tech_error.mp3",
			error_2: "tech_error_2.mp3",
			idle: "tech_idle.mp3",
			idle_2: "tech_idle_2.mp3",
			startup: "tech_startup.mp3",
			startup_2: "tech_startup_2.mp3",
			session_end: "tech_session_end.mp3",
			session_end_2: "tech_session_end_2.mp3"
		}
	};

	const SCENARIO_FILE_KEY = {
		task_done: "complete",
		task_done_2: "complete_2",
		error: "error",
		error_2: "error_2",
		session_end: "session_end",
		session_end_2: "session_end_2"
	};

	// 每个场景的独立开关 key
	const SCENARIO_KEYS = ["task_done", "error", "session_end", "startup"];

	// Echo Dot 开关 key
	const ECHO_OUTPUT_KEY = "echoDotOutput";   // 输出到 Echo Dot 扬声器
	const ECHO_MIC_KEY = "echoDotMic";         // 从 Echo Dot 麦克风语音输入

	function speakText(scenario) {
		const map = {
			task_done: "任务已完成。请确认结果。",
			task_done_2: "执行结束。所有指令已处理完毕。",
			error: "检测到异常。请立即检查日志。",
			error_2: "警告。操作未成功，请重试。",
			session_end: "会话已结束。感谢使用。",
			session_end_2: "连接断开。随时欢迎您回来。"
		};
		return map[scenario] ?? "";
	}

	// ---------- preferences ----------

	function loadPrefs() {
		try {
			return JSON.parse(localStorage.getItem(PLUGIN_ID + ":prefs") || "{}");
		} catch {
			return {};
		}
	}

	function savePrefs(prefs) {
		try {
			localStorage.setItem(PLUGIN_ID + ":prefs", JSON.stringify(prefs));
		} catch {}
	}

	// ---------- locales ----------

	const zh = {
		title: "语音宠物",
		enabled: "启用语音提示",
		volume: "音量",
		scenario_task_done: "任务完成",
		scenario_error: "任务失败/超时",
		scenario_session_end: "会话结束",
		scenario_startup: "启动问候",
		scenario_disabled_hint: "总开关已关闭，所有语音均静音",
		llm_voice: "LLM 语音（自然回复）",
	llm_voice_hint: "由 LLM 生成自然回复再经 Echo Dot 播出；开启后优先于下方场景音效，失败自动降级",
		llm_voice_off_hint: "LLM 语音已关闭，仅使用下方场景音效",
		llm_unavailable: "LLM 网关不可用（连接中断/配额耗尽），已自动降级到场景音效",
		llm_checking: "检测 LLM 网关…",
		llm_ok: "LLM 网关就绪",
		llm_off: "LLM 语音已关闭",
		echo_output: "输出到 Echo Dot 扬声器",
		echo_output_hint: "通过本地 asr_server.py 经 ESPHome API 在 Echo Dot 上播放语音（需本地运行 asr_server.py，127.0.0.1:8767）",
		echo_mic: "启用 Echo Dot 麦克风语音输入",
		echo_mic_hint: "从 Echo Dot 麦克风转录语音为文字并插入对话输入框（需本地运行 asr_server.py，127.0.0.1:8767）",
		asr_status: "ASR 桥接服务器",
		asr_ready: "就绪（Echo Dot 已连接）",
		asr_esph_down: "已启动但 Echo Dot 未连接（检查 192.168.0.126:6053）",
		asr_unreachable: "未运行（请启动 asr_server.py）",
		asr_checking: "检测中…",
		followup_title: "Echo Dot 续听（Wake 后连续对话）",
		followup_time: "回复后静默等待（秒，0-30）",
		followup_time_hint: "说完话停顿不超过该秒数，它会继续等你说下一句；一开口立即打断进识别",
		followup_rounds: "最多连续续听轮数（0-10）",
		followup_hint: "静默累计到轮数上限后回到待唤醒状态，需再说唤醒词。固件上限：30 秒 × 10 轮",
		followup_save: "应用到设备",
		followup_saving: "应用中…",
		followup_saved: "已生效 ✓",
		followup_failed: "应用失败"
	};
	const en = {
		title: "Voice Pet",
		enabled: "Enable voice prompts",
		volume: "Volume",
		scenario_task_done: "Task completed",
		scenario_error: "Task failed / timeout",
		scenario_session_end: "Session ended",
		scenario_startup: "Startup greeting",
		scenario_disabled_hint: "Master switch is off — all voice is silent",
		echo_output: "Output to Echo Dot speaker",
		echo_output_hint: "Play on Echo Dot via local asr_server.py using the ESPHome API (requires asr_server.py at 127.0.0.1:8767)",
		echo_mic: "Enable Echo Dot microphone voice input",
		echo_mic_hint: "Transcribe Echo Dot microphone speech into the composer (requires asr_server.py at 127.0.0.1:8767)",
		asr_status: "ASR bridge server",
		asr_ready: "Ready (Echo Dot connected)",
		asr_esph_down: "Running but Echo Dot not connected (check 192.168.0.126:6053)",
		asr_unreachable: "Not running (start asr_server.py)",
		asr_checking: "Checking…",
		followup_title: "Echo Dot follow-up (continuous conversation)",
		followup_time: "Silence window after each reply (seconds, 0-30)",
		followup_time_hint: "It keeps listening after a reply; start speaking anytime and it picks up immediately",
		followup_rounds: "Max follow-up rounds in a row (0-10)",
		followup_hint: "After the round cap it returns to wake-word idle. Firmware limits: 30s × 10 rounds",
		followup_save: "Apply to device",
		followup_saving: "Applying…",
		followup_saved: "Applied ✓",
		followup_failed: "Apply failed",
		llm_voice: "LLM voice (natural replies)",
		llm_voice_hint: "LLM generates a natural reply and plays it on Echo Dot; takes priority over the scene sound effects below, falling back automatically on failure",
		llm_voice_off_hint: "LLM voice is off — scene sound effects only",
		llm_unavailable: "LLM gateway unavailable (connection lost / quota exhausted); auto-falling back to scene sound effects",
		llm_checking: "Checking LLM gateway…",
	llm_ok: "LLM gateway ready",
	llm_off: "LLM voice is off"
	};

	// ---------- voice engine ----------

	function createVoiceEngine(prefs) {
		let audio = null;
		const available = new Map(); // file -> bool

		async function probe(file) {
			try {
				const res = await fetch(`/api/voice-pet/voices/${file}`, {
					method: "HEAD",
					signal: AbortSignal.timeout(4000)
				});
				available.set(file, res.ok);
			} catch {
				available.set(file, false);
			}
		}

		async function init() {
			const all = new Set();
			for (const scenarios of Object.values(FILE_MAP)) {
				for (const file of Object.values(scenarios)) all.add(file);
			}
			await Promise.all([...all].map(probe));
		}

		function playFileLocal(file, volume) {
			return new Promise((resolve, reject) => {
				if (audio) {
					audio.pause();
					audio.src = "";
				}
				const a = new Audio(`/api/voice-pet/voices/${file}`);
				audio = a;
				a.volume = volume;
				a.onended = () => {
					audio = null;
					resolve();
				};
				a.onerror = () => {
					audio = null;
					reject(new Error("audio-error"));
				};
				a.play().catch(reject);
			});
		}

		/** 输出到 Echo Dot 扬声器：POST MP3 字节到 asr_server /play → ESPHomeediaPlayer */
		async function playFileEchoDot(file, volume) {
			try {
				const res = await fetch(`/api/voice-pet/voices/${file}`, { signal: AbortSignal.timeout(8000) });
				if (!res.ok) throw new Error(`fetch ${res.status}`);
				const bytes = await res.arrayBuffer();
				const resp = await fetch(`${ASR_BASE}/play?name=vp_${encodeURIComponent(file)}`, {
					method: "POST",
					headers: { "Content-Type": "audio/mpeg" },
					body: bytes,
					signal: AbortSignal.timeout(8000)
				});
				if (!resp.ok) throw new Error(`play ${resp.status}`);
				return;
			} catch (e) {
				console.log("[VoicePet] Echo Dot output failed, falling back to local:", e?.message ?? e);
				throw e;
			}
		}

		function speakWebSpeech(text) {
			if (!("speechSynthesis" in window)) return Promise.resolve();
			const presets = {
				cute: { rate: 1.25, pitch: 1.5 },
				mech: { rate: 0.9, pitch: 0.8 },
				tech: { rate: 1.05, pitch: 1.05 }
			};
			const p = presets[prefs.style] ?? presets.tech;
			return new Promise((resolve) => {
				const u = new SpeechSynthesisUtterance(text);
				u.lang = "zh-CN";
				u.rate = p.rate;
				u.pitch = p.pitch;
				u.volume = prefs.volume;
				const voices = speechSynthesis.getVoices();
				const zhVoice = voices.find((v) => v.lang.startsWith("zh")) ?? voices.find((v) => v.lang.includes("CN"));
				if (zhVoice) u.voice = zhVoice;
				u.onend = () => resolve();
				u.onerror = () => resolve();
				speechSynthesis.cancel();
				speechSynthesis.speak(u);
			});
		}

		async function speakScenario(scenario, volume) {
			const variants = [scenario, scenario + "_2"];
			const pickable = variants.filter((v) => {
				const file = FILE_MAP[prefs.style]?.[SCENARIO_FILE_KEY[v]];
				return file && available.get(file);
			});
			const chosen = pickable.length > 0 ? pickable[Math.floor(Math.random() * pickable.length)] : null;
			if (chosen) {
				const file = FILE_MAP[prefs.style][SCENARIO_FILE_KEY[chosen]];
				try {
					if (prefs[ECHO_OUTPUT_KEY]) {
						await playFileEchoDot(file, volume);
						return;
					}
					await playFileLocal(file, volume);
					return;
				} catch {
					// fall through to Web Speech
				}
			}
			return speakWebSpeech(speakText(chosen ?? scenario));
		}

		/** LLM 语音：调宿主半代理到 magpie 网关生成自然回复文本，再经 HA piper 在 Echo Dot 播出。
		 *  失败/关闭时返回 false，由调用方降级到原有 Voice Prompt。 */
		async function speakLLM(scenario, userText) {
			if (!prefs[LLM_VOICE_KEY]) return false;
			try {
				const res = await fetch(LLM_PROXY, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ scenario, userText: userText || "" }),
					signal: AbortSignal.timeout(12000)
				});
				if (!res.ok) return false;
				const data = await res.json();
				if (!data?.ok || !data?.text) return false;
				const text = data.text;
				// 优先 Echo Dot（经 HA piper），失败回退本地 Web Speech
				try {
					const speakRes = await fetch(ASR_SPEAK, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ text }),
						signal: AbortSignal.timeout(8000)
					});
					if (speakRes.ok) return true;
				} catch {}
				await speakWebSpeech(text);
				return true;
			} catch {
				return false;
			}
		}

		/** 根据本地电脑时间判断时段。 */
		function getTimeOfDay() {
			const h = new Date().getHours();
			if (h >= 5 && h < 9) return "morning";
			if (h >= 9 && h < 12) return "forenoon";
			if (h >= 12 && h < 14) return "noon";
			if (h >= 14 && h < 18) return "afternoon";
			if (h >= 18 && h < 22) return "evening";
			return "night";
		}

		const STARTUP_GREETINGS = {
			morning: ["早安，欢迎回来。系统已就绪。", "早上好，今日已开始，祝您顺利。"],
			forenoon: ["上午好，系统已就绪。", "上午时分，有什么我可以帮您的？"],
			noon: ["中午好，用餐过了吗？系统已准备就绪。", "正午好，休息得怎么样？"],
			afternoon: ["下午好，系统运行正常。", "下午时分，继续加油。"],
			evening: ["晚上好，欢迎回来。", "傍晚好，今日工作进行得如何？"],
			night: ["夜深了，还在工作吗？系统已就绪。", "深夜好，注意休息，系统已准备就绪。"]
		};

		async function speakStartup(volume) {
			const period = getTimeOfDay();
			const greetings = STARTUP_GREETINGS[period];
			const text = greetings[Math.floor(Math.random() * greetings.length)];

			const audioKey = `startup_${period}`;
			const file = FILE_MAP[prefs.style]?.[audioKey];
			if (file && available.get(file)) {
				try {
					if (prefs[ECHO_OUTPUT_KEY]) {
						await playFileEchoDot(file, volume);
						return;
					}
					await playFileLocal(file, volume);
					return;
				} catch {} // fall through to Web Speech
			}
			const legacyFile = FILE_MAP[prefs.style]?.startup;
			if (legacyFile && available.get(legacyFile)) {
				try {
					if (prefs[ECHO_OUTPUT_KEY]) {
						await playFileEchoDot(legacyFile, volume);
						return;
					}
					await playFileLocal(legacyFile, volume);
					return;
				} catch {} // fall through to Web Speech
			}
			return speakWebSpeech(text);
		}

		function stop() {
			if (audio) {
				audio.pause();
				audio.src = "";
				audio = null;
			}
			if ("speechSynthesis" in window) {
				try {
					speechSynthesis.cancel();
				} catch {}
			}
		}

		return { init, speakScenario, speakStartup, stop, playFileEchoDot };
	}

	// ---------- Echo Dot microphone input ----------

	/** 从 ASR 桥接服务器长轮询获取转录文本（ESPHome last_heard，带 after 光标） */
	let micCursor = "";
	/** 根层轮询共享状态：设置页 UI 只读显示，轮询生命周期由 apply(ctx) 管辖 */
	const micState = { listening: false, lastText: "" };
	/** 转写投递重试队列：composer 暂不在 DOM（如设置页开着）时暂存，下一轮重试 */
	let pendingInsert = "";
	async function transcribeMic() {
		try {
			const res = await fetch(`${ASR_BASE}/transcribe?after=${encodeURIComponent(micCursor)}`, { signal: AbortSignal.timeout(30000) });
			if (!res.ok) return null;
			const data = await res.json();
			if (data.cursor) micCursor = data.cursor;
			return data.text || "";
		} catch {
			return null;
		}
	}

	/** 将文本插入到 DSH 对话 composer 的 contenteditable 输入框；末尾补一个空格，连续语音转写不会粘成一块 */
	function insertTextIntoComposer(text) {
		if (!text) return false;
		const el = document.querySelector('[data-composer-input="true"], [contenteditable="true"]');
		if (!el) return false;
		const payload = text + " ";
		try {
			el.focus();
			if (document.execCommand) {
				document.execCommand("insertText", false, payload);
				el.dispatchEvent(new Event("input", { bubbles: true }));
			} else {
				const before = el.textContent || "";
				el.textContent = before + (before ? " " : "") + payload;
				el.dispatchEvent(new Event("input", { bubbles: true }));
			}
			return true;
		} catch {
			return false;
		}
	}

	// ---------- Settings tab component (DSH Settings) ----------

	function VoicePetSettings({ t }) {
		const load = () => loadPrefs();
		const [prefs, setPrefs] = react.useState(() => {
			const p = load();
			return {
				enabled: p.enabled ?? true,
				[LLM_VOICE_KEY]: p[LLM_VOICE_KEY] ?? false,
				[VOICE_PROMPT_KEY]: p[VOICE_PROMPT_KEY] ?? true,
				volume: p.volume ?? 0.9,
				task_done: p.task_done ?? true,
				error: p.error ?? true,
				session_end: p.session_end ?? true,
				startup: p.startup ?? true,
				[ECHO_OUTPUT_KEY]: p[ECHO_OUTPUT_KEY] ?? false,
				[ECHO_MIC_KEY]: p[ECHO_MIC_KEY] ?? false
			};
		});
		const [asrStatus, setAsrStatus] = react.useState("checking");
		const [micListening, setMicListening] = react.useState(false);
		const [micLastText, setMicLastText] = react.useState("");
		const [fuTime, setFuTime] = react.useState("");
		const [fuRounds, setFuRounds] = react.useState("");
		const [fuState, setFuState] = react.useState("idle"); // idle | saving | saved | failed
		const [llmState, setLlmState] = react.useState("checking"); // checking | ok | off | unavailable

		const writePrefs = (patch) => {
			const next = { ...prefs, ...patch };
			setPrefs(next);
			savePrefs(next);
		};

		// 检查 ASR 服务器状态
		react.useEffect(() => {
			let mounted = true;
			(async () => {
				try {
					const res = await fetch(`${ASR_BASE}/status`, { signal: AbortSignal.timeout(5000) });
					if (res.ok) {
						const data = await res.json();
						const st = data.esph === "up" ? "ready" : (data.esph === "down" ? "esph-down" : "unreachable");
						if (mounted) setAsrStatus(st);
					} else {
						if (mounted) setAsrStatus("unreachable");
					}
				} catch {
					if (mounted) setAsrStatus("unreachable");
				}
			})();
			return () => { mounted = false; };
		}, []);

		// 读取 Echo Dot 续听设置（asr 就绪时拉一次；来自 HA number 实体）
		react.useEffect(() => {
			if (asrStatus !== "ready") return;
			let mounted = true;
			(async () => {
				try {
					const res = await fetch(`${ASR_BASE}/followup`, { signal: AbortSignal.timeout(8000) });
					if (!res.ok) return;
					const data = await res.json();
					if (mounted && data.ok) {
						setFuTime(data.follow_up_time === null ? "" : String(data.follow_up_time));
						setFuRounds(data.follow_ups_in_a_row === null ? "" : String(data.follow_ups_in_a_row));
					}
				} catch {}
			})();
			return () => { mounted = false; };
		}, [asrStatus]);

		const applyFollowup = async () => {
			if (fuState === "saving") return;
			setFuState("saving");
			try {
				const body = {};
				if (fuTime !== "") body.follow_up_time = Number(fuTime);
				if (fuRounds !== "") body.follow_ups_in_a_row = Number(fuRounds);
				const res = await fetch(`${ASR_BASE}/followup`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(15000)
				});
				const data = await res.json();
				if (data.ok) {
					setFuTime(String(data.follow_up_time));
					setFuRounds(String(data.follow_ups_in_a_row));
					setFuState("saved");
					setTimeout(() => setFuState("idle"), 2500);
				} else {
					setFuState("failed");
				}
			} catch {
				setFuState("failed");
			}
		};

		// mic 轮询状态显示（实际轮询在插件根层 apply(ctx) 运行，独立于设置页）
		react.useEffect(() => {
			if (!prefs.enabled || !prefs[ECHO_MIC_KEY]) {
				setMicListening(false);
				return;
			}
			const sync = () => {
				setMicListening(micState.listening);
				if (micState.lastText) setMicLastText(micState.lastText);
			};
			sync();
			const iv = setInterval(sync, 1000);
			return () => clearInterval(iv);
		}, [prefs.enabled, prefs[ECHO_MIC_KEY]]);

		const disabled = !prefs[VOICE_PROMPT_KEY];

		// LLM 网关健康探测（仅当 LLM 语音开启时有意义；失败不影响 Voice Prompt）
		react.useEffect(() => {
			let mounted = true;
			const probe = async () => {
				try {
					const res = await fetch(LLM_HEALTH, { signal: AbortSignal.timeout(6000) });
					const data = await res.json();
					if (mounted) setLlmState(data?.ok ? "ok" : "unavailable");
				} catch {
					if (mounted) setLlmState("unavailable");
				}
			};
			if (prefs[LLM_VOICE_KEY]) {
				setLlmState("checking");
				probe();
				const iv = setInterval(probe, 15000);
				return () => { mounted = false; clearInterval(iv); };
			} else {
				setLlmState("off");
			}
		}, [prefs[LLM_VOICE_KEY]]);

		return (0, react_jsx_runtime.jsxs)("div", {
			style: { padding: "24px", fontFamily: "system-ui, -apple-system, sans-serif", color: "var(--dsw-alias-label-primary)", maxWidth: "460px" },
			children: [
				(0, react_jsx_runtime.jsx)("h2", {
					style: { fontSize: "18px", fontWeight: "600", margin: "0 0 20px 0", color: "var(--dsw-alias-label-primary)" },
					children: t("title")
				}),
				// ASR 状态（esph up = Echo Dot 就绪）
				(0, react_jsx_runtime.jsxs)("div", {
					style: { marginBottom: "16px", display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: asrStatus === "ready" ? "var(--dsw-alias-label-success)" : "var(--dsw-alias-label-tertiary)" },
					children: [
						(0, react_jsx_runtime.jsx)("span", { style: { width: "8px", height: "8px", borderRadius: "50%", background: asrStatus === "ready" ? "var(--dsw-alias-label-success)" : "var(--dsw-alias-label-tertiary)" } }),
						(0, react_jsx_runtime.jsx)("span", { children: t(asrStatus === "ready" ? "asr_ready" : (asrStatus === "esph-down" ? "asr_esph_down" : "asr_unreachable")) })
					]
				}),
				// 总开关
				(0, react_jsx_runtime.jsxs)("div", {
					style: { marginBottom: "20px", display: "flex", alignItems: "center", gap: "12px" },
					children: [
						(0, react_jsx_runtime.jsx)("input", {
							type: "checkbox",
							defaultChecked: prefs.enabled,
							style: { accentColor: "var(--dsw-alias-brand-primary)" },
							onChange: (e) => {
								const v = e.target.checked;
								writePrefs({ enabled: v });
							}
						}),
						(0, react_jsx_runtime.jsxs)("label", {
							style: { fontSize: "14px", color: "var(--dsw-alias-label-primary)", cursor: "pointer", userSelect: "none" },
							children: t("enabled")
						})
					]
				}),
				// LLM 语音开关（优先于场景音效，失败自动降级）
				(0, react_jsx_runtime.jsxs)("div", {
					style: { marginBottom: "20px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "8px", padding: "16px", background: "var(--dsw-alias-bg-layer-1)" },
					children: [
						(0, react_jsx_runtime.jsxs)("div", {
							style: { fontSize: "13px", color: "var(--dsw-alias-label-secondary)", marginBottom: "12px", fontWeight: "600" },
							children: "LLM 语音"
						}),
						(0, react_jsx_runtime.jsxs)("div", {
							style: { display: "flex", alignItems: "center", gap: "12px", marginBottom: "10px" },
							children: [
								(0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									defaultChecked: prefs[LLM_VOICE_KEY],
									style: { accentColor: "var(--dsw-alias-brand-primary)" },
									onChange: (e) => {
										const v = e.target.checked;
										writePrefs({ [LLM_VOICE_KEY]: v });
									}
								}),
								(0, react_jsx_runtime.jsxs)("label", {
									style: { fontSize: "14px", color: "var(--dsw-alias-label-primary)", cursor: "pointer", userSelect: "none" },
									children: t("llm_voice")
								})
							]
						}),
						(0, react_jsx_runtime.jsxs)("div", {
							style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)", marginBottom: "10px" },
							children: t("llm_voice_hint")
						}),
						(0, react_jsx_runtime.jsxs)("div", {
							style: { fontSize: "12px", display: "flex", alignItems: "center", gap: "6px" },
							children: [
								(0, react_jsx_runtime.jsx)("span", {
									style: {
										width: "8px", height: "8px", borderRadius: "50%",
										background: llmState === "ok" ? "var(--dsw-alias-label-success)"
											: llmState === "unavailable" ? "var(--dsw-alias-label-error)"
											: "var(--dsw-alias-label-tertiary)"
									}
								}),
								(0, react_jsx_runtime.jsx)("span", {
									children: t(llmState === "ok" ? "llm_ok"
										: llmState === "unavailable" ? "llm_unavailable"
										: llmState === "off" ? "llm_off"
										: "llm_checking")
								})
							]
						}),
						!prefs[LLM_VOICE_KEY] && (0, react_jsx_runtime.jsxs)("div", {
							style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)", marginTop: "6px" },
							children: t("llm_voice_off_hint")
						})
					]
				}),
				// 每个场景独立开关
				(0, react_jsx_runtime.jsxs)("div", {
					style: { marginBottom: "20px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "8px", padding: "16px", background: "var(--dsw-alias-bg-layer-1)" },
					children: [
						(0, react_jsx_runtime.jsxs)("div", {
							style: { fontSize: "13px", color: "var(--dsw-alias-label-secondary)", marginBottom: "12px", fontWeight: "600" },
							children: "独立开关"
						}),
						SCENARIO_KEYS.map((key) => (
							(0, react_jsx_runtime.jsxs)("div", {
								style: { display: "flex", alignItems: "center", gap: "12px", marginBottom: "10px" },
								children: [
									(0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										defaultChecked: prefs[key],
										disabled: disabled,
										style: { accentColor: "var(--dsw-alias-brand-primary)" },
										onChange: (e) => {
											const v = e.target.checked;
											writePrefs({ [key]: v });
										}
									}),
									(0, react_jsx_runtime.jsxs)("label", {
										style: {
											fontSize: "14px",
											color: (disabled || !prefs[key]) ? "var(--dsw-alias-label-tertiary)" : "var(--dsw-alias-label-primary)",
											cursor: (disabled || !prefs[key]) ? "default" : "pointer",
											userSelect: "none"
										},
										children: t("scenario_" + key)
									}),
									!prefs.enabled && (0, react_jsx_runtime.jsx)("span", {
										style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)", marginLeft: "8px" },
										children: t("scenario_disabled_hint")
									})
								]
							}, key)
						))
					]
				}),
				// Echo Dot 输出/麦克风
				(0, react_jsx_runtime.jsxs)("div", {
					style: { marginBottom: "20px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "8px", padding: "16px", background: "var(--dsw-alias-bg-layer-1)" },
					children: [
						(0, react_jsx_runtime.jsxs)("div", {
							style: { fontSize: "13px", color: "var(--dsw-alias-label-secondary)", marginBottom: "12px", fontWeight: "600" },
							children: "Echo Dot"
						}),
						(0, react_jsx_runtime.jsxs)("div", {
							style: { display: "flex", alignItems: "center", gap: "12px", marginBottom: "10px" },
							children: [
								(0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									defaultChecked: prefs[ECHO_OUTPUT_KEY],
									disabled: disabled,
									style: { accentColor: "var(--dsw-alias-brand-primary)" },
									onChange: (e) => {
										writePrefs({ [ECHO_OUTPUT_KEY]: e.target.checked });
									}
								}),
								(0, react_jsx_runtime.jsxs)("label", {
									style: {
										fontSize: "14px",
										color: disabled ? "var(--dsw-alias-label-tertiary)" : "var(--dsw-alias-label-primary)",
										cursor: disabled ? "default" : "pointer",
										userSelect: "none"
									},
									children: t("echo_output")
								})
							]
						}),
						(0, react_jsx_runtime.jsxs)("div", {
							style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)", marginBottom: "10px" },
							children: t("echo_output_hint")
						}),
						(0, react_jsx_runtime.jsxs)("div", {
							style: { display: "flex", alignItems: "center", gap: "12px", marginBottom: "10px" },
							children: [
								(0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									defaultChecked: prefs[ECHO_MIC_KEY],
									disabled: disabled,
									style: { accentColor: "var(--dsw-alias-brand-primary)" },
									onChange: (e) => {
										writePrefs({ [ECHO_MIC_KEY]: e.target.checked });
									}
								}),
								(0, react_jsx_runtime.jsxs)("label", {
									style: {
										fontSize: "14px",
										color: disabled ? "var(--dsw-alias-label-tertiary)" : "var(--dsw-alias-label-primary)",
										cursor: disabled ? "default" : "pointer",
										userSelect: "none"
									},
									children: t("echo_mic")
								})
							]
						}),
						(0, react_jsx_runtime.jsxs)("div", {
							style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)", marginBottom: "10px" },
							children: t("echo_mic_hint")
						}),
						micListening && (0, react_jsx_runtime.jsxs)("div", {
							style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary)", marginTop: "6px" },
							children: [
								(0, react_jsx_runtime.jsx)("span", { children: "监听麦克风…" }),
								micLastText && (0, react_jsx_runtime.jsxs)("span", {
									style: { marginLeft: "8px", fontWeight: "600", color: "var(--dsw-alias-brand-primary)" },
									children: ["“", micLastText, "”"]
								})
							]
						})
					]
				}),
				// Echo Dot 续听（经 asr_server 读写 HA，即时生效）
				(0, react_jsx_runtime.jsxs)("div", {
					style: { marginBottom: "20px", paddingTop: "16px", borderTop: "1px solid var(--dsw-alias-border-secondary)" },
					children: [
						(0, react_jsx_runtime.jsxs)("label", {
							style: { display: "block", fontSize: "13px", fontWeight: "600", color: "var(--dsw-alias-label-secondary)", marginBottom: "10px" },
							children: t("followup_title")
						}),
						(0, react_jsx_runtime.jsxs)("div", {
							style: { display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" },
							children: [
								(0, react_jsx_runtime.jsx)("span", {
									style: { fontSize: "13px", color: "var(--dsw-alias-label-primary)", whiteSpace: "nowrap" },
									children: t("followup_time")
								}),
								(0, react_jsx_runtime.jsx)("input", {
									type: "number",
									min: "0",
									max: "30",
									step: "1",
									value: fuTime,
									disabled: asrStatus !== "ready" || fuState === "saving",
									placeholder: "--",
									onChange: (e) => { setFuTime(e.target.value); if (fuState === "saved") setFuState("idle"); },
									style: { width: "72px", padding: "4px 8px", fontSize: "13px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-secondary)", background: "transparent", color: "var(--dsw-alias-label-primary)", boxSizing: "border-box" }
								})
							]
						}),
						(0, react_jsx_runtime.jsxs)("div", {
							style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)", marginBottom: "10px" },
							children: t("followup_time_hint")
						}),
						(0, react_jsx_runtime.jsxs)("div", {
							style: { display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" },
							children: [
								(0, react_jsx_runtime.jsx)("span", {
									style: { fontSize: "13px", color: "var(--dsw-alias-label-primary)", whiteSpace: "nowrap" },
									children: t("followup_rounds")
								}),
								(0, react_jsx_runtime.jsx)("input", {
									type: "number",
									min: "0",
									max: "10",
									step: "1",
									value: fuRounds,
									disabled: asrStatus !== "ready" || fuState === "saving",
									placeholder: "--",
									onChange: (e) => { setFuRounds(e.target.value); if (fuState === "saved") setFuState("idle"); },
									style: { width: "72px", padding: "4px 8px", fontSize: "13px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-secondary)", background: "transparent", color: "var(--dsw-alias-label-primary)", boxSizing: "border-box" }
								})
							]
						}),
						(0, react_jsx_runtime.jsxs)("div", {
							style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)", marginBottom: "10px" },
							children: t("followup_hint")
						}),
						(0, react_jsx_runtime.jsxs)("div", {
							style: { display: "flex", alignItems: "center", gap: "10px" },
							children: [
								(0, react_jsx_runtime.jsx)("button", {
									disabled: asrStatus !== "ready" || fuState === "saving" || (fuTime === "" && fuRounds === ""),
									onClick: applyFollowup,
									style: { padding: "6px 16px", fontSize: "13px", borderRadius: "8px", border: "none", cursor: "pointer", background: "var(--dsw-alias-brand-primary)", color: "#fff", opacity: (asrStatus !== "ready" || fuState === "saving" || (fuTime === "" && fuRounds === "")) ? 0.5 : 1 },
									children: t(fuState === "saving" ? "followup_saving" : "followup_save")
								}),
								fuState === "saved" && (0, react_jsx_runtime.jsx)("span", {
									style: { fontSize: "12px", color: "var(--dsw-alias-label-success)" },
									children: t("followup_saved")
								}),
								fuState === "failed" && (0, react_jsx_runtime.jsx)("span", {
									style: { fontSize: "12px", color: "var(--dsw-alias-label-error, #e5484d)" },
									children: t("followup_failed")
								})
							]
						})
					]
				}),
				// 音量
				(0, react_jsx_runtime.jsxs)("div", {
					style: { marginBottom: "20px" },
					children: [
						(0, react_jsx_runtime.jsxs)("label", {
							style: { display: "block", fontSize: "13px", color: "var(--dsw-alias-label-secondary)", marginBottom: "6px" },
							children: t("volume")
						}),
						(0, react_jsx_runtime.jsx)("input", {
							type: "range",
							min: "0",
							max: "1",
							step: "0.1",
							defaultValue: String(prefs.volume),
							disabled: disabled,
							style: { width: "100%", accentColor: "var(--dsw-alias-brand-primary)" },
							onChange: (e) => {
								const v = Number(e.target.value);
								writePrefs({ volume: v });
							}
						})
					]
				})
			]
		});
	}

	// ---------- main ----------

	let disposed = false;
	let cursor = 0;
	let lastSpeakTime = 0;

	function isDoNotDisturb() {
		const h = new Date().getHours();
		return h >= 22 || h < 7; // 22:00-07:00 静默任务完成播报
	}

	const STYLE_ORDER = ["tech", "cute", "mech"];

	const name = "voice-pet";
	const inject = ["slots", "locale"];

	function apply(ctx) {
		const prefs = loadPrefs();
		if (!prefs.style) prefs.style = "tech";
		if (prefs.volume === undefined) prefs.volume = 0.9;
		if (prefs.enabled === undefined) prefs.enabled = true;
		if (prefs[LLM_VOICE_KEY] === undefined) prefs[LLM_VOICE_KEY] = false;
		if (prefs[ECHO_OUTPUT_KEY] === undefined) prefs[ECHO_OUTPUT_KEY] = false;
		if (prefs[ECHO_MIC_KEY] === undefined) prefs[ECHO_MIC_KEY] = false;
		SCENARIO_KEYS.forEach((key) => {
			if (prefs[key] === undefined) prefs[key] = true;
		});
		try {
			cursor = Number.parseInt(localStorage.getItem(PLUGIN_ID + ":cursor") || "0", 10) || 0;
		} catch {}

		const setPrefs = (patch) => {
			Object.assign(prefs, patch);
			savePrefs(prefs);
		};

		const voice = createVoiceEngine(prefs);

		const t = ctx.locale.bind(NS);
		ctx.effect(() => ctx.locale.register(NS, {
			zh,
			en
		}), "voice-pet: dictionaries");

		// 注册到 DSH Settings 的 settings.section 槽位，作为 "dsh-pet-voice" 标签页
		ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
			name: "settings.section",
			id: "dsh-pet-voice",
			order: 50,
			label: () => t("title"),
			locale: NS
		}, VoicePetSettings)), "voice-pet: settings section");

		let speaking = false;
		const react = async (scenario) => {
			// 两个功能总开关：都关则完全静音
			if (!prefs[LLM_VOICE_KEY] && !prefs[VOICE_PROMPT_KEY]) return;
			if (disposed) return;
			// 场景独立开关（仅 Voice Prompt 侧有，LLM 侧全部场景都走）
			if (prefs[VOICE_PROMPT_KEY] && !prefs[scenario]) return;
			if (Date.now() - lastSpeakTime < DEBOUNCE_MS) return;
			if (scenario === "task_done" && isDoNotDisturb()) return;
			lastSpeakTime = Date.now();
			speaking = true;
			try {
				// 优先级：LLM 语音 > 原有 Voice Prompt
				if (prefs[LLM_VOICE_KEY]) {
					const ok = await voice.speakLLM(scenario, "");
					if (ok) return; // LLM 成功播出，无需降级
				}
				// LLM 关闭或失败 → 自动降级到原有 Voice Prompt
				if (prefs[VOICE_PROMPT_KEY]) {
					await voice.speakScenario(scenario, prefs.volume);
				}
			} catch {} // autoplay/audio errors are never fatal
			speaking = false;
		};

		const poll = async () => {
			if (disposed || speaking) return;
			try {
				const res = await fetch(`/api/voice-pet/events?after=${cursor}`, { signal: AbortSignal.timeout(4000) });
				if (!res.ok) return;
				const data = await res.json();
				if (Array.isArray(data.events) && data.events.length > 0) {
					cursor = data.events[data.events.length - 1].id;
					try {
						localStorage.setItem(PLUGIN_ID + ":cursor", String(cursor));
					} catch {}
					await react(data.events[data.events.length - 1].scenario);
				}
			} catch {} // host not ready or transient error: keep polling silently
		};

		(async () => {
			console.log("[VoicePet] 客户端启动（语音模块 + Echo Dot）");
			await voice.init().catch(() => {});
			// unlock Web Speech voices on the first user interaction
			document.addEventListener(
				"click",
				() => {
					if ("speechSynthesis" in window) speechSynthesis.getVoices();
				},
				{ once: true }
			);
			// startup greeting once per page load (respects master toggle and startup toggle)
			setTimeout(() => {
				if (disposed) return;
				// 启动问候同样走 LLM 优先 / 降级逻辑
				const doStartup = async () => {
					if (!prefs[LLM_VOICE_KEY] && !prefs[VOICE_PROMPT_KEY]) return;
					if (prefs[VOICE_PROMPT_KEY] && !prefs.startup) return;
					try {
						if (prefs[LLM_VOICE_KEY]) {
							const ok = await voice.speakLLM("startup", "");
							if (ok) return;
						}
						if (prefs[VOICE_PROMPT_KEY] && prefs.startup) {
							await voice.speakStartup(prefs.volume);
						}
					} catch (err) {
						console.log("[VoicePet] 启动问候未能播放:", err?.message ?? err);
					}
				};
				doStartup();
			}, 1500);
			setInterval(poll, POLL_MS);
			poll();

			// 麦克风转录轮询（根层，独立于设置页：开关状态每轮实时读取 prefs）
			const micLoop = async () => {
				if (disposed) return;
				if (prefs.enabled && prefs[ECHO_MIC_KEY]) {
					micState.listening = true;
					try {
						// Retry a previously undeliverable transcript first.
						if (pendingInsert) {
							if (insertTextIntoComposer(pendingInsert)) {
								pendingInsert = "";
							} else {
								console.log("[VoicePet] composer 仍不可用，转录文本暂存待重试:", pendingInsert);
							}
						}
						const text = await transcribeMic();
						if (text && text.trim()) {
							micState.lastText = text.trim();
							if (!insertTextIntoComposer(text.trim())) {
								pendingInsert = text.trim();
								console.log("[VoicePet] 无法找到 composer 输入框，转录文本已暂存:", text);
							}
						}
					} catch {}
					micState.listening = prefs.enabled && prefs[ECHO_MIC_KEY];
				} else {
					micState.listening = false;
				}
				if (!disposed) setTimeout(micLoop, MIC_POLL_MS);
			};
			micLoop();
		})();

		ctx.effect(() => () => {
			disposed = true;
			voice.stop();
		}, "voice-pet: client cleanup");
	}

	exports.name = name;
	exports.inject = inject;
	exports.apply = apply;
	return module.exports;
}});
