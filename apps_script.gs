/*
 * apps_script.gs -- the whole "backend" for the study.
 *
 * Paste into Extensions > Apps Script of a new Google Sheet, then
 * Deploy > New deployment > Web app,  Execute as: Me,
 * Who has access: Anyone.  Copy the /exec URL into CONFIG.endpoint in
 * index.html.
 *
 * Sheet 1 ("Responses"): one row per comparison, appended as they arrive.
 *   row_id is checked first, so a retried request cannot create duplicates.
 * Sheet 2 ("Summary"): ranking, head-to-head and the pairwise preference
 *   matrix, rebuilt automatically (at most once a minute) and from the
 *   Study > Rebuild summary menu.
 *
 * The statistics match preference_study.py exactly: same pair tallies, same
 * head-to-head tiebreak, same two-sided binomial test.
 */

var SUMMARY_NAME = 'Summary';
/*
 * Only used when auto-update is OFF. With the change trigger installed, an
 * incoming response rebuilds through the trigger instead, which keeps the
 * rebuild out of the participant's request and off this throttle entirely.
 */
var REBUILD_EVERY_MS = 15 * 1000;

/* ======================================================================= */
/* collection                                                              */
/* ======================================================================= */

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    var body = JSON.parse(e.postData.contents);
    var rows = body.rows || [];

    if (sheet.getLastRow() === 0 && body.header) {
      sheet.appendRow(body.header);
      sheet.setFrozenRows(1);
    }

    // row_id is participant + trial number, so it identifies one comparison.
    // Storing by that key means a retry is harmless AND a participant who steps
    // back and answers again replaces their earlier answer instead of adding a
    // second row for the same comparison.
    var rowOf = {};
    if (sheet.getLastRow() > 1) {
      var ids = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
      for (var i = 0; i < ids.length; i++) rowOf[String(ids[i][0])] = i + 2;
    }

    var added = 0, updated = 0;
    for (var j = 0; j < rows.length; j++) {
      var incoming = rows[j];
      var where = rowOf[String(incoming[0])];
      if (where) {
        sheet.getRange(where, 1, 1, incoming.length).setValues([incoming]);
        updated++;
      } else {
        sheet.appendRow(incoming);
        rowOf[String(incoming[0])] = sheet.getLastRow();
        added++;
      }
    }
    /*
     * Do not rebuild the Summary here when auto-update is on: writing to this
     * sheet fires the change trigger, which rebuilds a moment later outside this
     * request. Rebuilding inline would make every participant wait for it and
     * would be throttled on top of that.
     */
    if ((added || updated) && !autoUpdateFlag()) maybeRebuild();
    return json({ ok: true, added: added, updated: updated });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/*
 * Health check: open the /exec URL in a browser. If you see this JSON, the
 * deployment is reachable and you can confirm where responses are landing.
 * If you get a Google sign-in page instead, "Who has access" is not set to
 * Anyone -- participants will not be able to submit.
 */
function doGet() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheets()[0];
    return json({
      ok: true,
      spreadsheet: ss.getName(),
      tab: sheet.getName(),
      responses: Math.max(0, sheet.getLastRow() - 1),
      hint: 'POST responses here'
    });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Study')
    .addItem('Rebuild summary now', 'rebuildNow')
    .addSeparator()
    .addItem('Turn ON auto-update', 'installTriggers')
    .addItem('Turn OFF auto-update', 'removeTriggers')
    .addToUi();
}

/* Rebuilding on every single response would slow the endpoint, so throttle. */
function maybeRebuild() {
  try {
    var props = PropertiesService.getScriptProperties();
    var last = Number(props.getProperty('lastSummary') || 0);
    var now = new Date().getTime();
    if (now - last < REBUILD_EVERY_MS) return;
    props.setProperty('lastSummary', String(now));
    buildSummary();
  } catch (err) {
    // Never let a summary problem break data collection.
  }
}

/* ----------------------------------------------------------------------- */
/* keeping the Summary current automatically                               */
/* ----------------------------------------------------------------------- */

/*
 * Editing or DELETING rows by hand fires an onChange event, but only for an
 * installable trigger -- a plain onChange() function in the file is not enough,
 * and a simple trigger is not allowed to create one. So this is run once from
 * Study > Turn ON auto-update.
 */
