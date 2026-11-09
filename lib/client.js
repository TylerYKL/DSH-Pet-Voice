window.__ModuleLoader__.load({ id: "dsh-plugin-voice-pet", factory: (require) => {

	var module = { exports: {} };
	var exports = module.exports;
	Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

	const react_jsx_runtime = require("react/jsx-runtime");
	const react = require("react");

	// DSH Voice Pet Plugin - Client half
	// Only the voice module is kept. Pet-related UI (floating pet, figures, GIFs)
	// has been removed because pet functionality lives in other plugins.
	// A master toggle in DSH Settings ("dsh-pet-voice") controls voice on/off at any time.
	// Client plugin contract: exports { name, inject, apply }.

	const POLL_MS = 1000;
	const DEBOUNCE_MS = 30000;
	const PLUGIN_ID = "dsh-plugin-voice-pet";
	const NS = "settings.voicePet";

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
		volume: "音量"
	};
	const en = {
		title: "Voice Pet",
		enabled: "Enable voice prompts",
		volume: "Volume"
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

		function playFile(file, volume) {
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
				const zh = voices.find((v) => v.lang.startsWith("zh")) ?? voices.find((v) => v.lang.includes("CN"));
				if (zh) u.voice = zh;
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
				try {
					return await playFile(FILE_MAP[prefs.style][SCENARIO_FILE_KEY[chosen]], volume);
				} catch {
					// fall through to Web Speech
				}
			}
			return speakWebSpeech(speakText(chosen ?? scenario));
		}

		/** 根据本地电脑时间判断时段。 */
		function getTimeOfDay() {
			const h = new Date().getHours();
			if (h >= 5 && h < 9) return "morning";      // 早晨 05:00-09:00
			if (h >= 9 && h < 12) return "forenoon";    // 上午 09:00-12:00
			if (h >= 12 && h < 14) return "noon";       // 中午 12:00-14:00
			if (h >= 14 && h < 18) return "afternoon";  // 下午 14:00-18:00
			if (h >= 18 && h < 22) return "evening";    // 傍晚/晚上 18:00-22:00
			return "night";                              // 凌晨/深夜 22:00-05:00
		}

		/** 按时段匹配启动问候语，确保与本地真实时间一致。 */
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

			// 优先尝试播放对应时段的音频文件（如存在），否则使用 Web Speech 朗读
			const audioKey = `startup_${period}`;
			const file = FILE_MAP[prefs.style]?.[audioKey];
			if (file && available.get(file)) {
				try {
					return await playFile(file, volume);
				} catch {} // fall through to Web Speech
			}
			// 兼容旧音频文件（startup / startup_2）
			const legacyFile = FILE_MAP[prefs.style]?.startup;
			if (legacyFile && available.get(legacyFile)) {
				try {
					return await playFile(legacyFile, volume);
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

		return { init, speakScenario, speakStartup, stop };
	}

	// ---------- Settings tab component (DSH Settings) ----------

	function VoicePetSettings({ t }) {
		const load = () => loadPrefs();
		const [volume, setVolume] = react.useState(() => (loadPrefs().volume ?? 0.9));
		const [enabled, setEnabled] = react.useState(() => (loadPrefs().enabled ?? true));

		return (0, react_jsx_runtime.jsxs)("div", {
			style: { padding: "24px", fontFamily: "system-ui, -apple-system, sans-serif", color: "var(--dsw-alias-label-primary)", maxWidth: "420px" },
			children: [
				(0, react_jsx_runtime.jsx)("h2", {
					style: { fontSize: "18px", fontWeight: "600", margin: "0 0 20px 0", color: "var(--dsw-alias-label-primary)" },
					children: t("title")
				}),
				(0, react_jsx_runtime.jsxs)("div", {
					style: { marginBottom: "20px", display: "flex", alignItems: "center", gap: "12px" },
					children: [
						(0, react_jsx_runtime.jsx)("input", {
							type: "checkbox",
							defaultChecked: enabled,
							style: { accentColor: "var(--dsw-alias-brand-primary)" },
							onChange: (e) => {
								const v = e.target.checked;
								setEnabled(v);
								savePrefs({ ...load(), enabled: v });
							}
						}),
						(0, react_jsx_runtime.jsxs)("label", {
							style: { fontSize: "14px", color: "var(--dsw-alias-label-primary)", cursor: "pointer", userSelect: "none" },
							children: t("enabled")
						})
					]
				}),
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
							defaultValue: String(volume),
							style: { width: "100%", accentColor: "var(--dsw-alias-brand-primary)" },
							onChange: (e) => {
								const v = Number(e.target.value);
								setVolume(v);
								savePrefs({ ...load(), volume: v });
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
			// 总开关：随时生效，关闭时不播放任何语音
			if (!prefs.enabled || disposed) return;
			if (Date.now() - lastSpeakTime < DEBOUNCE_MS) return;
			if (scenario === "task_done" && isDoNotDisturb()) return;
			lastSpeakTime = Date.now();
			speaking = true;
			try {
				await voice.speakScenario(scenario, prefs.volume);
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
			console.log("[VoicePet] 客户端启动（语音模块）");
			await voice.init().catch(() => {});
			// unlock Web Speech voices on the first user interaction
			document.addEventListener(
				"click",
				() => {
					if ("speechSynthesis" in window) speechSynthesis.getVoices();
				},
				{ once: true }
			);
			// startup greeting once per page load (respects master toggle)
			setTimeout(() => {
				if (prefs.enabled) {
					voice
						.speakStartup(prefs.volume)
						.catch((err) => console.log("[VoicePet] 启动问候未能播放:", err?.message ?? err));
				}
			}, 1500);
			setInterval(poll, POLL_MS);
			poll();
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
