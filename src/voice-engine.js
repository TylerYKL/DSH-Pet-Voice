// Voice Engine with pre-generated Edge TTS + ffmpeg post-processed audio files.
// Falls back to Web Speech API if audio files are unavailable.
const ASSET_BASE = "assets/voices";

const FILE_MAP = {
  cute:  { complete: "cute_complete.mp3", error: "cute_error.mp3", idle: "cute_idle.mp3" },
  mech:  { complete: "mech_complete.mp3", error: "mech_error.mp3", idle: "mech_idle.mp3" },
  tech:  {
    complete:   "tech_task_done.mp3",
    complete_2: "tech_task_done_2.mp3",
    error:      "tech_error.mp3",
    error_2:    "tech_error_2.mp3",
    idle:       "tech_idle.mp3",
    idle_2:     "tech_idle_2.mp3",
    startup:    "tech_startup.mp3",
    startup_2:  "tech_startup_2.mp3",
    session_end:"tech_session_end.mp3",
    session_end_2:"tech_session_end_2.mp3",
  },
};

export class VoiceEngine {
  constructor() {
    this.audio = null;
    this.useWebSpeechFallback = true;
    this.available = new Map(); // style -> scenario -> bool
  }

  async init(baseUrl = ASSET_BASE) {
    this.baseUrl = baseUrl;
    // Probe which files are actually available (parallel, fast-fail on missing files)
    const probes = [];
    for (const [style, scenarios] of Object.entries(FILE_MAP)) {
      this.available.set(style, {});
      for (const scenario of Object.keys(scenarios)) {
        this.available.get(style)[scenario] = false;
        probes.push(
          fetch(`${baseUrl}/${FILE_MAP[style][scenario]}`, { method: "HEAD", signal: AbortSignal.timeout(4000) })
            .then((res) => { this.available.get(style)[scenario] = res.ok; })
            .catch(() => {}) // 404/断网/超时：保持 false，快速跳过
        );
      }
    }
    // 全部并行探测；任一请求异常都不拖慢整体（无超时依赖）
    await Promise.all(probes);
    if (this.countAvailable() === 0) {
      console.log("[VoicePet] No pre-generated audio files available, using Web Speech API fallback");
      this.useWebSpeechFallback = true;
    } else {
      this.useWebSpeechFallback = false;
    }
  }

  countAvailable() {
    let n = 0;
    for (const scenarios of this.available.values()) {
      for (const ok of Object.values(scenarios)) if (ok) n++;
    }
    return n;
  }

  async speak(text, style = "cute", volume = 0.9, scenario = "complete") {
    // Try pre-generated audio file first
    const file = FILE_MAP[style]?.[scenario];
    if (file && this.available.get(style)?.[scenario]) {
      return this.playFile(`${this.baseUrl}/${file}`, volume);
    }

    // Fallback: Web Speech API
    if (this.useWebSpeechFallback) {
      return this.speakWebSpeech(text, style, volume);
    }

    // Last resort: log only
    console.log("[VoicePet] (muted/no audio) " + text);
    return Promise.resolve();
  }

  /** Play a startup greeting (randomly pick startup or startup_2) */
  async speakStartup(style = "tech", volume = 0.9) {
    const scenario = Math.random() < 0.5 ? "startup" : "startup_2";
    const greetings = {
      startup:    "早安，欢迎回来。系统已就绪。",
      startup_2:  "系统启动完成。主人，今日有何吩咐？",
    };
    return this.speak(greetings[scenario], style, volume, scenario);
  }

  /** Play a random variant for a given scenario (e.g. task_done -> task_done or task_done_2) */
  async speakScenario(scenario, style = "tech", volume = 0.9) {
    const variants = [scenario, scenario + "_2"];
    const chosen = variants.find(v => FILE_MAP[style]?.[v] && this.available.get(style)?.[v]) || scenario;
    const textMap = {
      "task_done":    "任务已完成。请确认结果。",
      "task_done_2":  "执行结束。所有指令已处理完毕。",
      "error":        "检测到异常。请立即检查日志。",
      "error_2":      "警告。操作未成功，请重试。",
      "idle":         "系统空闲中。等待您的输入。",
      "idle_2":       "待机状态。随时待命。",
      "session_end":  "会话已结束。感谢使用。",
      "session_end_2":"连接断开。随时欢迎您回来。",
    };
    return this.speak(textMap[chosen] || "", style, volume, chosen);
  }

  playFile(url, volume = 0.9) {
    return new Promise((resolve, reject) => {
      if (this.audio) {
        this.audio.pause();
        this.audio.src = "";
      }
      const a = new Audio(url);
      this.audio = a;
      a.volume = volume;
      a.onended = () => { this.audio = null; resolve(); };
      a.onerror = (e) => { this.audio = null; reject(e); };
      a.play().catch(reject);
    });
  }

  async speakWebSpeech(text, style = "cute", volume = 0.9) {
    if (!("speechSynthesis" in window)) return Promise.resolve();
    const presets = { cute: { rate: 1.25, pitch: 1.5 }, mech: { rate: 0.9, pitch: 0.8 }, tech: { rate: 1.05, pitch: 1.05 } };
    const p = presets[style] || presets.cute;
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "zh-CN";
      u.rate = p.rate;
      u.pitch = p.pitch;
      u.volume = volume;
      const voices = speechSynthesis.getVoices();
      const zh = voices.find(v => v.lang.startsWith("zh")) || voices.find(v => v.lang.includes("CN"));
      if (zh) u.voice = zh;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    });
  }

  stop() {
    if (this.audio) { this.audio.pause(); this.audio.src = ""; this.audio = null; }
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  }

  getStyles() { return Object.keys(FILE_MAP); }
}