function installTriggers() {
  removeTriggers();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ScriptApp.newTrigger('onSheetChange').forSpreadsheet(ss).onChange().create();
  // Backstop for a missed change event. One minute is affordable because a run
  // with no new data costs one read and a hash, then stops.
  ScriptApp.newTrigger('onSheetTimer').timeBased().everyMinutes(1).create();
  PropertiesService.getScriptProperties().setProperty('autoUpdate', '1');
  buildSummary(true);
  toast('Auto-update is ON: the Summary now follows every edit, deletion and ' +
        'incoming response.');
}

function removeTriggers() {
  var all = ScriptApp.getProjectTriggers();
  for (var i = 0; i < all.length; i++) {
    var fn = all[i].getHandlerFunction();
    if (fn === 'onSheetChange' || fn === 'onSheetTimer') ScriptApp.deleteTrigger(all[i]);
  }
  PropertiesService.getScriptProperties().deleteProperty('autoUpdate');
}

/* Cheap check used on the hot path, instead of listing project triggers. */
function autoUpdateFlag() {
  try {
    return PropertiesService.getScriptProperties().getProperty('autoUpdate') === '1';
  } catch (err) {
    return false;
  }
}

function autoUpdateOn() {
  var all = ScriptApp.getProjectTriggers();
  for (var i = 0; i < all.length; i++) {
    if (all[i].getHandlerFunction() === 'onSheetChange') return true;
  }
  return false;
}

/*
 * Any hand edit, row insert or row delete lands here.
 *
 * Deliberately NOT forced: writing the Summary sheet fires onChange again, so a
 * forced rebuild here would trigger itself forever. Unforced, the second hop
 * sees an unchanged responses signature and stops immediately -- while a real
 * edit or deletion does change it and rebuilds.
 */
function onSheetChange(e) {
  if (CacheService.getScriptCache().get('rebuilding')) return;
  buildSummary(false);
}

function onSheetTimer() {
  if (CacheService.getScriptCache().get('rebuilding')) return;
  buildSummary(false);            // no-op unless the data actually changed
}

function rebuildNow() {
  buildSummary(true);
  toast('Summary rebuilt.' + (autoUpdateOn() ? '' :
        ' Tip: Study > Turn ON auto-update keeps it current by itself.'));
}

function toast(msg) {
  try { SpreadsheetApp.getActiveSpreadsheet().toast(msg, 'Study', 6); } catch (err) {}
}

/*
 * Signature of the response data. Any added row, deleted row, or edit to a
 * field the statistics depend on changes it; rewriting the Summary sheet does
 * not. That is what makes the change trigger safe to leave on.
 */
function contentSignature(values) {
  if (!values.length) return 'empty';
  var header = values[0].map(function (v) { return String(v); });
  var at = {};
  for (var i = 0; i < header.length; i++) at[header[i]] = i;
  var keys = ['participant', 'trial', 'top_model', 'bottom_model', 'winner', 'loser',
              'chosen_position', 'response_ms', 'class_id'];
  var use = [];
  for (var k = 0; k < keys.length; k++) if (at[keys[k]] !== undefined) use.push(at[keys[k]]);

  var parts = [String(values.length), header.join(',')];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    for (var u = 0; u < use.length; u++) parts.push(String(row[use[u]]));
  }
  var s = parts.join('');
  var hash = 5381;
  for (var c = 0; c < s.length; c++) hash = ((hash << 5) + hash + s.charCodeAt(c)) | 0;
  return values.length + ':' + (hash >>> 0).toString(36);
}

/* ======================================================================= */
/* statistics (pure functions -- unit tested by web/summary_selftest.mjs)   */
/* ======================================================================= */

/* The model columns sit between 'loser' and 'response_ms'. */
function modelColumns(header) {
  var a = header.indexOf('loser'), b = header.indexOf('response_ms');
  if (a < 0 || b < 0 || b <= a + 1) return [];
  return header.slice(a + 1, b);
}

/*
 * Exact two-sided binomial test against p=0.5: the chance of a split at least
 * this lopsided from a coin flip. Computed in log space so a large n cannot
 * overflow. k is the winner's count.
 */
function binomTwoSided(k, n) {
  if (n <= 0) return 1;
  k = Math.max(k, n - k);
  var lp = -n * Math.LN2;                                   // log P(X = 0)
  for (var i = 1; i <= k; i++) lp += Math.log(n - i + 1) - Math.log(i);
  var tail = Math.exp(lp);                                  // P(X = k)
  for (var j = k; j < n; j++) {
    lp += Math.log(n - j) - Math.log(j + 1);
    tail += Math.exp(lp);
  }
  return Math.min(1, 2 * tail);
}

