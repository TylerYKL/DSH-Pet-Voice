// DSH Voice Pet Plugin - Entry Point
import { VoiceEngine } from './voice-engine.js';
import { PetUI } from './pet-ui.js';
import { StyleManager } from './style-manager.js';

const PLUGIN_ID = 'dsh-plugin-voice-pet';

class VoicePetPlugin {
  constructor() {
    this.voice = new VoiceEngine();
    this.pet = null;
    this.style = new StyleManager();
    this.prefs = this.loadPrefs();
    this.lastSpeakTime = 0;
    this.DEBOUNCE_MS = 30000;
    this.initialized = false;
  }

  loadPrefs() {
    try {
      return JSON.parse(localStorage.getItem(PLUGIN_ID + ':prefs') || '{}');
    } catch { return {}; }
  }

  savePrefs() {
    try {
      localStorage.setItem(PLUGIN_ID + ':prefs', JSON.stringify(this.prefs));
    } catch {}
  }

  async init(dsh) {
    this.dsh = dsh;
    this.pet = new PetUI(document.body);
    this.pet.onStyleChange = (s) => { this.prefs.style = s; this.savePrefs(); };

    // 默认偏好
    if (!this.prefs.style) this.prefs.style = 'tech';
    if (this.prefs.volume === undefined) this.prefs.volume = 0.9;
    if (this.prefs.enabled === undefined) this.prefs.enabled = true;

    // 初始化语音引擎（加载预处理音频文件）
    await this.voice.init('assets/voices');

    // 事件订阅（防御式：API 缺失时只记录并跳过，不让插件初始化失败）
    this._bindEvent(dsh, 'task:completed', (task) => this.onTaskComplete(task));
    this._bindEvent(dsh, 'task:failed', (task) => this.onTaskFailed(task));
    this._bindEvent(dsh, 'session:end', () => this.onSessionEnd());

    // 解锁音频上下文（首次用户交互）
    document.addEventListener('click', () => this.voice.unlock(), { once: true });

    // DSH 启动时播放问候语（仅首次初始化；自动播放可能被拒绝，必须兜底）
    if (!this.initialized) {
      this.initialized = true;
      setTimeout(() => {
        this.voice.speakStartup(this.prefs.style, this.prefs.volume)
          .catch((err) => console.log('[VoicePet] 启动问候未能播放（自动播放策略或音频缺失）:', err?.message || err));
      }, 1500);
    }

    console.log('[VoicePet] 插件已初始化，风格:', this.prefs.style);
  }

  onTaskComplete(task) {
    if (!this.prefs.enabled || this.isDoNotDisturb()) return;
    if (Date.now() - this.lastSpeakTime < this.DEBOUNCE_MS) return;
    this.lastSpeakTime = Date.now();
    this.pet.setState('speaking');
    this.pet.showBubble('任务已完成');
    this.voice.speakScenario('task_done', this.prefs.style, this.prefs.volume)
      .catch(() => {})
      .finally(() => {
      this.pet.setState('idle');
    });
  }

  onTaskFailed(task) {
    if (!this.prefs.enabled) return;
    this.pet.setState('speaking');
    this.pet.showBubble('检测到异常');
    this.voice.speakScenario('error', 'tech', this.prefs.volume)
      .catch(() => {})
      .finally(() => {
      this.pet.setState('idle');
    });
  }

  onSessionEnd() {
    if (!this.prefs.enabled) return;
    this.pet.setState('speaking');
    this.pet.showBubble('会话已结束');
    this.voice.speakScenario('session_end', this.prefs.style, this.prefs.volume)
      .catch(() => {})
      .finally(() => {
      this.pet.setState('idle');
    });
  }

  /** 防御式事件绑定：API 缺失或调用抛错时降级为日志，不影响插件其余功能 */
  _bindEvent(dsh, event, handler) {
    try {
      if (dsh && typeof dsh.on === 'function') {
        dsh.on(event, handler);
      } else {
        console.warn('[VoicePet] dsh.on 不可用，跳过事件订阅:', event);
      }
    } catch (err) {
      console.warn('[VoicePet] 事件订阅失败:', event, err);
    }
  }

  isDoNotDisturb() {
    const h = new Date().getHours();
    return h >= 22 || h < 7; // 22:00-07:00 勿扰
  }

  /** 重启 DSH。通过 Electron 主进程 IPC 通道 dsh-desktop:restart 重启。*/
  restartDSH() {
    if (this.dsh && typeof this.dsh.restart === 'function') {
      return this.dsh.restart();
    }
    console.warn('[VoicePet] DSH 未提供 restart API，无法从渲染进程重启 Electron 主进程。');
    return Promise.reject(new Error('DSH restart API not available'));
  }
}

// Auto-register if DSH global exists
if (typeof window !== 'undefined' && window.dsh) {
  const plugin = new VoicePetPlugin();
  plugin.init(window.dsh);
}

export default VoicePetPlugin;
export { VoicePetPlugin };
