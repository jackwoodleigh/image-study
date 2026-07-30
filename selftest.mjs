/*
 * Self-check for the web study logic:  node web/selftest.mjs
 * Verifies the trial design and that the CSV columns line up with the
 * desktop app's all_trials.csv.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ctx = { window: {}, console };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(readFileSync(join(HERE, 'manifest.js'), 'utf8'), ctx);
vm.runInContext(readFileSync(join(HERE, 'study.js'), 'utf8'), ctx);
const { Study } = ctx.window;
const M = ctx.window.STUDY_MANIFEST;

assert.ok(M && M.classes.length, 'manifest.js is empty -- run python make_web.py');
console.log(`manifest: ${M.models.length} models, ${M.classes.length} classes, ` +
            `${M.pairs.length} pairs`);

// -- trial design ---------------------------------------------------------
const trials = Study.buildTrials(M, 'w-abc123');
assert.equal(trials.length, M.pairs.length * M.classes.length);
for (const t of trials) {
  assert.notEqual(t.top, t.bottom);
  assert.deepEqual([t.top, t.bottom].sort(), [...t.pair].sort());
}
for (const [a, b] of M.pairs) {                       // top/bottom balanced per pair
  const mine = trials.filter(t => t.pair[0] === a && t.pair[1] === b);
  assert.equal(mine.length, M.classes.length);
  const tops = mine.filter(t => t.top === a).length;
  assert.ok(Math.abs(tops - (mine.length - tops)) <= 1, `unbalanced: ${a}v${b} ${tops}`);
  assert.equal(new Set(mine.map(t => t.ci)).size, M.classes.length, 'a class repeats');
}
console.log(`[ok] ${trials.length} trials, every pair balanced top/bottom, ` +
            'each class once per pair');

// same participant -> same design; different participant -> different order
const again = Study.buildTrials(M, 'w-abc123');
assert.deepEqual(again, trials, 'not reproducible for one participant');
const other = Study.buildTrials(M, 'w-zzz999');
assert.notDeepEqual(other.map(t => t.ci + ':' + t.top), trials.map(t => t.ci + ':' + t.top));
console.log('[ok] design reproducible per participant, differs between participants');

// pairs are interleaved rather than run as blocks
const firstThird = trials.slice(0, Math.ceil(trials.length / 3)).map(t => t.pair.join('-'));
assert.ok(new Set(firstThird).size > 1, 'pairs appear to run in blocks');
console.log('[ok] pairs interleaved');

// -- CSV shape ------------------------------------------------------------
const header = Study.header(M);
const desktop = ['timestamp', 'participant', 'trial', 'pair', 'class_id', 'class_label',
                 'class_file', 'top_model', 'bottom_model', 'chosen_position',
                 'winner', 'loser', ...M.models.map(m => m.col), 'response_ms'];
for (const col of desktop) assert.ok(header.includes(col), `missing column ${col}`);
assert.equal(header[0], 'row_id');
console.log('[ok] header covers every desktop column:', header.join(','));

const rows = trials.map((t, i) => Study.buildRow(M, {
  trial: t, slot: i % 3 === 0 ? 'bottom' : 'top', participant: 'w-abc123', trialNumber: i + 1,
  timestamp: '2026-07-29 12:00:00', responseMs: 1234, viewport: '1600x900', dpr: 2,
  userAgent: 'node'
}));
const cols = M.models.map(m => m.col);
for (const r of rows) {
  assert.ok(r.winner && r.loser && r.winner !== r.loser);
  assert.deepEqual([r.winner, r.loser].sort(), [r.top_model, r.bottom_model].sort());
  assert.equal(r.winner, r.chosen_position === 'top' ? r.top_model : r.bottom_model);
  assert.equal(r[r.winner], 1);
  assert.equal(r[r.loser], 0);
  const absent = cols.filter(c => c !== r.winner && c !== r.loser);
  for (const c of absent) assert.equal(r[c], '', 'absent model must be blank, not 0');
  assert.equal(r.pair, [r.top_model, r.bottom_model].sort().join(' vs '));
}
assert.equal(new Set(rows.map(r => r.row_id)).size, rows.length, 'row_id not unique');
console.log('[ok] every row: one winner, absent model blank, unique row_id');

// tallies must reconstruct the matrix the desktop app would build
const wins = {};
for (const r of rows) wins[r.winner + '>' + r.loser] = (wins[r.winner + '>' + r.loser] || 0) + 1;
for (const [a, b] of M.pairs) {
  const A = M.models[a].col, B = M.models[b].col;
  assert.equal((wins[A + '>' + B] || 0) + (wins[B + '>' + A] || 0), M.classes.length);
}
console.log('[ok] per-pair totals reconstruct to', M.classes.length, 'per pair:', wins);

// -- CSV text -------------------------------------------------------------
const csv = Study.toCsv(M, rows);
const lines = csv.trim().split('\r\n');
assert.equal(lines.length, rows.length + 1);
assert.equal(lines[0], header.join(','));
const quoted = Study.toCsv(M, [{ ...rows[0], class_label: 'a,b "c"' }]).split('\r\n')[1];
assert.ok(quoted.includes('"a,b ""c"""'), quoted);
console.log('[ok] CSV renders and escapes commas/quotes');

console.log('\nALL CHECKS PASSED');
