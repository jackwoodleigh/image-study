/*
 * Checks the Apps Script statistics against the desktop app's analysis:
 *   node web/summary_selftest.mjs
 *
 * Loads apps_script.gs with the Google services stubbed out, feeds it the real
 * results/all_trials.csv, and compares the ranking, matrix and p-values with
 * the numbers preference_study.py wrote into results/matrix.csv. The Sheet must
 * agree with the offline analysis, or the two tell different stories.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

// --- load the Apps Script file as plain JS, with Google services absent ----
const ctx = { console, Math, Number, String, Date, isNaN, JSON, Utilities: {} };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(readFileSync(join(HERE, 'apps_script.gs'), 'utf8'), ctx);
const { computeStats, summaryLayout, binomTwoSided, modelColumns, matrixCell,
        contentSignature } = ctx;

// --- the binomial test must match Python's math.comb version ---------------
const closeTo = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
assert.ok(closeTo(binomTwoSided(5, 10), 1));
assert.ok(closeTo(binomTwoSided(7, 10), 0.34375));
assert.ok(closeTo(binomTwoSided(6, 10), 0.75390625));
assert.ok(closeTo(binomTwoSided(9, 10), 0.021484375));
assert.ok(closeTo(binomTwoSided(10, 10), 2 / 1024));
assert.ok(closeTo(binomTwoSided(0, 10), 2 / 1024));      // symmetric in k
assert.ok(binomTwoSided(600, 1000) < 1e-9);              // no overflow at scale
assert.ok(closeTo(binomTwoSided(0, 0), 1));
console.log('[ok] two-sided binomial matches the Python values, no overflow');

// --- feed it the real study data -------------------------------------------
const csvPath = join(ROOT, 'results', 'all_trials.csv');
if (!existsSync(csvPath)) {
  console.log(`\nSkipped the comparison against results/: no ${csvPath}`);
  process.exit(0);
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1);
}

const table = parseCsv(readFileSync(csvPath, 'utf8'));
const header = table[0];
const rows = table.slice(1);
const cols = modelColumns(header);
assert.ok(cols.length >= 2, `no model columns in ${csvPath}: ${header}`);

const stats = computeStats(header, rows);
assert.equal(stats.used, rows.length, 'some rows were ignored unexpectedly');
console.log(`[ok] parsed ${rows.length} comparisons, models: ${cols.join(', ')}`);

// every pair total must equal the number of rows for that pair
let pairTotal = 0;
stats.h2h.forEach(e => {
  assert.equal(e.wins_a + e.wins_b + e.ties, e.n);
  pairTotal += e.n;
});
assert.equal(pairTotal, rows.length, 'pair tallies do not add up to the rows');

// --- compare with what preference_study.py wrote ---------------------------
const mtxPath = join(ROOT, 'results', 'matrix.csv');
if (existsSync(mtxPath)) {
  const m = parseCsv(readFileSync(mtxPath, 'utf8')).concat(
    readFileSync(mtxPath, 'utf8').split(/\r?\n/).map(l => [l]));
  const lines = readFileSync(mtxPath, 'utf8').split(/\r?\n/);

  // ranking block: "rank,model,wins,comparisons,win_rate,..."
  const rankStart = lines.findIndex(l => l.startsWith('rank,model'));
  assert.ok(rankStart > 0, 'no ranking block in results/matrix.csv');
  const pyRank = [];
  for (let i = rankStart + 1; i < lines.length && lines[i] && !lines[i].startsWith('#'); i++) {
    const f = parseCsv(lines[i] + '\n')[0];
    pyRank.push({ rank: +f[0], model: f[1], wins: +f[2], comparisons: +f[3], rate: +f[4] });
  }
  assert.equal(pyRank.length, stats.ranking.length);
  stats.ranking.forEach((r, i) => {
    assert.equal(r.model, pyRank[i].model, `rank ${i + 1}: ${r.model} vs ${pyRank[i].model}`);
    assert.equal(r.rank, pyRank[i].rank);
    assert.equal(r.wins, pyRank[i].wins);
    assert.equal(r.comparisons, pyRank[i].comparisons);
    assert.ok(closeTo(r.rate, pyRank[i].rate, 5e-4), `${r.model}: ${r.rate} vs ${pyRank[i].rate}`);
  });
  console.log('[ok] ranking identical to results/matrix.csv: ' +
    stats.ranking.map(r => `${r.rank}. ${r.model} ${(r.rate * 100).toFixed(1)}%`).join('  '));

  // head-to-head block, including the p-values
  const h2hStart = lines.findIndex(l => l.startsWith('verdict,'));
  assert.ok(h2hStart > 0);
  const pyH2h = [];
  for (let i = h2hStart + 1; i < lines.length && lines[i] && !lines[i].startsWith('#'); i++) {
    const f = parseCsv(lines[i] + '\n')[0];
    pyH2h.push({ preferred: f[1], over: f[2], score: f[3], rate: +f[4], p: +f[6] });
  }
  assert.equal(pyH2h.length, stats.h2h.length);
  stats.h2h.forEach((e, i) => {
    const py = pyH2h[i];
    if (!e.drawn) {
      assert.equal(e.top, py.preferred);
      assert.equal(e.bottom, py.over);
      assert.equal(`${e.top_wins}-${e.bottom_wins}`, py.score);
    }
    assert.ok(closeTo(e.rate, py.rate, 5e-4));
    assert.ok(closeTo(e.p, py.p, 5e-4), `p for ${e.top} vs ${e.bottom}: ${e.p} vs ${py.p}`);
  });
  console.log('[ok] head-to-head and p-values identical: ' +
    stats.h2h.map(e => `${e.top} ${e.top_wins}-${e.bottom_wins} p=${e.p.toFixed(4)}`).join('  ·  '));

  // matrix block [1] -- lower triangle only
  const mStart = lines.findIndex((l, i) => i > 12 && l.startsWith(',' + cols[0]));
  assert.ok(mStart > 0, 'no count matrix in results/matrix.csv');
  cols.forEach((rm, i) => {
    const f = parseCsv(lines[mStart + 1 + i] + '\n')[0];
    cols.forEach((cm, j) => {
      const cell = matrixCell(stats, rm, cm);
      if (j >= i) assert.equal(cell, null, `(${rm},${cm}) should be outside the triangle`);
      else assert.equal(cell.wins, +f[j + 1], `matrix (${rm},${cm})`);
    });
  });
  console.log('[ok] lower-triangle matrix identical, diagonal and upper half empty');
} else {
  console.log('   (no results/matrix.csv to compare against -- skipped)');
}

// --- the layout the Sheet gets -------------------------------------------
const lay = summaryLayout(stats, { updated: '2026-07-30 12:00' });
assert.ok(lay.grid.length > 10);
assert.equal(lay.heads.length, 5, 'expected 5 section headings');

/*
 * Every number format is applied by anchor, so each anchor must really point at
 * its header row and each formatted column must really hold that kind of value.
 * Getting this wrong is what printed "comparisons = 2000.0%".
 */
