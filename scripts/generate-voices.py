#!/usr/bin/env python3
"""Generate styled voice audio files using edge-tts + ffmpeg post-processing."""

import asyncio
import os
import subprocess
import sys

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "assets", "voices")
os.makedirs(OUT_DIR, exist_ok=True)

# Edge TTS voice presets
VOICES = {
    "cute": "zh-CN-XiaoxiaoNeural",
    "mech": "zh-CN-YunxiNeural",
    "tech": "zh-CN-XiaoyiNeural",
}

# Text templates per style
TEXTS = {
    "cute": {
        "complete": "主人~你的任务完成啦！",
        "error": "主人~出错了哦，快来看看~",
        "idle": "主人~你还在吗？",
    },
    "mech": {
        "complete": "主人。任务。完成。",
        "error": "主人。任务。出错。",
        "idle": "主人。还在吗？",
    },
    "tech": {
        "complete": "主人，任务已完成。",
        "error": "主人，检测到异常。",
        "idle": "主人，系统空闲中。",
    },
}

# ffmpeg post-processing filters per style (colon-free where possible)
FILTERS = {
    "cute": "asetrate=44100*1.12,atempo=0.893,chorus=0.4:0.9:50:0.4:0.25:2",
    "mech": "highpass=f=300,lowpass=f=4000,acrusher=level_in=1:level_out=2:bits=8:mode=log:aa=1",
    "tech": "highpass=f=200,equalizer=f=2000:t=q:w=1:g=3,equalizer=f=4000:t=q:w=1:g=2,aecho=0.8:0.88:60:0.4",
}


async def generate():
    import edge_tts
    for style, voice in VOICES.items():
        for scenario, text in TEXTS[style].items():
            raw = os.path.join(OUT_DIR, f"{style}_{scenario}_raw.mp3")
            final = os.path.join(OUT_DIR, f"{style}_{scenario}.mp3")

            print(f"Generating {style}/{scenario}: {text}")
            communicate = edge_tts.Communicate(text, voice, rate="+15%", pitch="+5Hz")
            await communicate.save(raw)

            # Apply ffmpeg post-processing
            filt = FILTERS[style]
            cmd = [
                "ffmpeg", "-y", "-i", raw,
                "-af", filt,
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
