# Contributing to TutorDB

Thanks for taking an interest! Bug reports, ideas and pull requests are all welcome.

## Getting set up

```bash
git clone https://github.com/spere43/TutorDB.git
cd TutorDB
python3 -m venv venv
source venv/bin/activate            # Windows (PowerShell): venv\Scripts\Activate.ps1
pip install -r requirements.txt pillow

python scripts/seed_demo.py         # fictional demo data (Pillow is only needed for this)
python app.py                       # http://localhost:5000
```

There is no build step: edit `app.py`, `templates/index.html`, `static/js/app.js` or `static/css/style.css`, restart the server for Python changes, and hard-refresh (`Ctrl+F5`) for front-end changes. To start again with clean demo data, stop the app and delete the `data/` folder.

## Where things live

| Area | Where |
|---|---|
| Models, REST API, file serving | `app.py`. Models first, then routes grouped by area (papers, questions, tags/lookups, files). |
| Start-up schema migrations | The `if __name__ == "__main__":` block at the bottom of `app.py`. |
| Page markup (all five tabs and the viewer) | `templates/index.html` |
| All client logic | `static/js/app.js`, in sections: Add Paper, Quick Add, Chop, Classify, Browse, and the full-screen viewer. |
| Styles | `static/css/style.css` |
| Demo data | `scripts/seed_demo.py` |

The values you're most likely to tune (quick-tag buttons, badge caps, crop sharpness, page size) are named constants near the top of their sections in `app.js`; the [README](README.md#customising-for-your-curriculum) lists them.

## Ground rules

- **Never commit real exam papers or student material**, in code, screenshots, issues or PRs. `data/` is git-ignored for this reason. If you need to show a bug, reproduce it with the demo data.
- **Keep it dependency-light.** The app is meant to run on small, low-power hardware. New Python or JavaScript dependencies need a good reason.
- **No build tooling on the front end** unless there is a strong case for it. The UI is plain ES modules.
- **Existing data is sacred.** People run this on question banks they've spent hours building, so upgrades must never change what they already have. For anything that touches the schema:
  - **Add, don't alter.** Add a column with `ALTER TABLE ... ADD COLUMN` and a constant default, or add a new table. Don't rename, retype or drop existing columns.
  - **Order matters.** A new column has to exist before the first ORM query that selects it, so put the migration near the top of the start-up block.
  - **Backfill idempotently.** Only insert what's missing, so running it on every start-up changes nothing the second time. Never rewrite or delete an existing row.
  - **Keep the old columns working**, so an older version of the app can still read the database.
  - **Prove it.** Run your branch against a *copy* of a real (or demo) database and compare before and after: every question's JSON, the results of a spread of filters, and the original tables' contents should be unchanged apart from the new fields. Restart it a few times to check it's idempotent.
- **Don't fight the shared UI code.** The Chop tab attaches its handlers to every element with the class `mode-btn`, so don't reuse that class for anything else. Keyboard shortcuts in the viewer must ignore keystrokes while the user is typing in a field.
- **Update the docs** (`README.md`, `docs/API.md`) when you change behaviour or add an endpoint, and refresh `docs/screenshots/` if the UI changes noticeably. Generate the screenshots from the demo data, never from real content.

## Trying a change by hand

There's no automated test suite yet (it's on the [roadmap](README.md#known-limitations-and-roadmap)), so please walk through the parts you touched using the demo data. A good baseline:

- **Chop:** open a demo paper, draw a box, classify it (with two comma-separated topics), save it, and check it in Browse.
- **Quick Add:** add a couple of PNG screenshots (pick some and paste one), find them in Classify, classify one, and try **Trim first** on another.
- **Flagging:** flag a question in the viewer, fix it from Classify → Reclassify, and unflag one from the Edit form.
- **Browse:** try the chip filters, tag include/exclude, *Load more*, and stepping through the viewer with the arrow keys.
- **Backup:** download one from Settings and check it opens.

## Submitting a change

1. Open an issue first for anything bigger than a small fix, so we can agree on the approach.
2. Create a branch, make your change, and try it in the browser against the demo data.
3. In the PR, say what changed and why, and include a screenshot for UI changes (taken with demo data only).

Ideas that would be especially welcome are listed under [Known limitations and roadmap](README.md#known-limitations-and-roadmap) in the README, and an automated test suite would be a great first contribution.