// Array.from: the grid comes from the vm context, so its arrays have a
// different Array prototype and deepStrictEqual would reject them.
const at = (row) => Array.from(lay.grid[row - 1] || []);      // anchors are 1-based
assert.equal(at(lay.titleRow)[0], 'Study results');
assert.deepEqual(at(lay.rank.header),
  ['rank', 'model', 'wins', 'comparisons', 'win rate', 'beats', 'loses to', 'note']);
assert.equal(at(lay.rank.header)[lay.rank.rateCol - 1], 'win rate',
  'rank.rateCol does not point at the win rate column');
assert.deepEqual(at(lay.h2h.header),
  ['preferred', 'over', 'score', 'rate', 'ties', 'p (two-sided)', 'significant?']);
assert.equal(at(lay.h2h.header)[lay.h2h.rateCol - 1], 'rate');
assert.equal(at(lay.h2h.header)[lay.h2h.pCol - 1], 'p (two-sided)');
assert.equal(at(lay.h2h.header).length, lay.h2h.width);
assert.equal(at(lay.part.header)[0], 'participant');
assert.equal(at(lay.part.header)[lay.part.firstRateCol - 1], cols[0] + ' win rate');

// the values under those anchors must be of the right kind
for (let i = 1; i <= lay.rank.rows; i++) {
  const r = at(lay.rank.header + i);
  assert.ok(Number.isInteger(r[2]) && Number.isInteger(r[3]),
    `ranking row ${i}: wins/comparisons must be counts, got ${r[2]}/${r[3]}`);
  assert.ok(r[4] >= 0 && r[4] <= 1, `ranking row ${i}: win rate ${r[4]} is not a fraction`);
  assert.ok(r[3] >= r[2], 'comparisons cannot be fewer than wins');
}
for (let i = 1; i <= lay.h2h.rows; i++) {
  const r = at(lay.h2h.header + i);
  assert.ok(r[3] >= 0 && r[3] <= 1, `h2h row ${i}: rate ${r[3]} is not a fraction`);
  assert.ok(r[5] >= 0 && r[5] <= 1, `h2h row ${i}: p ${r[5]} is not a probability`);
  assert.ok(r[6] === 'YES' || r[6] === 'no');
}
for (let i = 1; i <= lay.part.rows; i++) {
  const r = at(lay.part.header + i);
  assert.ok(Number.isInteger(r[1]), 'participant comparisons must be a count');
  for (let c = 0; c < cols.length; c++) {
    const v = r[lay.part.firstRateCol - 1 + c];
    assert.ok(v === '' || (v >= 0 && v <= 1), `participant rate ${v} is not a fraction`);
  }
}
assert.ok(!lay.rank.rows || at(lay.rank.header + lay.rank.rows + 1).length === 0,
  'the ranking block runs past its row count');
