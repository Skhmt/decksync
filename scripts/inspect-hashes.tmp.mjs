import { readFileSync } from 'node:fs';

const OLD_CARDS = [
  'Black Lotus', 'Serra Angel', 'Mox Pearl', 'Mox Sapphire', 'Mox Ruby',
  'Ancestral Recall', 'Time Warp', 'Force of Will', 'Library of Alexandria',
  'Tinker', 'Burning Tree', 'Ponder', "Gaea's Cradle", 'The Mending',
  'Lightning Bolt', 'Counterspell', 'Brainstorm', 'Daze'
];

// Header: magic(4) version(u32) region(4xf64) threshold(u32) = 44 bytes.
function inspect(file) {
  const buf = readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'DCH1') throw new Error('not DCH1');
  const threshold = buf.readUInt32LE(40);
  const region = { x0: buf.readDoubleLE(8), y0: buf.readDoubleLE(16), x1: buf.readDoubleLE(24), y1: buf.readDoubleLE(32) };
  const records = [];
  let pos = 44;
  while (pos + 4 <= buf.length) {
    const bodyLen = buf.readUInt32LE(pos);
    if (bodyLen < 8 || pos + 4 + bodyLen > buf.length) break;
    let o = pos + 4;
    const idLen = buf.readUInt16LE(o); o += 2;
    const id = buf.toString('utf8', o, o + idLen); o += idLen;
    const face = buf.readUInt32LE(o); o += 4;
    const nameLen = buf.readUInt16LE(o); o += 2;
    const name = buf.toString('utf8', o, o + nameLen); o += nameLen;
    let totalHashes = 0;
    while (o < pos + 4 + bodyLen) {
      const count = buf.readUInt16LE(o); o += 2;
      totalHashes += count;
      o += count * 8;
    }
    records.push({ id, name, face, totalHashes });
    pos = o;
  }
  return { threshold, region, records };
}

const results = {};
for (const file of ['public/card-hashes.bin', 'public/card-hashes.bin.bak']) {
  try {
    const { threshold, region, records } = inspect(file);
    const names = new Set(records.map(r => r.name.toLowerCase()));
    const ids = new Set(records.map(r => r.id));
    const byName = new Map();
    for (const r of records) byName.set(r.name.toLowerCase(), r.totalHashes);
    const counts = records.map(r => r.totalHashes);
    const min = Math.min(...counts), max = Math.max(...counts), avg = (counts.reduce((a,b)=>a+b,0)/counts.length).toFixed(1);
    console.log(`\n=== ${file} ===`);
    console.log(`entries=${records.length}  uniqueIds=${ids.size}  threshold=${threshold}`);
    console.log(`totalHashes/entry: min=${min} max=${max} avg=${avg}`);
    const missing = OLD_CARDS.filter(n => !names.has(n.toLowerCase()));
    console.log(`old-card coverage: ${OLD_CARDS.length - missing.length}/${OLD_CARDS.length}  MISSING: ${missing.join(', ') || '(none)'}`);
    results[file] = { byName, names };
  } catch (e) {
    console.log(`\n=== ${file} === ERROR: ${e.message}`);
  }
}

// Side-by-side hash-variant count for old cards present in both.
const cur = results['public/card-hashes.bin'];
const bak = results['public/card-hashes.bin.bak'];
if (cur && bak) {
  console.log(`\n=== per-card variant counts (current vs backup) ===`);
  for (const n of OLD_CARDS) {
    const k = n.toLowerCase();
    if (cur.names.has(k)) console.log(`  ${n.padEnd(26)} cur=${String(cur.byName.get(k)).padStart(3)}  bak=${String(bak.byName.get(k) ?? '?').padStart(3)}`);
  }
}

