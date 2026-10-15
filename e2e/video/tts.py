"""Render each narration line with ElevenLabs (with character timestamps), one MP3 per line.

Writes <work>/vo/<id>.mp3 and <work>/vo/lines.json: id, part, beat, text, seconds, words[(word, start, end)].
Unchanged lines are reused, so editing one line re-voices only that line.

  python3 e2e/video/tts.py <work dir> [voice id override]
"""
import base64, json, os, subprocess, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
work = sys.argv[1]
spec = json.load(open(os.path.join(HERE, "script.json")))
voice = sys.argv[2] if len(sys.argv) > 2 else spec["voice"]
key = os.environ["ELEVENLABS_API_KEY"]
out_dir = os.path.join(work, "vo")
os.makedirs(out_dir, exist_ok=True)
manifest = os.path.join(out_dir, "lines.json")
prev = {l["id"]: l for l in json.load(open(manifest))} if os.path.exists(manifest) else {}

def words_from(alignment):
    chars, starts, ends = alignment["characters"], alignment["character_start_times_seconds"], alignment["character_end_times_seconds"]
    words, cur, t0 = [], "", None
    for c, s, e in zip(chars, starts, ends):
        if c.isspace():
            if cur: words.append((cur, t0, last)); cur = ""
            continue
        if not cur: t0 = s
        cur += c; last = e
    if cur: words.append((cur, t0, last))
    return words

out = []
for line in spec["lines"]:
    path = os.path.join(out_dir, f"{line['id']}.mp3")
    old = prev.get(line["id"])
    if old and old["text"] == line["text"] and old.get("voice") == voice and os.path.exists(path):
        out.append(old); continue
    body = json.dumps({"text": line["text"], "model_id": spec["model"], "voice_settings": {"stability": 0.55, "similarity_boost": 0.75, "style": 0.15}}).encode()
    req = urllib.request.Request(f"https://api.elevenlabs.io/v1/text-to-speech/{voice}/with-timestamps?output_format=mp3_44100_128",
                                 data=body, headers={"xi-api-key": key, "Content-Type": "application/json"})
    res = json.load(urllib.request.urlopen(req, timeout=120))
    open(path, "wb").write(base64.b64decode(res["audio_base64"]))
    secs = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]).decode())
    out.append({**line, "voice": voice, "seconds": secs, "words": words_from(res["alignment"])})
    print(f"{line['id']}: {secs:.1f}s")
json.dump(out, open(manifest, "w"), indent=2)
print("total", round(sum(l["seconds"] for l in out), 1), "s")
