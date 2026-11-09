#!/usr/bin/env python3
"""Generate multiple 科技风格 voice audio files using edge-tts + ffmpeg post-processing."""

import asyncio
import os
import subprocess

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "assets", "voices")
os.makedirs(OUT_DIR, exist_ok=True)

# 科技风格统一使用 XiaoyiNeural（中性清晰女声）
VOICE = "zh-CN-XiaoyiNeural"

# 多条科技风格提示语
TEXTS = {
    "startup":    "早安，欢迎回来。系统已就绪。",
    "startup_2":  "系统启动完成。主人，今日有何吩咐？",
    "task_done":  "任务已完成。请确认结果。",
    "task_done_2":"执行结束。所有指令已处理完毕。",
    "error":      "检测到异常。请立即检查日志。",
    "error_2":    "警告。操作未成功，请重试。",
    "idle":       "系统空闲中。等待您的输入。",
    "idle_2":     "待机状态。随时待命。",
    "session_end":"会话已结束。感谢使用。",
    "session_end_2":"连接断开。随时欢迎您回来。",
}

# 科技风格后处理：高通 + 2kHz/4kHz 峰值增强 + 轻微混响
FILTER = "highpass=f=200,equalizer=f=2000:t=q:w=1:g=3,equalizer=f=4000:t=q:w=1:g=2,aecho=0.8:0.88:60:0.4"


async def generate():
    import edge_tts
    for scenario, text in TEXTS.items():
        raw = os.path.join(OUT_DIR, f"tech_{scenario}_raw.mp3")
        final = os.path.join(OUT_DIR, f"tech_{scenario}.mp3")

        print(f"Generating tech/{scenario}: {text}")
        communicate = edge_tts.Communicate(text, VOICE, rate="+5%", pitch="+3Hz")
        await communicate.save(raw)

        cmd = [
            "ffmpeg", "-y", "-i", raw,
            "-af", FILTER,
            "-codec:a", "libmp3lame",
            "-qscale:a", "2",
            final,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"  ffmpeg failed: {result.stderr[-200:]}")
        else:
            print(f"  -> {final}")


if __name__ == "__main__":
    asyncio.run(generate())
