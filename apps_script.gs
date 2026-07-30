/*
 * apps_script.gs -- the whole "backend". Paste into Extensions > Apps Script
 * of a new Google Sheet, then Deploy > New deployment > Web app,
 * Execute as: Me,  Who has access: Anyone.  Copy the /exec URL into
 * CONFIG.endpoint in index.html.
 *
 * Appends each response as a row. row_id is checked first, so a retried
 * request cannot create duplicates.
 */

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

    var seen = {};
    if (sheet.getLastRow() > 1) {
      var ids = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
      for (var i = 0; i < ids.length; i++) seen[String(ids[i][0])] = true;
    }

    var added = 0;
    for (var j = 0; j < rows.length; j++) {
      if (seen[String(rows[j][0])]) continue;   // row_id already stored
      sheet.appendRow(rows[j]);
      seen[String(rows[j][0])] = true;
      added++;
    }
    return json({ ok: true, added: added, skipped: rows.length - added });
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
