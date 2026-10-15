"""Shared timing: caption chunks from word timestamps, and the intro/outro card timelines.

  python3 e2e/video/timeline.py <work dir>   -> <work>/cards-intro.json, <work>/cards-outro.json
"""
import json, os, sys

GAP = 0.45  # silence between narration lines, seconds

def chunks(words, offset, max_words=7):
    """Caption chunks: up to max_words, broken early after punctuation."""
    out, cur = [], []
    for w in words:
        cur.append(w)
        if len(cur) >= max_words or (w[0][-1] in ".,:;!?" and len(cur) >= 3):
            out.append(cur); cur = []
    if cur: out.append(cur)
    return [{"start": round(offset + c[0][1], 3), "end": round(offset + c[-1][2] + 0.25, 3), "text": " ".join(x[0] for x in c)} for c in out]

def card_timeline(lines, lead=0.6, tail=1.0):
    t, scenes, caps, audio = lead, [], [], []
    for l in lines:
        scenes.append({"id": l["id"], "start": round(t - (lead if not scenes else 0.2), 3), "end": round(t + l["seconds"] + GAP, 3)})
        caps += chunks(l["words"], t)
        audio.append({"id": l["id"], "at": round(t, 3)})
        t += l["seconds"] + GAP
    length = round(t - GAP + tail, 3)
    scenes[-1]["end"] = length + 1
    return {"scenes": scenes, "captions": caps, "audio": audio, "length": length}

if __name__ == "__main__":
    work = sys.argv[1]
    lines = json.load(open(os.path.join(work, "vo", "lines.json")))
    intro = card_timeline([l for l in lines if l["part"] == "intro"])
    outro = card_timeline([l for l in lines if l["part"] == "outro"], tail=2.0)
    outro["tag"] = True; outro["hideBrand"] = True
    json.dump(intro, open(os.path.join(work, "cards-intro.json"), "w"), indent=1)
    json.dump(outro, open(os.path.join(work, "cards-outro.json"), "w"), indent=1)
    print("intro", intro["length"], "s; outro", outro["length"], "s")