function median(nums) {
  if (!nums.length) return 0;
  var a = nums.slice().sort(function (x, y) { return x - y; });
  var m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/*
 * rows: array of arrays, matching header. Returns everything the Summary tab
 * needs. Only rows whose top_model and bottom_model are both known models
 * count, so leftovers from an older model set are ignored rather than mixed in.
 */
function computeStats(header, rows) {
  var cols = modelColumns(header);
  var at = {};
  for (var h = 0; h < header.length; h++) at[header[h]] = h;
  var order = {};
  for (var c = 0; c < cols.length; c++) order[cols[c]] = c;

  var pairs = {};          // "a||b" (a before b in cols order) -> tallies
  function pairKey(x, y) {
    return order[x] < order[y] ? x + '||' + y : y + '||' + x;
  }
  for (var i = 0; i < cols.length; i++) {
    for (var j = i + 1; j < cols.length; j++) {
      pairs[cols[i] + '||' + cols[j]] =
        { a: cols[i], b: cols[j], wins_a: 0, wins_b: 0, ties: 0, n: 0 };
    }
  }

  var people = {};         // participant -> { n, times[], wins{} }
  var used = 0;
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    var top = String(row[at.top_model] || '');
    var bot = String(row[at.bottom_model] || '');
    if (!(top in order) || !(bot in order) || top === bot) continue;
    var s = pairs[pairKey(top, bot)];
    s.n++;
    used++;
    var win = String(row[at.winner] || '');
    if (win === s.a) s.wins_a++;
    else if (win === s.b) s.wins_b++;
    else s.ties++;

    var pid = String(row[at.participant] || '');
    if (!people[pid]) {
      people[pid] = { pid: pid, n: 0, times: [], wins: {}, shown: {} };
      for (var k = 0; k < cols.length; k++) { people[pid].wins[cols[k]] = 0; people[pid].shown[cols[k]] = 0; }
    }
    var P = people[pid];
    P.n++;
    P.shown[top]++;
    P.shown[bot]++;
    if (P.wins[win] !== undefined) P.wins[win]++;
    var ms = Number(row[at.response_ms]);
    if (!isNaN(ms) && ms > 0) P.times.push(ms);
  }

  // head to head, oriented so 'winner' is the preferred model
  var h2h = [];
  for (var key in pairs) {
    var p = pairs[key];
    if (!p.n) continue;
    var decided = p.n - p.ties;
    var win2 = p.wins_a >= p.wins_b ? p.a : p.b;
    var lose2 = p.wins_a >= p.wins_b ? p.b : p.a;
    var wc = Math.max(p.wins_a, p.wins_b), lc = Math.min(p.wins_a, p.wins_b);
    h2h.push({
      a: p.a, b: p.b, wins_a: p.wins_a, wins_b: p.wins_b, ties: p.ties, n: p.n,
      decided: decided, drawn: wc === lc, top: win2, bottom: lose2,
      top_wins: wc, bottom_wins: lc,
      rate: decided ? wc / decided : 0,
      p: binomTwoSided(wc, decided)
    });
  }
  h2h.sort(function (x, y) { return y.rate - x.rate || (x.top < y.top ? -1 : 1); });

  // ranking: share of comparisons won, ties split by direct head-to-head
  var wins = {}, decidedFor = {}, beats = {}, losesTo = {}, drew = {}, direct = {};
  for (var m = 0; m < cols.length; m++) {
    wins[cols[m]] = 0; decidedFor[cols[m]] = 0;
    beats[cols[m]] = []; losesTo[cols[m]] = []; drew[cols[m]] = [];
  }
  for (var q = 0; q < h2h.length; q++) {
    var e = h2h[q];
    wins[e.a] += e.wins_a; wins[e.b] += e.wins_b;
    decidedFor[e.a] += e.decided; decidedFor[e.b] += e.decided;
    direct[e.a + '>' + e.b] = e.wins_a;
    direct[e.b + '>' + e.a] = e.wins_b;
    if (e.drawn) {
      drew[e.a].push([e.b, e.wins_a, e.wins_b]);
      drew[e.b].push([e.a, e.wins_b, e.wins_a]);
    } else {
      beats[e.top].push([e.bottom, e.top_wins, e.bottom_wins]);
      losesTo[e.bottom].push([e.top, e.bottom_wins, e.top_wins]);
    }
  }
  var ranking = cols.map(function (c) {
    return {
      model: c, wins: wins[c], comparisons: decidedFor[c],
      rate: decidedFor[c] ? wins[c] / decidedFor[c] : 0,
      beats: beats[c], loses_to: losesTo[c], drew: drew[c], direct: 0, note: ''
    };
  });
  ranking.sort(function (x, y) { return y.rate - x.rate || (x.model < y.model ? -1 : 1); });

  var ordered = [];
  var idx = 0;
  while (idx < ranking.length) {
    var end = idx;
    while (end + 1 < ranking.length &&
           Math.abs(ranking[end + 1].rate - ranking[idx].rate) <= 1e-12) end++;
    var group = ranking.slice(idx, end + 1);
    if (group.length > 1) {
      var names = group.map(function (g) { return g.model; });
      group.forEach(function (g) {
        g.direct = names.reduce(function (acc, o) {
          return o === g.model ? acc : acc + (direct[g.model + '>' + o] || 0);
        }, 0);
      });
      var split = group.some(function (g) { return g.direct !== group[0].direct; });
      group.sort(function (x, y) { return y.direct - x.direct || (x.model < y.model ? -1 : 1); });
      group.forEach(function (g) {
        g.note = split ? 'level on win rate - ordered by head-to-head'
                       : 'level on win rate and head-to-head';
      });
    }
    ordered = ordered.concat(group);
    idx = end + 1;
  }
  var rank = 0, prev = null;
  for (var o = 0; o < ordered.length; o++) {
    var kk = [ordered[o].rate, ordered[o].direct];
    if (!prev || Math.abs(kk[0] - prev[0]) > 1e-12 || kk[1] !== prev[1]) rank = o + 1;
    ordered[o].rank = rank;
    prev = kk;
  }

  var participants = [];
  for (var pid2 in people) participants.push(people[pid2]);
  participants.sort(function (x, y) { return x.pid < y.pid ? -1 : 1; });
  participants.forEach(function (P) { P.median_ms = median(P.times); });

  return {
    cols: cols, pairs: pairs, h2h: h2h, ranking: ordered,
    participants: participants, order: order, used: used, total: rows.length
  };
}

