// captions.html embeds its own GROUPS array, so the same proper-noun
// corrections have to land here too — and the skin overrides have to be
// re-applied, because a captions rebuild regenerates this file from the
// preset skin and silently reverts them.
import fs from "node:fs";
const path = "compositions/captions.html";
let s = fs.readFileSync(path, "utf8");

// 1. Proper nouns the recognizer got wrong.
const WORDS = [
  ["Heterotestnet", "Hedera testnet"],
  ["heterotestnet", "Hedera testnet"],
  ["Hetera's", "Hedera's"],
  ["Hetera", "Hedera"],
  ["ZORV", "XORV"],
  ["Zorv", "Xorv"],
];
let n = 0;
for (const [bad, good] of WORDS) {
  const hits = s.split(bad).length - 1;
  if (hits) { s = s.split(bad).join(good); n += hits; }
}

// 2. The active word must be dark ink on the accent block, never white-on-accent.
s = s.replace(/(\.caption-word\.is-active\s*\{\s*)color: var\(--cap-ink[^;]*\);/, "$1color: #000000;");
// 3. The skin's accent maps to --warn here; force the brand's live green.
s = s.replace(/--cap-accent:\s*#FBBF24;/, "--cap-accent: #4ADE80;");
s = s.replace(/box-shadow: 0 0 0 0\.06em var\(--cap-accent, #e85d26\);/, "box-shadow: 0 0 0 0.06em var(--cap-accent, #4ADE80);");
// 4. The preset pill is a white slab (--cap-ink); this video is black + hairline.
s = s.replace(/background: var\(--cap-ink, #111111\);/, "background: rgba(10,10,10,0.92);\n    border: 1px solid rgba(255,255,255,0.09);");
// 5. Upcoming / spoken / numeric words, legible on the dark band.
s = s.replace(/color: color-mix\(in srgb, var\(--cap-canvas, #f0ece5\) 42%, var\(--cap-ink, #111111\)\);/, "color: #8A8A8A;");
s = s.replace(/color: color-mix\(in srgb, var\(--cap-canvas, #f0ece5\) 72%, var\(--cap-ink, #111111\)\);/, "color: #BDBDBD;");
s = s.replace(/(\.caption-word\.is-spoken\s*\{\s*)color: var\(--cap-canvas[^;]*\);/, "$1color: #FAFAFA;");

fs.writeFileSync(path, s);
console.log(`captions.html: ${n} proper-noun fix(es) + skin overrides re-applied`);