console.log('[ok] layout anchors point at the right rows and value kinds');
const flat = lay.grid.map(r => r.join('|'));
['Ranking', 'Head to head', 'Preference matrix', 'Preference rate matrix', 'Per participant']
  .forEach(h => assert.ok(flat.some(l => l === h || l.startsWith(h + '|')), `missing "${h}"`));
lay.boxes.forEach(b => {
  assert.equal(b.rows, cols.length + 1);
  assert.equal(b.cols, cols.length + 1);
});
assert.equal(lay.rateCells.length, (cols.length * (cols.length - 1)) / 2);
// per-participant rates must be between 0 and 1
stats.participants.forEach(P => {
  cols.forEach(c => {
    if (P.shown[c]) {
      const rate = P.wins[c] / P.shown[c];
      assert.ok(rate >= 0 && rate <= 1, `${P.pid} ${c} rate ${rate}`);
    }
  });
  assert.ok(P.median_ms >= 0);
});
console.log(`[ok] summary layout: ${lay.grid.length} rows, 5 sections, ` +
            `${stats.participants.length} participant row(s)`);

/*
 * The auto-update trigger relies on this: rebuilding the Summary must not change
 * the responses signature (or the rebuild would trigger itself forever), while
 * any real edit or deletion must change it.
 */
const base = [header].concat(rows);
assert.equal(contentSignature(base), contentSignature(base.map(r => r.slice())),
  'signature is not stable for identical data');
assert.notEqual(contentSignature(base), contentSignature(base.slice(0, -1)),
  'deleting a row must change the signature');
const edited = base.map(r => r.slice());
const wi = header.indexOf('winner');
edited[1][wi] = edited[1][wi] === cols[0] ? cols[1] : cols[0];
assert.notEqual(contentSignature(base), contentSignature(edited),
  'editing a winner must change the signature');
const cosmetic = base.map(r => r.slice());
const ui = header.indexOf('user_agent');
if (ui >= 0) {
  cosmetic[1][ui] = 'something else entirely';
  assert.equal(contentSignature(base), contentSignature(cosmetic),
    'a column the stats ignore should not force a rebuild');
}
assert.equal(contentSignature([]), 'empty');
console.log('[ok] content signature: stable on rewrite, changes on edit/delete');

console.log('\nALL CHECKS PASSED');