/* wins of rowModel over colModel, or null outside the lower triangle */
function matrixCell(stats, rowModel, colModel) {
  if (stats.order[rowModel] <= stats.order[colModel]) return null;
  for (var i = 0; i < stats.h2h.length; i++) {
    var e = stats.h2h[i];
    if ((e.a === rowModel && e.b === colModel) || (e.a === colModel && e.b === rowModel)) {
      var w = e.a === rowModel ? e.wins_a : e.wins_b;
      return { wins: w, decided: e.decided, rate: e.decided ? w / e.decided : 0 };
    }
  }
  return { wins: 0, decided: 0, rate: 0 };
}

function record(list) {
  return list.map(function (t) { return t[0] + ' (' + t[1] + '-' + t[2] + ')'; }).join(' | ');
}

/*
 * The Summary layout as a grid of values plus the formatting hints the writer
 * needs. Returned separately from any Sheet call so it can be tested.
 */
function summaryLayout(stats, meta) {
  var cols = stats.cols;
  var g = [];                       // grid
  var bold = [], heads = [], boxes = [];
  function put(arr) { g.push(arr); return g.length; }      // 1-based row index

  var titleRow = put(['Study results']);
  put([meta.updated ? 'updated ' + meta.updated : '']);
  put([stats.used + ' comparisons  ·  ' + stats.participants.length + ' participant(s)  ·  ' +
       cols.length + ' models' +
       (stats.total > stats.used ? '  ·  ' + (stats.total - stats.used) +
        ' row(s) ignored (unknown model)' : '')]);
  put([]);

  heads.push(put(['Ranking']));
  // Anchors are returned explicitly. Deriving them from the order of the bold
  // rows silently shifted every number format by one block.
  var rankHeader = put(['rank', 'model', 'wins', 'comparisons', 'win rate',
                        'beats', 'loses to', 'note']);
  bold.push(rankHeader);
  stats.ranking.forEach(function (r) {
    put([r.rank, r.model, r.wins, r.comparisons, r.rate,
         record(r.beats), record(r.loses_to), r.note]);
  });
  put([]);

  heads.push(put(['Head to head']));
  var h2hHeader = put(['preferred', 'over', 'score', 'rate', 'ties',
                       'p (two-sided)', 'significant?']);
  bold.push(h2hHeader);
  stats.h2h.forEach(function (e) {
    if (e.drawn) {
      put([e.a + ' and ' + e.b + ' tied', '', e.wins_a + '-' + e.wins_b, e.rate, e.ties,
           e.p, 'no']);
    } else {
      put([e.top, e.bottom, e.top_wins + '-' + e.bottom_wins, e.rate, e.ties, e.p,
           e.p < 0.05 ? 'YES' : 'no']);
    }
  });
  put([]);

  heads.push(put(['Preference matrix']));
  put(['Each cell: how often the ROW model was preferred over the COLUMN model.']);
  put(['Only the lower triangle is filled -- the mirror would just be ' +
       '(pair total - cell), and the diagonal would be a model against itself.']);
  var mStart = put([''].concat(cols));
  bold.push(mStart);
  cols.forEach(function (rm, i) {
    var line = [rm];
    cols.forEach(function (cm) {
      var cell = matrixCell(stats, rm, cm);
      line.push(cell ? cell.wins + ' / ' + cell.decided : '');
    });
    put(line);
  });
  boxes.push({ top: mStart, left: 1, rows: cols.length + 1, cols: cols.length + 1 });
  put([]);

  heads.push(put(['Preference rate matrix']));
  put(['Above 0.5 the ROW model was preferred; below 0.5 the COLUMN model was.']);
  var rStart = put([''].concat(cols));
  bold.push(rStart);
  var rateCells = [];
  var rateFormats = [], rateColors = [], rateWeights = [];
  cols.forEach(function (rm, i) {
    var line = [rm];
    var fmts = [], colours = [], weights = [];
    cols.forEach(function (cm, j) {
      var cell = matrixCell(stats, rm, cm);
      var live = cell && cell.decided;
      line.push(live ? cell.rate : '');
      // Collected as whole rows so the writer can format the block in one call
      // per attribute rather than three calls per cell.
      fmts.push(live ? '0.000' : '@');
      colours.push(!live ? null : cell.rate > 0.5 ? '#0f7a4d'
                                : cell.rate < 0.5 ? '#8b93a1' : null);
      weights.push(live && cell.rate > 0.5 ? 'bold' : 'normal');
      if (live) rateCells.push({ row: rStart + i + 1, col: j + 2, rate: cell.rate });
    });
    rateFormats.push(fmts);
    rateColors.push(colours);
    rateWeights.push(weights);
    put(line);
  });
  boxes.push({ top: rStart, left: 1, rows: cols.length + 1, cols: cols.length + 1 });
  put([]);

  heads.push(put(['Per participant']));
  put(['median time is a quality check: a very fast median suggests clicking ' +
       'without looking.']);
  var partHeader = put(['participant', 'comparisons', 'median ms']
    .concat(cols.map(function (c) { return c + ' win rate'; })));
  bold.push(partHeader);
  stats.participants.forEach(function (P) {
    var line = [P.pid, P.n, P.median_ms];
    cols.forEach(function (c) {
      line.push(P.shown[c] ? P.wins[c] / P.shown[c] : '');
    });
    put(line);
  });

  return {
    grid: g, bold: bold, heads: heads, boxes: boxes, rateCells: rateCells,
    titleRow: titleRow, cols: cols.length,
    // (header row, number of data rows, 1-based column of the value to format)
    rank: { header: rankHeader, rows: stats.ranking.length, rateCol: 5 },
    h2h: { header: h2hHeader, rows: stats.h2h.length, rateCol: 4, pCol: 6, width: 7 },
    part: { header: partHeader, rows: stats.participants.length, firstRateCol: 4 },
    rateMatrix: { top: rStart + 1, left: 2, rows: cols.length, cols: cols.length,
                  formats: rateFormats, colors: rateColors, weights: rateWeights }
  };
}

