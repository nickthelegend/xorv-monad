// Captions are transcribed from the synthesized audio, so proper nouns come
// back as whatever the recognizer heard: "Zorv", "Hetera's", "Heterotestnet".
// A launch video cannot misspell its own product. This corrects the word text
// in place, leaving every timing untouched, and re-applies the skin overrides
// that a captions rebuild would otherwise revert.
import fs from "node:fs";

const WORDS = [
  [/^Zorv$/i, "Xorv"],
  [/^ZORV$/, "XORV"],
  [/^Hetera'?s$/i, "Hedera's"],
  [/^Hetera$/i, "Hedera"],
  [/^Heterotestnet\.?$/i, "Hedera testnet."],
  [/^Hbar\.?$/i, "HBAR."],
  [/^Quota$/, "quota"],
  [/^Idle$/, "Idle"],
];

const path = "caption_groups.json";
const doc = JSON.parse(fs.readFileSync(path, "utf8"));
const groups = Array.isArray(doc) ? doc : doc.groups ?? [];
let fixed = 0;
for (const g of groups) {
  for (const w of g.words ?? []) {
    const key = "text" in w ? "text" : "word";
    const before = w[key];
    if (typeof before !== "string") continue;
    for (const [re, to] of WORDS) {
      if (re.test(before)) {
        w[key] = before.replace(re, to);
        if (w[key] !== before) fixed++;
        break;
      }
    }
  }
  if (typeof g.text === "string") {
    let t = g.text;
    for (const [re, to] of WORDS) t = t.replace(new RegExp(re.source, "gi"), to);
    g.text = t;
  }
}
fs.writeFileSync(path, JSON.stringify(doc, null, 2));
console.log(`caption words corrected: ${fixed}`);
