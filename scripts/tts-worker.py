import json
import os
import sys
import time
import traceback
from pathlib import Path
from urllib.parse import quote

os.environ.setdefault("PYTHONUTF8", "1")
device_requested = os.environ.get("SUBLABS_TTS_DEVICE", "cuda").lower()


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def download_model_file(relative_path):
    import requests

    model_root = Path(os.environ.get("HF_HOME", ".")) / "local" / "ThonburianTTS"
    destination = model_root / relative_path
    if destination.exists() and destination.stat().st_size:
        return destination

    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(destination.suffix + ".part")
    url = "https://huggingface.co/biodatlab/ThonburianTTS/resolve/main/" + quote(relative_path)
    for attempt in range(12):
        existing = partial.stat().st_size if partial.exists() else 0
        headers = {"Range": f"bytes={existing}-"} if existing else {}
        try:
            with requests.get(url, headers=headers, stream=True, timeout=(30, 120)) as response:
                response.raise_for_status()
                resumed = existing > 0 and response.status_code == 206
                if existing and not resumed:
                    existing = 0
                total = int(response.headers.get("content-length", "0")) + (existing if resumed else 0)
                mode = "ab" if resumed else "wb"
                downloaded = existing
                last_percent = -1
                with partial.open(mode) as output:
                    for chunk in response.iter_content(chunk_size=4 * 1024 * 1024):
                        if not chunk:
                            continue
                        output.write(chunk)
                        downloaded += len(chunk)
                        percent = int(downloaded * 100 / total) if total else 0
                        if percent != last_percent:
                            emit({"type": "startup_progress", "label": "กำลังดาวน์โหลดโมเดลเสียงไทย", "progress": percent})
                            last_percent = percent
            break
        except requests.RequestException:
            if attempt == 11:
                raise
            emit({"type": "startup_progress", "label": "การเชื่อมต่อสะดุด กำลังดาวน์โหลดต่อ", "progress": 0})
            time.sleep(min(2 + attempt, 10))
    partial.replace(destination)
    return destination


try:
    checkpoint = download_model_file("megaF5/mega_f5_last.safetensors")
    vocab_file = download_model_file("megaF5/mega_vocab.txt")

    import torch
    from flowtts.inference import FlowTTSPipeline, ModelConfig, AudioConfig

    device = "cuda" if device_requested == "cuda" and torch.cuda.is_available() else "cpu"
    if device_requested == "cuda" and device != "cuda":
        raise RuntimeError("CUDA is not available")

    model_config = ModelConfig(
        language="th",
        model_type="F5",
        checkpoint=str(checkpoint),
        vocab_file=str(vocab_file),
        ode_method="euler",
        use_ema=True,
        vocoder="vocos",
        device=device,
    )
    audio_config = AudioConfig(
        silence_threshold=-45,
        max_audio_length=20000,
        cfg_strength=2.5,
        nfe_step=32,
        target_rms=0.1,
        cross_fade_duration=0.15,
        speed=1.0,
        min_silence_len=500,
        keep_silence=200,
        seek_step=10,
    )
    temp_dir = Path(os.environ.get("HF_HOME", ".")) / "temp"
    temp_dir.mkdir(parents=True, exist_ok=True)
    pipeline = FlowTTSPipeline(model_config=model_config, audio_config=audio_config, temp_dir=str(temp_dir))
    emit({"type": "ready", "device": device})
except Exception as error:
    emit({"type": "startup_error", "error": f"{error}\n{traceback.format_exc()[-3000:]}"})
    raise


for line in sys.stdin:
    try:
        request = json.loads(line)
        seed = request.get("seed")
        if seed is not None:
            import random
            random.seed(int(seed))
            torch.manual_seed(int(seed))
            if torch.cuda.is_available():
                torch.cuda.manual_seed_all(int(seed))
        output = Path(request["outputPath"])
        output.parent.mkdir(parents=True, exist_ok=True)
        result = pipeline(
            text=str(request["text"]),
            ref_voice=str(request["referencePath"]),
            ref_text=str(request["referenceText"]),
            output_file=str(output),
            speed=float(request.get("speed", 1.0)),
            check_duration=True,
        )
        emit({"id": request["id"], "ok": True, "outputPath": str(result or output), "device": device})
    except Exception as error:
        if device == "cuda":
            try:
                torch.cuda.empty_cache()
            except Exception:
                pass
        emit({"id": request.get("id"), "ok": False, "error": f"{error}\n{traceback.format_exc()[-3000:]}"})
