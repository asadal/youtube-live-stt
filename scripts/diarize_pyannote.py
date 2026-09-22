#!/usr/bin/env python3
import argparse
import json
import os
import sys

from pyannote.audio import Pipeline


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run local pyannote community-1 diarization")
    parser.add_argument("audio_path")
    parser.add_argument("--model", default=os.environ.get("PYANNOTE_MODEL_PATH", "pyannote/speaker-diarization-community-1"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    token = os.environ.get("HUGGINGFACE_TOKEN")
    is_local_model = os.path.exists(args.model)
    if not token and not is_local_model:
        print("HUGGINGFACE_TOKEN 또는 PYANNOTE_MODEL_PATH가 필요합니다.", file=sys.stderr)
        return 2

    pipeline = Pipeline.from_pretrained(args.model, token=token)
    output = pipeline(args.audio_path)
    diarization = getattr(output, "exclusive_speaker_diarization", None)
    if diarization is None:
        diarization = output.speaker_diarization

    turns = [
        {"start": float(turn.start), "end": float(turn.end), "speaker": str(speaker)}
        for turn, speaker in diarization
    ]
    print(json.dumps({"turns": turns}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
