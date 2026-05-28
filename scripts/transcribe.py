#!/usr/bin/env python3
"""
Transcribe a Craig recording using faster-whisper (large-v3, int8 CPU).

Works on linux/arm64 (NEON) and linux/amd64 (AVX2/VNNI) without a GPU:
  - compute_type="int8"  → CTranslate2 picks the best SIMD path automatically
  - cpu_threads           → defaults to os.cpu_count() (logical cores)
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
    p.add_argument("--cpu-threads", type=int, default=None, help="CPU thread count (default: os.cpu_count())")
    p.add_argument("--track", type=int, default=None, help="OGG stream serial number to transcribe (= key in .ogg.users file, required)")
    p.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto",
                   help="Inference device: auto (default), cpu, or cuda")
    return p.parse_args()


def _resolve_device(requested: str) -> tuple:
    """Return (device, compute_type) for WhisperModel."""
    if requested == "cpu":
        return "cpu", "int8"
    if requested == "cuda":
        return "cuda", "float16"
    # auto: use CUDA when a GPU is reachable, otherwise CPU
    try:
        import ctranslate2
        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda", "float16"
    except Exception:
        pass
    return "cpu", "int8"


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


def _oggcorrect_path():
    """Return the path to the oggcorrect binary (built by install.sh)."""
    script_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(script_dir, "cook", "oggcorrect")


def extract_track_ogg(rec_dir, recording_id, stream_serial):
    """
    Extract a single stream from a Craig recording using oggcorrect.

    Craig's OGG files require:
      1. header1 + header2 + data concatenated TWICE (oggcorrect re-reads
         the headers after the data to fill silence gaps correctly).
      2. Piping through oggcorrect <stream_serial> to fix granule positions,
         remove other streams, and insert silence for packet gaps.

    Returns the path to a temporary single-stream OGG file.
    """
    tmp = tempfile.NamedTemporaryFile(suffix=".ogg", delete=False)
    tmp.close()

    parts = []
    for ext in ("header1", "header2", "data"):
        parts.append(os.path.join(rec_dir, f"{recording_id}.ogg.{ext}"))

    # Concatenate twice as required by oggcorrect
    def _cat_twice(dst_fd):
        for _ in range(2):
            for p in parts:
                with open(p, "rb") as f:
                    dst_fd.write(f.read())

    raw = tempfile.NamedTemporaryFile(suffix=".ogg.raw", delete=False)
    try:
        _cat_twice(raw)
        raw.close()

        with open(raw.name, "rb") as stdin_f, open(tmp.name, "wb") as stdout_f:
            result = subprocess.run(
                [_oggcorrect_path(), str(stream_serial)],
                stdin=stdin_f,
                stdout=stdout_f,
                stderr=subprocess.PIPE,
            )
        if result.returncode != 0:
            raise RuntimeError(
                f"oggcorrect failed (stream {stream_serial}):\n"
                f"{result.stderr.decode(errors='replace')}"
            )
    finally:
        try:
            os.unlink(raw.name)
        except FileNotFoundError:
            pass

    return tmp.name


def decode_ogg_to_wav(ogg_path):
    """Decode a single-stream OGG file to 16 kHz mono WAV via ffmpeg."""
    wav_path = ogg_path.replace(".ogg", ".wav")
    result = subprocess.run(
        ["ffmpeg", "-y", "-i", ogg_path, "-ar", "16000", "-ac", "1", wav_path],
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

    cpu_threads = args.cpu_threads or os.cpu_count() or 4
    os.environ.setdefault("OMP_NUM_THREADS", str(cpu_threads))

    device, compute_type = _resolve_device(args.device)

    if args.track is None:
        raise SystemExit("--track is required (use the stream serial number from the .users file)")

    ogg_path = None
    wav_path = None

    try:
        print(f"Extracting stream {args.track} for {args.id}...", file=sys.stderr)
        # --track is the OGG stream serial number (= key in .ogg.users file)
        ogg_path = extract_track_ogg(rec_dir, args.id, args.track)

        print(f"Decoding audio...", file=sys.stderr)
        wav_path = decode_ogg_to_wav(ogg_path)

        from faster_whisper import WhisperModel  # noqa: PLC0415

        extra = f"threads={cpu_threads}" if device == "cpu" else "float16"
        print(f"Loading large-v3 ({device}, {extra})...", file=sys.stderr)
        model = WhisperModel(
            "large-v3",
            device=device,
            compute_type=compute_type,
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
            vad_parameters={
                "threshold": 0.3,
                "min_silence_duration_ms": 300,
                "speech_pad_ms": 600,
            },
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
