# Putting the study online

Three steps, about 15 minutes, no server and nothing to pay for. At the end you
have a link you can send to anyone; their answers land in a Google Sheet.

Rebuild the bundle any time the rows change:

```
python make_web.py
```

That writes `web/rows/*.webp` (30 images, ~5 MB) and `web/manifest.js`.
Open `web/index.html` in a browser right now to try the task — it works
straight from disk, and in that state answers are only downloadable, not sent.

---

## 1. Make the collection sheet (5 min)

1. Create a new Google Sheet (sheets.new). Name it whatever you like.
2. **Extensions → Apps Script**. Delete the sample code, paste all of
   `web/apps_script.gs`, and save.
3. **Deploy → New deployment**. Click the gear → **Web app**. Set:
   - *Description*: anything
   - *Execute as*: **Me**
   - *Who has access*: **Anyone**  ← required, or participants get an error
4. **Deploy**, approve the permission prompt (it is your own script writing to
   your own sheet), and copy the **Web app URL**. It ends in `/exec`.
5. **Check it**: paste that URL into a browser tab. You should see JSON naming
   your spreadsheet, e.g.
   `{"ok":true,"spreadsheet":"Study responses","tab":"Sheet1","responses":0,...}`.
   If you get a **Google sign-in page** instead, access is still restricted and
   nobody will be able to submit — go to **Deploy → Manage deployments**, click
   your deployment, hit the **pencil**, set *Who has access* to **Anyone**
   (not "Anyone with a Google account") and **Deploy** again. Editing the
   existing deployment keeps the same URL; creating a new one changes it.

## 2. Point the page at it (1 min)

Open `web/index.html`, find the `CONFIG` block near the bottom, and paste the
URL:

```js
var CONFIG = {
  endpoint: 'https://script.google.com/macros/s/AKfy..../exec',
  minWidth: 1100,
  ...
};
```

## 3. Host the folder (5 min)

Every path in `index.html` is relative, so the bundle works from any host and
from any subpath. Pick one of these.

### Option A — GitHub Pages

Free and permanent, **but the repository has to be public** unless you have
GitHub Pro/Team: Pages on private repos is a paid feature. Publish only this
folder — a repo containing just the study keeps your model code and full-size
samples out of it.

*Without git, straight from the browser:*

1. github.com → **New repository**, name it e.g. `image-study`, **Public**,
   create it.
2. On the empty repo page click **uploading an existing file**, then drag in
   everything inside `web` — `index.html`, `study.js`, `manifest.js`,
   `apps_script.gs`, `.nojekyll`, and the `rows` folder. Commit.
3. **Settings → Pages → Source: Deploy from a branch**, branch `main`,
   folder `/ (root)`. Save.
4. Wait about a minute. Your link is `https://<user>.github.io/image-study/`.

*With git (from this folder):*

```bash
cd web
git init -b main
git add .
git commit -m "Image preference study"
git remote add origin https://github.com/<user>/image-study.git
git push -u origin main
```

Then do step 3 above. `web/` is not inside any other repository, so this commits
the study bundle and nothing else.

Pages allows 1 GB per repo and about 100 GB of traffic a month; at ~5 MB per
participant that is thousands of sessions.

### Option B — Netlify Drop

No account needed to start, and the repo-visibility question does not arise:

1. Go to **https://app.netlify.com/drop**
2. Drag the whole `web` folder onto the page.
3. You get a live URL like `https://gentle-pastry-1a2b3c.netlify.app`.

Claim the site with a free account to keep the URL or rename it. Cloudflare
Pages (Upload assets) and Vercel work the same way.

**Test it yourself first**: open the link, do two or three comparisons, and
check the rows appear in your Sheet. The page shows `answers saved` in the
bottom-right when a send succeeds.

---

## The Summary tab

The script keeps a second tab called **Summary** next to the raw responses,
holding the same statistics as the desktop app's final screen:

- **Ranking** — each model's share of comparisons won, who it beats, who beats
  it. Models level on win rate are ordered by their head-to-head result, and the
  `note` column says so.
- **Head to head** — one line per pair: `preferred / over / score / rate /
  p (two-sided) / significant?`. Significant pairs are highlighted green.
- **Preference matrix** — lower triangle only: how often the ROW model was
  preferred over the COLUMN model. Plus the same thing as a rate, coloured by
  which model won.
- **Per participant** — comparisons done, **median response time** (a fast
  median means someone was clicking without looking) and their win rate per
  model, so you can spot a rater who disagrees with everyone else.

It rebuilds automatically as responses arrive, at most once a minute, and you
can force it from the **Study → Rebuild summary** menu in the spreadsheet.

The maths is a port of `preference_study.py` and is tested against it:
`node web/summary_selftest.mjs` feeds `results/all_trials.csv` through the Apps
Script functions and asserts the ranking, matrix and p-values come out identical
to what the desktop app wrote. The Sheet and your offline analysis cannot drift
apart.

### After editing the script

Saving in the Apps Script editor is enough for the **menu** to use the new code
(reload the spreadsheet once so the menu appears). The **deployed endpoint**
keeps running the version you deployed, so to update what participants hit:
**Deploy → Manage deployments → pencil → Version: New version → Deploy.** That
keeps the same `/exec` URL.

## Getting the data back

**File → Download → Comma-separated values (.csv)**, then:

```
python import_web_results.py ~/Downloads/study_responses.csv
```

That merges the responses into `results/`, regenerates the matrix, the ranking
and the per-participant folders, and prints the new standings. Re-running it is
safe — rows already imported are skipped, so you can export and import as often
as you like while data comes in. Web and in-person sessions pool into the same
study.

---

## Things worth knowing

**Sending is incremental and retried.** Each answer is queued in the browser and
posted as it happens, so someone who abandons halfway still contributes what
they did. Each row carries a `row_id`, and the Apps Script skips ids it has
already stored, so a retry can never duplicate a row. If sending fails
completely, the final screen asks the participant to download their answers and
email them to you — feed that file to the same importer.

**Narrow screens are refused.** Your rows are 2560 px wide; on a phone each of
the 10 images would be ~40 px across and the judgement would be meaningless. The
page blocks anything under `minWidth` (1100 px) and explains why. Every row
records `viewport` and `device_pixel_ratio` so you can report the range of
conditions, or filter afterwards.

**Participant IDs are automatic** — a random `w-xxxxxx` kept in the browser's
local storage, so a reload resumes the same ID rather than starting a new
participant. If you recruit through a platform, pass the ID in the URL instead:
`?pid=abc123` (also accepts `?PROLIFIC_PID=`).

**The design matches the desktop app**: every model pair × every shared class,
with which model appears on top balanced within each pair, and the pairs
interleaved. The per-participant order is seeded from the participant ID, so a
reload gives the same sequence.

**Model names are not shown to participants,** but `manifest.js` does map the
`m1`/`m2`/`m3` image folders to real names, so anyone who opens developer tools
could work out which is which. That is cosmetic obfuscation, not a guarantee.

**Costs.** Netlify free tier gives 100 GB/month of bandwidth; at ~5 MB per
participant that is thousands of sessions. Apps Script quotas are far above
anything a study this size will use.

**Before recruiting paid participants**, two things worth sorting out: an ethics
/ IRB determination if this is going into a publication, and 2–3 catch trials
(one row deliberately blurred) so you can drop anyone clicking at random.

**Check the JS logic after editing** `study.js`:

```
node web/selftest.mjs
```
