#!/usr/bin/env python3
"""
Transcribe a Craig recording using faster-whisper (large-v3, int8 CPU).

Optimised for Oracle A1 Ampere Altra ARM64 (aarch64):
  - compute_type="int8"  → CTranslate2 uses ARM NEON dot-product instructions
  - cpu_threads           → set to physical core count (no hyperthreading on Altra)
  - num_workers=1         → one sequential job; all threads go to one worker

Usage:
  transcribe.py <recording_id> [--lang <code>] [--format srt|vtt|txt|json]
                [--rec-dir <path>] [--model-dir <path>] [--cpu-threads N]
                [--track N]  # 1-based OGG audio stream index

When --track is given only that stream is decoded and transcribed.
JSON output (--format json):
  {"language":"en","language_probability":0.99,"segments":[{"start":0.0,"end":2.5,"text":"..."}]}
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile


def parse_args():
    p = argparse.ArgumentParser(description="Transcribe a Craig recording with faster-whisper")
    p.add_argument("id", help="Recording ID")
    p.add_argument("--lang", default=None, help="Language code (e.g. en, ja) — auto-detect if omitted")
    p.add_argument("--format", choices=["srt", "vtt", "txt", "json"], default="srt")
    p.add_argument("--rec-dir", default=None, help="Path to the rec directory")
    p.add_argument("--model-dir", default=None, help="Path to the model cache directory")
    p.add_argument("--cpu-threads", type=int, default=None, help="CPU thread count (default: physical core count)")
    p.add_argument("--track", type=int, default=None, help="1-based OGG audio stream index to transcribe")
    return p.parse_args()


def _ts(seconds, sep):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    ms = int((s % 1) * 1000)
    return f"{h:02d}:{m:02d}:{int(s):02d}{sep}{ms:03d}"


def to_srt(segments):
    out = []
    for i, seg in enumerate(segments, 1):
        out.append(str(i))
        out.append(f"{_ts(seg.start, ',')} --> {_ts(seg.end, ',')}")
        out.append(seg.text.strip())
        out.append("")
    return "\n".join(out)


def to_vtt(segments):
    out = ["WEBVTT", ""]
    for seg in segments:
        out.append(f"{_ts(seg.start, '.')} --> {_ts(seg.end, '.')}")
        out.append(seg.text.strip())
        out.append("")
    return "\n".join(out)


def to_txt(segments):
    return "\n".join(seg.text.strip() for seg in segments)


def to_json_str(segments, info):
    return json.dumps({
        "language": info.language,
        "language_probability": round(info.language_probability, 4),
        "segments": [
            {"start": round(s.start, 3), "end": round(s.end, 3), "text": s.text.strip()}
            for s in segments
        ]
    }, ensure_ascii=False)


def build_ogg(rec_dir, recording_id):
    """Concatenate the three OGG segment files into one temporary file."""
    tmp = tempfile.NamedTemporaryFile(suffix=".ogg", delete=False)
    try:
        for ext in ("header1", "header2", "data"):
            part = os.path.join(rec_dir, f"{recording_id}.ogg.{ext}")
            with open(part, "rb") as f:
                tmp.write(f.read())
    except Exception:
        tmp.close()
        os.unlink(tmp.name)
        raise
    tmp.close()
    return tmp.name


def decode_to_wav(ogg_path, track=None):
    """
    Decode an OGG file to 16 kHz mono WAV.

    track: 1-based audio stream index. When None, all streams are amixed.
    """
    suffix = f"_t{track}" if track is not None else ""
    wav_path = ogg_path.replace(".ogg", f"{suffix}.wav")

    if track is not None:
        # Select specific 0-based audio stream
        filter_args = ["-map", f"0:a:{track - 1}"]
    else:
        # Count streams to build amix filter
        probe = subprocess.run(
            [
                "ffprobe", "-v", "quiet",
                "-print_format", "json",
                "-show_streams", "-select_streams", "a",
                ogg_path,
            ],
            capture_output=True,
            text=True,
        )
        n = len(json.loads(probe.stdout).get("streams", [])) if probe.returncode == 0 else 1
        n = max(n, 1)
        filter_args = (
            ["-filter_complex", f"amix=inputs={n}:duration=longest"]
            if n > 1
            else []
        )

    result = subprocess.run(
        ["ffmpeg", "-y", "-i", ogg_path]
        + filter_args
        + ["-ar", "16000", "-ac", "1", wav_path],
        capture_output=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed:\n{result.stderr.decode(errors='replace')}")

    return wav_path


def main():
    args = parse_args()

    script_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    rec_dir = args.rec_dir or os.path.join(script_dir, "rec")
    model_dir = args.model_dir or os.path.join(script_dir, "whisper-models")

    os.makedirs(model_dir, exist_ok=True)

    # Ampere Altra has no hyperthreading → os.cpu_count() == physical cores.
    cpu_threads = args.cpu_threads or os.cpu_count() or 4
    os.environ.setdefault("OMP_NUM_THREADS", str(cpu_threads))

    ogg_path = build_ogg(rec_dir, args.id)
    wav_path = None

    try:
        track_label = f" track={args.track}" if args.track is not None else " (mixed)"
        print(f"Decoding audio for {args.id}{track_label}...", file=sys.stderr)
        wav_path = decode_to_wav(ogg_path, args.track)

        from faster_whisper import WhisperModel  # noqa: PLC0415

        print(
            f"Loading large-v3 (int8, CPU, threads={cpu_threads})...",
            file=sys.stderr,
        )
        # Optimal for Oracle A1 / Ampere Altra (ARM64, no hyperthreading):
        #   compute_type="int8"  → NEON dot-product path in CTranslate2
        #   cpu_threads          → all physical cores to one worker
        #   num_workers=1        → sequential; avoids thread contention
        model = WhisperModel(
            "large-v3",
            device="cpu",
            compute_type="int8",
            download_root=model_dir,
            cpu_threads=cpu_threads,
            num_workers=1,
        )

        print(
            f"Transcribing (format={args.format}, lang={args.lang or 'auto'})...",
            file=sys.stderr,
        )
        segments, info = model.transcribe(
            wav_path,
            language=args.lang,
            beam_size=5,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500, "speech_pad_ms": 400},
            condition_on_previous_text=False,
        )
        segments = list(segments)
        print(
            f"Detected language: {info.language} (prob={info.language_probability:.2f})",
            file=sys.stderr,
        )

        if args.format == "srt":
            print(to_srt(segments))
        elif args.format == "vtt":
            print(to_vtt(segments))
        elif args.format == "json":
            print(to_json_str(segments, info))
        else:
            print(to_txt(segments))

    finally:
        for p in filter(None, [ogg_path, wav_path]):
            try:
                os.unlink(p)
            except FileNotFoundError:
                pass


if __name__ == "__main__":
    main()
