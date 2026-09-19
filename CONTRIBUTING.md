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

There is no build step: edit `app.py`, `templates/index.html`, `static/js/app.js` or `static/css/style.css` and refresh the browser. To start again with clean demo data, stop the app and delete the `data/` folder.

## Ground rules

- **Never commit real exam papers or student material**, in code, screenshots, issues or PRs. `data/` is git-ignored for this reason. If you need to show a bug, reproduce it with the demo data.
- **Keep it dependency-light.** The app is meant to run on small, low-power hardware. New Python or JavaScript dependencies need a good reason.
- **No build tooling on the front end** unless there is a strong case for it. The UI is plain ES modules.
- **Schema changes** need a matching start-up migration in `app.py` (see the existing `ALTER TABLE` checks) that is safe to re-run on every launch and doesn't lose data from older databases.
- **Update the docs** (`README.md`, `docs/API.md`) when you change behaviour or add an endpoint.

## Submitting a change

1. Open an issue first for anything bigger than a small fix, so we can agree on the approach.
2. Create a branch, make your change, and try it in the browser against the demo data.
3. In the PR, say what changed and why, and include a screenshot for UI changes (taken with demo data only).

Ideas that would be especially welcome are listed under [Known limitations and roadmap](README.md#known-limitations-and-roadmap) in the README.