/* ======================================================================= */
/* writing the Summary sheet                                               */
/* ======================================================================= */

function buildSummary(force) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var src = ss.getSheets()[0];
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;                     // a rebuild is already running
  var cache = CacheService.getScriptCache();
  var props = PropertiesService.getScriptProperties();
  try {
    var values = src.getLastRow()
      ? src.getRange(1, 1, src.getLastRow(), src.getLastColumn()).getValues()
      : [];
    var sig = contentSignature(values);
    if (!force && props.getProperty('signature') === sig) return;   // nothing changed
    // Our own writes fire onChange too; this stops the trigger re-entering.
    cache.put('rebuilding', '1', 120);
    writeSummary(ss, values);
    props.setProperty('signature', sig);
  } finally {
    cache.remove('rebuilding');
    lock.releaseLock();
  }
}

function writeSummary(ss, values) {
  var out = ss.getSheetByName(SUMMARY_NAME);
  if (!out) {
    out = ss.insertSheet(SUMMARY_NAME, 1);
  }
  out.clear();
  out.clearFormats();

  if (values.length < 2) {
    out.getRange(1, 1).setValue('No responses yet.');
    return;
  }
  var header = values[0].map(function (v) { return String(v); });
  var stats = computeStats(header, values.slice(1));
  if (!stats.cols.length) {
    out.getRange(1, 1).setValue(
      'Could not find the model columns (expected between "loser" and "response_ms").');
    return;
  }

  var tz = ss.getSpreadsheetTimeZone();
  var lay = summaryLayout(stats, {
    updated: Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm')
  });

  var width = 1;
  lay.grid.forEach(function (r) { width = Math.max(width, r.length); });
  var padded = lay.grid.map(function (r) {
    var copy = r.slice();
    while (copy.length < width) copy.push('');
    return copy;
  });
  out.getRange(1, 1, padded.length, width).setValues(padded);

  // titles, headers, boxes
  out.getRange(lay.titleRow, 1, 1, width).setFontSize(14).setFontWeight('bold');
  lay.heads.forEach(function (r) {
    out.getRange(r, 1, 1, width).setFontWeight('bold').setFontSize(11)
      .setBackground(null).setFontColor('#1a56db');
  });
  lay.bold.forEach(function (r) { out.getRange(r, 1, 1, width).setFontWeight('bold'); });
  lay.boxes.forEach(function (b) {
    out.getRange(b.top, b.left, b.rows, b.cols)
      .setBorder(true, true, true, true, true, true, '#c8ccd4',
                 SpreadsheetApp.BorderStyle.SOLID)
      .setHorizontalAlignment('center');
    out.getRange(b.top, b.left, b.rows, 1).setHorizontalAlignment('left')
      .setFontWeight('bold');
  });

  // number formats, addressed by explicit anchors so nothing can shift
  if (lay.rank.rows) {
    out.getRange(lay.rank.header + 1, lay.rank.rateCol, lay.rank.rows, 1)
      .setNumberFormat('0.0%');
    out.getRange(lay.rank.header + 1, 3, lay.rank.rows, 2).setNumberFormat('0');
  }
  if (lay.h2h.rows) {
    out.getRange(lay.h2h.header + 1, lay.h2h.rateCol, lay.h2h.rows, 1)
      .setNumberFormat('0.0%');
    out.getRange(lay.h2h.header + 1, lay.h2h.pCol, lay.h2h.rows, 1)
      .setNumberFormat('0.0000');
  }
  // green when a pair is significant
  stats.h2h.forEach(function (e, i) {
    if (!e.drawn && e.p < 0.05) {
      out.getRange(lay.h2h.header + 1 + i, 1, 1, lay.h2h.width)
        .setFontColor('#0f7a4d').setFontWeight('bold');
    }
  });
  // rate matrix: colour by who was preferred -- one call per attribute for the
  // whole block instead of three per cell
  var rm = lay.rateMatrix;
  if (rm.rows) {
    out.getRange(rm.top, rm.left, rm.rows, rm.cols)
      .setNumberFormats(rm.formats)
      .setFontColors(rm.colors)
      .setFontWeights(rm.weights);
  }
  // per-participant win rates
  if (lay.part.rows) {
    out.getRange(lay.part.header + 1, lay.part.firstRateCol, lay.part.rows, lay.cols)
      .setNumberFormat('0.0%');
    out.getRange(lay.part.header + 1, 2, lay.part.rows, 2).setNumberFormat('0');
  }

  out.setColumnWidth(1, 190);
  if (width > 1) out.setColumnWidths(2, width - 1, 120);   // one call, not one per column
  out.setFrozenRows(1);
}
