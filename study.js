/*
 * study.js -- trial construction and CSV shaping. No DOM access, so it can be
 * unit tested with node (see selftest.mjs).
 *
 * The CSV columns match the desktop app's all_trials.csv exactly, plus a few
 * web-only ones at the end, so responses collected here can be dropped
 * straight into the existing results/ analysis.
 */

(function (root) {
  'use strict';

  // -- seeded RNG (xmur3 + mulberry32): same design intent as the desktop
  //    app's random.Random(seed) -- balanced and reproducible per participant.
  function hashSeed(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^= h >>> 16) >>> 0;
    };
  }

  function rng(seedStr) {
    let a = hashSeed(seedStr)();
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(arr, rand) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /*
   * One trial per (model pair, class). Which model goes on top alternates
   * within a pair and is then shuffled, so top/bottom stays balanced -- the
   * same scheme the desktop app uses.
   */
  function buildTrials(manifest, seed) {
    const trials = [];
    manifest.pairs.forEach(function (pair) {
      const a = pair[0], b = pair[1];
      const flags = manifest.classes.map(function (_, k) { return k % 2 === 0; });
      shuffle(flags, rng(seed + '|top|' + a + '|' + b));
      manifest.classes.forEach(function (cls, k) {
        trials.push({
          pair: [a, b],
          ci: k,
          top: flags[k] ? a : b,
          bottom: flags[k] ? b : a
        });
      });
    });
    shuffle(trials, rng(seed + '|order'));
    return trials;
  }

  function rowUrl(manifest, modelIndex, classIndex) {
    return 'rows/' + manifest.models[modelIndex].key + '/' +
           manifest.classes[classIndex].file;
  }

  function header(manifest) {
    return ['row_id', 'timestamp', 'participant', 'trial', 'pair', 'class_id',
            'class_label', 'class_file', 'top_model', 'bottom_model',
            'chosen_position', 'winner', 'loser']
      .concat(manifest.models.map(function (m) { return m.col; }))
      .concat(['response_ms', 'viewport', 'device_pixel_ratio', 'user_agent']);
  }

  /*
   * slot is 'top', 'bottom' or null for no preference. Model columns are
   * 1 = preferred, 0 = shown but not preferred, '' = not in this comparison.
   */
  function buildRow(manifest, opts) {
    const trial = opts.trial;
    const cls = manifest.classes[trial.ci];
    const topCol = manifest.models[trial.top].col;
    const botCol = manifest.models[trial.bottom].col;
    const winner = opts.slot === 'top' ? topCol : opts.slot === 'bottom' ? botCol : '';
    const loser = opts.slot === 'top' ? botCol : opts.slot === 'bottom' ? topCol : '';
    const pairCols = [topCol, botCol].sort();

    const row = {
      row_id: opts.participant + '-' + opts.trialNumber,
      timestamp: opts.timestamp,
      participant: opts.participant,
      trial: opts.trialNumber,
      pair: pairCols.join(' vs '),
      class_id: cls.class_id,
      class_label: cls.label,
      class_file: cls.src ? cls.src[manifest.models[trial.top].key] : cls.file,
      top_model: topCol,
      bottom_model: botCol,
      chosen_position: opts.slot || 'none',
      winner: winner,
      loser: loser,
      response_ms: opts.responseMs,
      viewport: opts.viewport,
      device_pixel_ratio: opts.dpr,
      user_agent: opts.userAgent
    };
    manifest.models.forEach(function (m) {
      row[m.col] = winner === '' ? (m.col === topCol || m.col === botCol ? 0 : '')
                                 : (m.col === winner ? 1 : (m.col === loser ? 0 : ''));
    });
    return row;
  }

  function toArray(manifest, row) {
    return header(manifest).map(function (k) {
      return row[k] === undefined || row[k] === null ? '' : row[k];
    });
  }

  /*
   * What should still be queued after a send succeeded.
   *
   * Deliberately compares whole rows, not positions and not row_ids:
   *  - rows added while the request was in flight sit after the sent ones, so
   *    dropping "the first N" only works if nothing else changed;
   *  - a participant who steps back and re-answers replaces a queued row in
   *    place, keeping its row_id but changing its content -- that revision has
   *    NOT been sent and must survive.
   */
  function removeSent(current, sent) {
    var seen = {};
    for (var i = 0; i < sent.length; i++) seen[JSON.stringify(sent[i])] = true;
    var left = [];
    for (var j = 0; j < current.length; j++) {
      if (!seen[JSON.stringify(current[j])]) left.push(current[j]);
    }
    return left;
  }

  function csvEscape(v) {
    const s = String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCsv(manifest, rows) {
    const lines = [header(manifest).map(csvEscape).join(',')];
    rows.forEach(function (r) {
      lines.push(toArray(manifest, r).map(csvEscape).join(','));
    });
    return lines.join('\r\n') + '\r\n';
  }

  root.Study = {
    rng: rng, shuffle: shuffle, buildTrials: buildTrials, rowUrl: rowUrl,
    header: header, buildRow: buildRow, toArray: toArray, toCsv: toCsv,
    removeSent: removeSent
  };
})(typeof window !== 'undefined' ? window : globalThis);
