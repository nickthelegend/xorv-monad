"""Cut the Metropolis video: intro card + narrated live demo + outro card, H.264 + AAC at -16 LUFS, 1080p.

Inputs in <work>: intro.webm/outro.webm (render-cards.mjs, with their start offsets), cards-*.json (timeline.py),
demo.webm + beats.json (capture-demo.mjs), vo/*.mp3 + vo/lines.json (tts.py).
Writes <out>.mp4 and <out>.srt. Captions are already in the picture (rendered in the page from the same
word timestamps); the .srt carries the same text for players and the portal.

  python3 e2e/video/assemble.py <work dir> <out path without extension> <intro offset s> <outro offset s>
"""
import json, os, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from timeline import chunks, GAP

work, out, intro_off, outro_off = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
lines = {l["id"]: l for l in json.load(open(os.path.join(work, "vo", "lines.json")))}
by_beat = {l["beat"]: l for l in lines.values() if l["part"] == "demo"}
intro = json.load(open(os.path.join(work, "cards-intro.json")))
outro = json.load(open(os.path.join(work, "cards-outro.json")))
cap = json.load(open(os.path.join(work, "beats.json")))
beats = cap["beats"]
demo_start = max(0.0, beats["network"] - 1.5)
demo_len = beats["end"] - demo_start

def run(*args):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *args], check=True)

def segment(name, video, ss, length, clips):
    """Trim the picture and lay the narration clips (id, seconds into the segment) under it."""
    inputs = ["-ss", f"{ss:.3f}", "-t", f"{length:.3f}", "-i", video]
    for cid, _ in clips:
        inputs += ["-i", os.path.join(work, "vo", f"{cid}.mp3")]
    parts = [f"[{i + 1}:a]adelay={int(at * 1000)}|{int(at * 1000)},aformat=sample_rates=48000:channel_layouts=stereo[a{i}]" for i, (_, at) in enumerate(clips)]
    mix = "".join(f"[a{i}]" for i in range(len(clips)))
    fc = ";".join(parts + [f"{mix}amix=inputs={len(clips)}:normalize=0,apad,atrim=0:{length:.3f}[aout]", "[0:v]fps=30,scale=1920:1080,format=yuv420p[vout]"])
    path = os.path.join(work, f"seg-{name}.mp4")
    run(*inputs, "-filter_complex", fc, "-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", path)
    return path

segs = [
    segment("intro", os.path.join(work, "intro.webm"), intro_off, intro["length"], [(a["id"], a["at"]) for a in intro["audio"]]),
    segment("demo", os.path.join(work, "demo.webm"), demo_start, demo_len, [(by_beat[b]["id"], beats[b] - demo_start) for b in by_beat if b in beats]),
    segment("outro", os.path.join(work, "outro.webm"), outro_off, outro["length"], [(a["id"], a["at"]) for a in outro["audio"]]),
]
listing = os.path.join(work, "concat.txt")
open(listing, "w").write("".join(f"file '{p}'\n" for p in segs))
joined = os.path.join(work, "joined.mp4")
run("-f", "concat", "-safe", "0", "-i", listing, "-c", "copy", joined)
run("-i", joined, "-c:v", "copy", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", out + ".mp4")

# The .srt, from the same word timings the picture used.
def stamp(t):
    h, m, s = int(t // 3600), int(t % 3600 // 60), t % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}".replace(".", ",")
cues = list(intro["captions"])
off = intro["length"]
for b, l in by_beat.items():
    if b in beats:
        cues += chunks(l["words"], off + beats[b] - demo_start)
off += demo_len
cues += [{**c, "start": c["start"] + off, "end": c["end"] + off} for c in outro["captions"]]
cues.sort(key=lambda c: c["start"])
for a_, b_ in zip(cues, cues[1:]):
    a_["end"] = min(a_["end"], b_["start"] - 0.01)  # one caption at a time
open(out + ".srt", "w").write("\n".join(f"{i + 1}\n{stamp(c['start'])} --> {stamp(c['end'])}\n{c['text']}\n" for i, c in enumerate(cues)))
dur = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out + ".mp4"]).decode())
print(f"{out}.mp4  {dur:.1f} s  ({len(cues)} captions)")
if dur > 180:
    sys.exit(f"too long: {dur:.1f} s > 180 s")
