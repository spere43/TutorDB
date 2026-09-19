from flask import Flask, jsonify, request, send_from_directory, render_template, send_file
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import joinedload, selectinload
from werkzeug.utils import secure_filename
from datetime import datetime
import os
import uuid
import sqlite3
import zipfile
import time

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "questions.db")

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(os.path.join(DATA_DIR, "files"), exist_ok=True)

app = Flask(__name__)
app.config["SQLALCHEMY_DATABASE_URI"] = f"sqlite:///{DB_PATH}"
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

db = SQLAlchemy(app)


# WAL mode lets reads keep working while a write is in progress (instead of
# blocking/locking), and makes the DB file far less likely to end up
# corrupted if the app is killed mid-write (e.g. a power blip on the
# Odroid). This fires on every new connection SQLAlchemy opens, and is
# safe to add on top of an existing database -- SQLite converts the file
# to WAL the first time this runs and just leaves it that way afterwards,
# no data is touched or migrated.
@event.listens_for(Engine, "connect")
def set_sqlite_pragma(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.close()


ALLOWED_EXTENSIONS = {"pdf", "doc", "docx", "png", "jpg", "jpeg"}
FILES_DIR = os.path.join(DATA_DIR, "files")


def allowed_file(filename):
    """Checks the extension on the SANITIZED filename, not the raw one.
    secure_filename() can strip a filename down to nothing-but-the-
    extension (e.g. "???.pdf" -> "pdf", with no dot left at all) --
    checking the raw name let files like that pass this gate and then
    crash save_upload() when it tried to split an extension off a
    filename that, post-sanitizing, no longer had one."""
    secured = secure_filename(filename)
    return "." in secured and secured.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def normalize_question_number(raw):
    """Keeps a leading "Q" if one's already there (case-normalized to
    uppercase), otherwise adds one -- so "Q1", "q1", and "1" all end up
    stored as "Q1" regardless of which way it was typed. Without this,
    some questions end up stored with a "Q" and some without, and any
    display code that adds its own "Q" prefix for the ones without ends
    up double-prefixing the ones that already have it (e.g. "QQ1")."""
    if raw is None:
        return None
    trimmed = raw.strip()
    if not trimmed:
        return None
    if trimmed[0].lower() == "q":
        return "Q" + trimmed[1:]
    return "Q" + trimmed


def save_upload(file_storage, subfolder=""):
    """Saves an uploaded file with a unique name, returns the relative path stored in DB."""
    original_name = secure_filename(file_storage.filename)
    ext = original_name.rsplit(".", 1)[1].lower()
    unique_name = f"{uuid.uuid4().hex}_{original_name}"
    target_dir = os.path.join(FILES_DIR, subfolder)
    os.makedirs(target_dir, exist_ok=True)
    full_path = os.path.join(target_dir, unique_name)
    file_storage.save(full_path)
    # store path relative to FILES_DIR so it's portable if the base dir moves
    return os.path.join(subfolder, unique_name)

# ---------- Models ----------

class Paper(db.Model):
    __tablename__ = "papers"
    id = db.Column(db.Integer, primary_key=True)
    school = db.Column(db.String(120), nullable=False)
    subject = db.Column(db.String(80), nullable=False)
    year_level = db.Column(db.Integer, nullable=False)  # 11 or 12
    exam_type = db.Column(db.String(50), nullable=False)  # internal / mock / QCAA-style etc
    exam_year = db.Column(db.Integer, nullable=True)
    file_path = db.Column(db.String(300), nullable=False)  # path to original PDF/doc
    solution_file_path = db.Column(db.String(300), nullable=True)
    date_added = db.Column(db.DateTime, default=datetime.utcnow)

    questions = db.relationship("Question", backref="paper", cascade="all, delete-orphan")

    def to_dict(self):
        return {
            "id": self.id,
            "school": self.school,
            "subject": self.subject,
            "year_level": self.year_level,
            "exam_type": self.exam_type,
            "exam_year": self.exam_year,
            "file_path": self.file_path,
            "solution_file_path": self.solution_file_path,
        }


class Tag(db.Model):
    __tablename__ = "tags"
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(80), unique=True, nullable=False)


question_tags = db.Table(
    "question_tags",
    db.Column("question_id", db.Integer, db.ForeignKey("questions.id"), primary_key=True),
    db.Column("tag_id", db.Integer, db.ForeignKey("tags.id"), primary_key=True),
)


class Question(db.Model):
    __tablename__ = "questions"
    id = db.Column(db.Integer, primary_key=True)
    paper_id = db.Column(db.Integer, db.ForeignKey("papers.id"), nullable=False)
    question_number = db.Column(db.String(20), nullable=True)  # e.g. "4" or "4b"
    unit = db.Column(db.Integer, nullable=True)  # QCE unit: 1, 2, 3, or 4
    topic = db.Column(db.String(120), nullable=False)
    subtopic = db.Column(db.String(120), nullable=True)
    difficulty = db.Column(db.String(2), nullable=False)  # SF / CF / CU
    page_number = db.Column(db.Integer, nullable=True)  # page the question STARTS on
    notes = db.Column(db.Text, nullable=True)
    date_added = db.Column(db.DateTime, default=datetime.utcnow)

    tags = db.relationship("Tag", secondary=question_tags, backref="questions")

    # A question can carry several topics and subtopics (typed comma-separated,
    # like tags). The full lists live in these link tables; `topic` and
    # `subtopic` above stay in place as the FIRST entry of each list, kept in
    # sync by set_topics() -- so every older question (and anything that still
    # reads the single-value columns, incl. is_classified) works untouched.
    topic_links = db.relationship(
        "QuestionTopic", cascade="all, delete-orphan", order_by="QuestionTopic.position",
    )
    subtopic_links = db.relationship(
        "QuestionSubtopic", cascade="all, delete-orphan", order_by="QuestionSubtopic.position",
    )

    # A question (or its worked solution) can span several pages/regions --
    # each chopped box, or each manually-uploaded solution page, becomes one
    # QuestionImage row here rather than a single fixed file path. `kind`
    # separates the question's own images from its answer's.
    images = db.relationship(
        "QuestionImage", backref="question",
        cascade="all, delete-orphan", order_by="QuestionImage.order_index",
    )

    def to_dict(self):
        q_images = [i.to_dict() for i in self.images if i.kind == "question"]
        a_images = [i.to_dict() for i in self.images if i.kind == "answer"]
        return {
            "id": self.id,
            "paper_id": self.paper_id,
            "question_number": self.question_number,
            "unit": self.unit,
            "topic": self.topic,
            "subtopic": self.subtopic,
            # Full lists. `topic`/`subtopic` above remain the first entry, as
            # before. The fallback keeps a row that somehow has no link rows
            # yet (e.g. created by an older version) reading correctly.
            "topics": [l.name for l in self.topic_links] or ([self.topic] if self.topic else []),
            "subtopics": [l.name for l in self.subtopic_links] or ([self.subtopic] if self.subtopic else []),
            "difficulty": self.difficulty,
            "page_number": self.page_number,
            "notes": self.notes,
            "question_images": q_images,
            "answer_images": a_images,
            "has_answer": len(a_images) > 0,
            # False for a question created via the quick-chop path (topic
            # and/or difficulty still blank) -- what the Classify tab uses
            # to build its queue, and what the Browse/Chop UI uses to show
            # an "unclassified" flag on a card.
            "is_classified": bool(self.topic) and bool(self.difficulty),
            "tags": [t.name for t in self.tags],
            "school": self.paper.school,
            "subject": self.paper.subject,
            "exam_type": self.paper.exam_type,
        }


class QuestionImage(db.Model):
    """One page/region belonging to a question or its worked solution.
    A question that spans multiple pages, or has a multi-page solution,
    is just several rows here sharing a question_id, ordered by
    order_index -- there's no separate "multi-page question" concept,
    it falls out naturally from allowing more than one row per kind."""
    __tablename__ = "question_images"
    id = db.Column(db.Integer, primary_key=True)
    question_id = db.Column(db.Integer, db.ForeignKey("questions.id"), nullable=False)
    kind = db.Column(db.String(10), nullable=False)  # "question" or "answer"
    page_number = db.Column(db.Integer, nullable=True)
    file_path = db.Column(db.String(300), nullable=False)
    order_index = db.Column(db.Integer, nullable=False, default=0)
    date_added = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            "id": self.id,
            "kind": self.kind,
            "page_number": self.page_number,
            "file_path": self.file_path,
            "order_index": self.order_index,
        }


class QuestionTopic(db.Model):
    """One topic on a question. `position` 0 is the primary topic, which is
    also mirrored into questions.topic."""
    __tablename__ = "question_topics"
    id = db.Column(db.Integer, primary_key=True)
    question_id = db.Column(db.Integer, db.ForeignKey("questions.id"), nullable=False)
    name = db.Column(db.String(120), nullable=False)
    position = db.Column(db.Integer, nullable=False, default=0)


class QuestionSubtopic(db.Model):
    """One subtopic on a question -- same shape as QuestionTopic."""
    __tablename__ = "question_subtopics"
    id = db.Column(db.Integer, primary_key=True)
    question_id = db.Column(db.Integer, db.ForeignKey("questions.id"), nullable=False)
    name = db.Column(db.String(120), nullable=False)
    position = db.Column(db.Integer, nullable=False, default=0)


def clean_names(raw):
    """Trims, drops blanks and non-strings, and de-duplicates (case-insensitive,
    first spelling wins) while keeping order -- the first item is the primary."""
    out, seen = [], set()
    for item in raw or []:
        if not isinstance(item, str):
            continue
        name = item.strip()
        if name and name.lower() not in seen:
            seen.add(name.lower())
            out.append(name)
    return out


def names_from_payload(data, plural, singular):
    """Reads a topic/subtopic list from a request body. Accepts the list form
    (`topics: [...]`) or the original single-value form (`topic: "..."`).
    A single string is ALWAYS one item and is never split on commas, because
    real topic names can contain commas ("Thermal, nuclear and electrical
    physics") -- splitting typed text into separate topics is the client's
    job. Returns None when neither key was sent (= leave it alone)."""
    if plural in data:
        value = data[plural]
        return clean_names(value if isinstance(value, list) else [value])
    if singular in data:
        return clean_names([data[singular]])
    return None


def set_topics(question, topics=None, subtopics=None):
    """The one place topics/subtopics get written. Updates the link rows AND
    the legacy single-value columns together so they can never disagree.
    Pass None to leave a list untouched."""
    if topics is not None:
        if topics != [l.name for l in question.topic_links]:
            question.topic_links = [QuestionTopic(name=n, position=i) for i, n in enumerate(topics)]
        question.topic = topics[0] if topics else ""
    if subtopics is not None:
        if subtopics != [l.name for l in question.subtopic_links]:
            question.subtopic_links = [QuestionSubtopic(name=n, position=i) for i, n in enumerate(subtopics)]
        question.subtopic = subtopics[0] if subtopics else None


# ---------- Routes ----------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/status")
def status():
    return jsonify({
        "status": "ok",
        "message": "TutorDB is running",
        "paper_count": Paper.query.count(),
        "question_count": Question.query.count(),
    })


@app.route("/api/backup", methods=["GET"])
def download_backup():
    """
    Streams a single zip containing everything needed to run this exact
    database on a different machine: a clean snapshot of the SQLite DB
    plus every uploaded/cropped/answer file, in the same relative folder
    layout the app already expects (questions.db at the zip root,
    files/... underneath it, matching data/files/... here).

    Restoring on a new machine is just: stop the app there, extract this
    zip's contents into that machine's data/ folder (replacing whatever's
    there), start the app -- no relinking needed, since every file_path
    stored in the DB was already relative to data/files/ to begin with.

    Uses SQLite's own backup API rather than copying the .db file's raw
    bytes directly, so a write happening at the same moment as the
    backup can't produce a torn/corrupted snapshot. Writes the zip to a
    temp file on disk (not in memory) since this device's RAM is small
    relative to a growing multi-GB question bank.

    Cleanup: Flask's `call_on_close` hook for deleting the temp file
    after sending is NOT reliable here -- send_file can hand the file off
    to the WSGI server's own sendfile mechanism in a way that bypasses
    that hook, so the file can survive after a successful download.
    Instead, any backup zip/snapshot older than 10 minutes is swept away
    at the START of the next backup request (a safety margin in case a
    previous download is still genuinely in progress), which reliably
    bounds disk usage without depending on server-specific behavior.
    """
    timestamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    zip_filename = f"tutordb-backup-{timestamp}.zip"

    backups_dir = os.path.join(DATA_DIR, "backups")
    os.makedirs(backups_dir, exist_ok=True)

    now = time.time()
    for fname in os.listdir(backups_dir):
        fpath = os.path.join(backups_dir, fname)
        if os.path.isfile(fpath) and now - os.path.getmtime(fpath) > 600:
            os.remove(fpath)

    zip_path = os.path.join(backups_dir, zip_filename)
    db_snapshot_path = os.path.join(backups_dir, f".snapshot-{timestamp}.db")

    source_conn = sqlite3.connect(DB_PATH)
    dest_conn = sqlite3.connect(db_snapshot_path)
    with dest_conn:
        source_conn.backup(dest_conn)
    source_conn.close()
    dest_conn.close()

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(db_snapshot_path, arcname="questions.db")
        for root, _, files in os.walk(FILES_DIR):
            for fname in files:
                full_path = os.path.join(root, fname)
                arcname = os.path.join("files", os.path.relpath(full_path, FILES_DIR))
                zf.write(full_path, arcname=arcname)

    os.remove(db_snapshot_path)

    response = send_file(zip_path, as_attachment=True, download_name=zip_filename, mimetype="application/zip")

    @response.call_on_close
    def _cleanup():
        if os.path.exists(zip_path):
            os.remove(zip_path)

    return response


# ---------- Papers ----------

@app.route("/api/papers", methods=["GET"])
def list_papers():
    papers = Paper.query.order_by(Paper.date_added.desc()).all()
    return jsonify([p.to_dict() for p in papers])


@app.route("/api/papers", methods=["POST"])
def create_paper():
    """
    Expects multipart/form-data:
      school, subject, year_level, exam_type, exam_year (optional)
      file (the original paper PDF/doc)
      solution_file (optional, the worked solutions PDF/doc)
    """
    school = request.form.get("school")
    subject = request.form.get("subject")
    year_level = request.form.get("year_level")
    exam_type = request.form.get("exam_type")
    exam_year = request.form.get("exam_year")

    if not all([school, subject, year_level, exam_type]):
        return jsonify({"error": "school, subject, year_level, exam_type are required"}), 400

    if "file" not in request.files or request.files["file"].filename == "":
        return jsonify({"error": "original paper file is required"}), 400

    file = request.files["file"]
    if not allowed_file(file.filename):
        return jsonify({"error": "file type not allowed"}), 400

    file_path = save_upload(file, subfolder=secure_filename(subject))

    solution_path = None
    if "solution_file" in request.files and request.files["solution_file"].filename != "":
        sol_file = request.files["solution_file"]
        if allowed_file(sol_file.filename):
            solution_path = save_upload(sol_file, subfolder=secure_filename(subject))

    paper = Paper(
        school=school,
        subject=subject,
        year_level=int(year_level),
        exam_type=exam_type,
        exam_year=int(exam_year) if exam_year else None,
        file_path=file_path,
        solution_file_path=solution_path,
    )
    db.session.add(paper)
    db.session.commit()
    return jsonify(paper.to_dict()), 201


# Placeholder values used for quick-add papers -- these aren't meant to be
# meaningful, just a consistent, recognizable stand-in so quick-added
# papers are easy to spot in listings (and easy to backfill with real
# details later via the normal paper Edit form, if it's ever worth it).
QUICK_ADD_SCHOOL = "Uncategorized"
QUICK_ADD_EXAM_TYPE = "misc"
QUICK_ADD_YEAR_LEVEL = 12


@app.route("/api/papers/quick", methods=["POST"])
def create_paper_quick():
    """
    Fast path for a one-off circulating question/screenshot that isn't
    really "a paper" you're tracking -- skips school/year-level/exam-type
    entirely (filled with placeholder values) so you can go straight from
    screenshot to chopping. Expects multipart/form-data: subject, file.
    Reusable indefinitely -- not a one-time/temporary thing.
    """
    subject = request.form.get("subject")
    if not subject:
        return jsonify({"error": "subject is required"}), 400

    if "file" not in request.files or request.files["file"].filename == "":
        return jsonify({"error": "file is required"}), 400

    file = request.files["file"]
    if not allowed_file(file.filename):
        return jsonify({"error": "file type not allowed"}), 400

    file_path = save_upload(file, subfolder=secure_filename(subject))

    paper = Paper(
        school=QUICK_ADD_SCHOOL,
        subject=subject,
        year_level=QUICK_ADD_YEAR_LEVEL,
        exam_type=QUICK_ADD_EXAM_TYPE,
        exam_year=None,
        file_path=file_path,
        solution_file_path=None,
    )
    db.session.add(paper)
    db.session.commit()
    return jsonify(paper.to_dict()), 201


@app.route("/api/papers/<int:paper_id>", methods=["PATCH"])
def update_paper(paper_id):
    """Partial update for a paper's metadata (school, subject, year_level,
    exam_type, exam_year) -- e.g. for correcting a typo without
    re-uploading the file or touching any questions already chopped
    from it. Unit lives on the QUESTION, not the paper -- see
    PATCH /api/questions/<id> for that."""
    paper = Paper.query.get_or_404(paper_id)
    data = request.get_json() or {}

    if "school" in data and data["school"]:
        paper.school = data["school"]
    if "subject" in data and data["subject"]:
        paper.subject = data["subject"]
    if "year_level" in data and data["year_level"]:
        paper.year_level = int(data["year_level"])
    if "exam_type" in data and data["exam_type"]:
        paper.exam_type = data["exam_type"]
    if "exam_year" in data:
        paper.exam_year = int(data["exam_year"]) if data["exam_year"] else None

    db.session.commit()
    return jsonify(paper.to_dict())


@app.route("/api/papers/<int:paper_id>", methods=["DELETE"])
def delete_paper(paper_id):
    paper = Paper.query.get_or_404(paper_id)
    db.session.delete(paper)
    db.session.commit()
    return jsonify({"deleted": paper_id})


# ---------- Questions ----------

def build_question_query(args):
    """Applies every /api/questions filter as real SQL (including tags),
    returning a bare, unordered Query -- reused for both the total count
    and the page fetch so the two can never disagree. Tag filters used to
    be done by pulling every matching row into Python and set-intersecting
    there, which meant "give me the total" and "give me page 3" both had
    to load the ENTIRE result set just to answer -- fine at a few dozen
    questions, but exactly the kind of thing that starts to lag once
    you're into the thousands. `Question.tags.any(...)` turns each tag
    into its own EXISTS clause, so SQLite does the filtering with an
    index instead of Python doing it after the fact."""
    query = Question.query.join(Paper)

    subject = args.get("subject")
    school = args.get("school")
    # unit/topic/subtopic/difficulty are multi-value: repeated query params
    # (unit=3&unit=4) OR together within the field ("has any of these"),
    # same as tags already do -- getlist() just returns a single-item list
    # for the old single-value style, so this stays backward compatible.
    units = args.getlist("unit")
    topics = args.getlist("topic")
    subtopics = args.getlist("subtopic")
    difficulties = args.getlist("difficulty")
    exam_type = args.get("exam_type")
    year_level = args.get("year_level")
    paper_id = args.get("paper_id")
    tags = args.getlist("tag")
    exclude_tags = args.getlist("exclude_tag")

    if subject:
        query = query.filter(Paper.subject == subject)
    if school:
        query = query.filter(Paper.school == school)
    if units:
        query = query.filter(Question.unit.in_([int(u) for u in units]))
    if topics:
        query = query.filter(Question.topic_links.any(QuestionTopic.name.in_(topics)))
    if subtopics:
        query = query.filter(Question.subtopic_links.any(QuestionSubtopic.name.in_(subtopics)))
    if difficulties:
        query = query.filter(Question.difficulty.in_([d.upper() for d in difficulties]))
    if exam_type:
        query = query.filter(Paper.exam_type == exam_type)
    if year_level:
        query = query.filter(Paper.year_level == int(year_level))
    if paper_id:
        query = query.filter(Question.paper_id == int(paper_id))

    # Quick-chopped questions are stored with topic/difficulty as "" rather
    # than NULL (the columns are NOT NULL, but an empty string satisfies
    # that without needing a schema change) -- so "unclassified" just means
    # either of those is empty. Covers old rows too if topic/difficulty
    # were ever blanked out some other way.
    if args.get("unclassified"):
        query = query.filter(
            db.or_(
                Question.topic.is_(None), Question.topic == "",
                Question.difficulty.is_(None), Question.difficulty == "",
            )
        )

    # Each required tag becomes its own EXISTS clause -- chaining several
    # .filter() calls on the same relationship is how you AND them (a
    # question must satisfy every clause), giving "has all of these tags"
    # without ever materializing the full row set in Python.
    for tag_name in tags:
        query = query.filter(Question.tags.any(Tag.name == tag_name))
    if exclude_tags:
        query = query.filter(~Question.tags.any(Tag.name.in_(exclude_tags)))

    return query


@app.route("/api/questions", methods=["GET"])
def list_questions():
    """
    Filterable via query params, e.g.:
    /api/questions?subject=Methods&topic=Calculus&difficulty=CU&school=SchoolX&tag=appeared_on_mock
    Multiple "tag" params are AND'd together (must have all listed tags).
    Multiple "exclude_tag" params are OR'd -- a question with ANY of the
    excluded tags is dropped, regardless of whether it also matches "tag".

    Paginated via ?page=&per_page= (defaults 1 / 60, per_page capped at
    500) -- returns {questions, total, page, per_page, has_more} rather
    than a bare array, so the Browse tab can page/"load more" through
    thousands of results instead of rendering (and the browser laying
    out) every match at once.
    """
    base_query = build_question_query(request.args)

    # Counted on the plain (unjoined-extra) query, before pagination or
    # eager-loading options are attached -- those don't change which rows
    # match, only how they're fetched, so this stays accurate no matter
    # how the fetch below is tuned.
    total = base_query.order_by(None).count()

    page = max(1, request.args.get("page", default=1, type=int) or 1)
    per_page = request.args.get("per_page", default=60, type=int) or 60
    per_page = max(1, min(per_page, 500))

    # selectinload issues one extra query for ALL tags/images across the
    # whole page (2 queries total), instead of one extra query PER
    # question the way the old lazy-loaded `self.paper`, `self.tags`,
    # `self.images` access in to_dict() did -- that N+1 pattern is what
    # turns "60 questions" into "60+ round trips to SQLite" and is the
    # single biggest source of lag once the table has real volume.
    results = (
        base_query
        .options(
            joinedload(Question.paper),
            selectinload(Question.tags),
            selectinload(Question.images),
            selectinload(Question.topic_links),
            selectinload(Question.subtopic_links),
        )
        .order_by(Question.id.desc())
        .offset((page - 1) * per_page)
        .limit(per_page)
        .all()
    )

    return jsonify({
        "questions": [q.to_dict() for q in results],
        "total": total,
        "page": page,
        "per_page": per_page,
        "has_more": page * per_page < total,
    })


@app.route("/api/questions", methods=["POST"])
def create_question():
    """
    Expects JSON:
    {
      "paper_id": 1,
      "question_number": "4b",
      "unit": 3,
      "topics": ["Calculus", "Probability"],      (or the older "topic": "Calculus")
      "subtopics": ["Related rates"],             (or the older "subtopic": "...")
      "difficulty": "CU",
      "page_number": 3,
      "notes": "...",
      "tags": ["appeared_on_mock", "unique"]
    }
    Cropped image upload happens via a separate endpoint (see /api/questions/<id>/crop).
    """
    data = request.get_json()
    topics = names_from_payload(data, "topics", "topic") if data else None
    if not data or not data.get("paper_id") or not topics or not data.get("difficulty"):
        return jsonify({"error": "paper_id, topic, and difficulty are required"}), 400

    paper = Paper.query.get(data["paper_id"])
    if not paper:
        return jsonify({"error": "paper not found"}), 404

    if data["difficulty"].upper() not in {"SF", "CF", "CU"}:
        return jsonify({"error": "difficulty must be SF, CF, or CU"}), 400

    unit = data.get("unit")
    if unit is not None and int(unit) not in {1, 2, 3, 4}:
        return jsonify({"error": "unit must be 1, 2, 3, or 4"}), 400

    question = Question(
        paper_id=paper.id,
        question_number=normalize_question_number(data.get("question_number")),
        unit=int(unit) if unit is not None else None,
        topic=topics[0],
        subtopic=None,
        difficulty=data["difficulty"].upper(),
        page_number=data.get("page_number"),
        notes=data.get("notes"),
    )
    set_topics(question, topics, names_from_payload(data, "subtopics", "subtopic") or [])

    tag_names = data.get("tags", [])
    for name in tag_names:
        tag = Tag.query.filter_by(name=name).first()
        if not tag:
            tag = Tag(name=name)
            db.session.add(tag)
        question.tags.append(tag)

    db.session.add(question)
    db.session.commit()
    return jsonify(question.to_dict()), 201


@app.route("/api/questions/quick", methods=["POST"])
def create_question_quick():
    """
    Fast path for the "chop everything now, classify later" workflow --
    creates a question with topic/difficulty left blank instead of
    requiring them up front. No schema change involved: those columns
    stay NOT NULL, an empty string just satisfies that constraint while
    still meaning "not classified yet" everywhere is_classified is
    checked. Cropped image upload still goes through the normal
    /api/questions/<id>/crop endpoint afterward, same as the full flow.
    Expects JSON: { "paper_id": 1, "page_number": 3 } -- page_number optional.
    The question shows up in the Classify tab's queue until it's given a
    topic and difficulty via the normal PATCH endpoint.
    """
    data = request.get_json() or {}
    if not data.get("paper_id"):
        return jsonify({"error": "paper_id is required"}), 400

    paper = Paper.query.get(data["paper_id"])
    if not paper:
        return jsonify({"error": "paper not found"}), 404

    question = Question(
        paper_id=paper.id,
        question_number=None,
        unit=None,
        topic="",
        subtopic=None,
        difficulty="",
        page_number=data.get("page_number"),
        notes=None,
    )
    db.session.add(question)
    db.session.commit()
    return jsonify(question.to_dict()), 201


@app.route("/api/questions/<int:question_id>", methods=["GET"])
def get_question(question_id):
    """Fetches full detail for one question. The frontend's Browse tab
    already has this data client-side after listing, but this exists so
    the question detail is directly linkable/fetchable (and so hitting the
    URL doesn't 405, which is what "details" was doing before this route
    existed -- only PATCH/DELETE were registered for this path)."""
    question = Question.query.get_or_404(question_id)
    return jsonify(question.to_dict())


@app.route("/api/questions/<int:question_id>", methods=["PATCH"])
def update_question(question_id):
    """Partial update — send only the fields you want to change."""
    question = Question.query.get_or_404(question_id)
    data = request.get_json() or {}

    for field in ["notes", "page_number"]:
        if field in data:
            setattr(question, field, data[field])

    set_topics(
        question,
        names_from_payload(data, "topics", "topic"),
        names_from_payload(data, "subtopics", "subtopic"),
    )

    if "question_number" in data:
        question.question_number = normalize_question_number(data["question_number"])

    if "difficulty" in data:
        if data["difficulty"].upper() not in {"SF", "CF", "CU"}:
            return jsonify({"error": "difficulty must be SF, CF, or CU"}), 400
        question.difficulty = data["difficulty"].upper()

    if "unit" in data:
        unit = data["unit"]
        if unit is not None and int(unit) not in {1, 2, 3, 4}:
            return jsonify({"error": "unit must be 1, 2, 3, or 4"}), 400
        question.unit = int(unit) if unit is not None else None

    if "tags" in data:
        question.tags = []
        for name in data["tags"]:
            tag = Tag.query.filter_by(name=name).first()
            if not tag:
                tag = Tag(name=name)
                db.session.add(tag)
            question.tags.append(tag)

    db.session.commit()
    return jsonify(question.to_dict())


@app.route("/api/questions/<int:question_id>", methods=["DELETE"])
def delete_question(question_id):
    question = Question.query.get_or_404(question_id)
    db.session.delete(question)
    db.session.commit()
    return jsonify({"deleted": question_id})


@app.route("/api/questions/<int:question_id>/crop", methods=["POST"])
def upload_crop(question_id):
    """Adds ONE more page/region to this question. Call it again for a
    question that continues on another page or in another region -- each
    call just appends another part in order, rather than replacing
    anything, so a multi-page question is just several calls."""
    question = Question.query.get_or_404(question_id)
    if "image" not in request.files or request.files["image"].filename == "":
        return jsonify({"error": "image file is required"}), 400

    image = request.files["image"]
    if not allowed_file(image.filename):
        return jsonify({"error": "file type not allowed"}), 400

    page_number = request.form.get("page_number", type=int)
    crop_path = save_upload(image, subfolder=os.path.join("crops", secure_filename(question.paper.subject)))

    next_order = db.session.query(db.func.coalesce(db.func.max(QuestionImage.order_index), -1)) \
        .filter_by(question_id=question.id, kind="question").scalar() + 1
    part = QuestionImage(question_id=question.id, kind="question", page_number=page_number,
                          file_path=crop_path, order_index=next_order)
    db.session.add(part)
    db.session.commit()
    return jsonify(question.to_dict())


@app.route("/api/questions/<int:question_id>/answer", methods=["POST"])
def upload_answer(question_id):
    """
    Adds ONE more page/part to this question's worked solution -- same
    endpoint whether it comes from chopping the solutions PDF alongside
    the paper, or from uploading a worked solution written up later.
    Appends rather than replaces, so a multi-page solution (or one you
    add to over time as you write up more of it) is just several calls.
    Expects multipart/form-data with a "file" field and optional
    "page_number".
    """
    question = Question.query.get_or_404(question_id)
    if "file" not in request.files or request.files["file"].filename == "":
        return jsonify({"error": "file is required"}), 400

    file = request.files["file"]
    if not allowed_file(file.filename):
        return jsonify({"error": "file type not allowed"}), 400

    page_number = request.form.get("page_number", type=int)
    answer_path = save_upload(file, subfolder=os.path.join("answers", secure_filename(question.paper.subject)))

    next_order = db.session.query(db.func.coalesce(db.func.max(QuestionImage.order_index), -1)) \
        .filter_by(question_id=question.id, kind="answer").scalar() + 1
    part = QuestionImage(question_id=question.id, kind="answer", page_number=page_number,
                          file_path=answer_path, order_index=next_order)
    db.session.add(part)
    db.session.commit()
    return jsonify(question.to_dict())


@app.route("/api/questions/<int:question_id>/answer", methods=["DELETE"])
def delete_all_answers(question_id):
    """Removes ALL worked-solution parts linked to this question (e.g. to
    start over with a fresh upload). To remove just one page of a
    multi-page solution instead, use
    DELETE /api/questions/<id>/images/<image_id>."""
    question = Question.query.get_or_404(question_id)
    for img in [i for i in question.images if i.kind == "answer"]:
        old_path = os.path.join(FILES_DIR, img.file_path)
        if os.path.exists(old_path):
            os.remove(old_path)
        db.session.delete(img)
    db.session.commit()
    return jsonify(question.to_dict())


@app.route("/api/questions/<int:question_id>/images/<int:image_id>", methods=["DELETE"])
def delete_question_image(question_id, image_id):
    """Removes one specific page/part (a question crop or one answer
    page) without touching the rest -- what you want for a multi-page
    question/solution where only one page needs redoing."""
    question = Question.query.get_or_404(question_id)
    img = QuestionImage.query.filter_by(id=image_id, question_id=question.id).first_or_404()
    old_path = os.path.join(FILES_DIR, img.file_path)
    if os.path.exists(old_path):
        os.remove(old_path)
    db.session.delete(img)
    db.session.commit()
    return jsonify(question.to_dict())


# ---------- Tags ----------

@app.route("/api/tags", methods=["GET"])
def list_tags():
    tags = Tag.query.order_by(Tag.name).all()
    return jsonify([t.name for t in tags])


# ---------- Topics / subtopics (distinct lists, scoped for cascading dropdowns) ----------

@app.route("/api/topics", methods=["GET"])
def list_topics():
    """Topics are scoped to a subject + unit(s) rather than global, so the
    picker only ever shows topics that actually belong to what you've
    selected (e.g. Physics Unit 4 topics, not every topic in the DB).
    Accepts multiple ?unit= params (union across them) to support
    multi-selecting units in Browse -- a single ?unit= still works exactly
    as before."""
    subject = request.args.get("subject")
    units = request.args.getlist("unit")
    query = db.session.query(QuestionTopic.name) \
        .join(Question, QuestionTopic.question_id == Question.id) \
        .join(Paper, Question.paper_id == Paper.id).distinct()
    if subject:
        query = query.filter(Paper.subject == subject)
    if units:
        query = query.filter(Question.unit.in_([int(u) for u in units]))
    return jsonify(sorted([t[0] for t in query.all() if t[0]]))


@app.route("/api/subtopics", methods=["GET"])
def list_subtopics():
    """Subtopics scoped to subject + unit(s) + topic(s) (e.g.
    Bernoulli/Binomial under Maths Methods Unit 3's "Discrete random
    variables" topic). Accepts multiple ?unit= and ?topic= params (union
    across each) for multi-select in Browse."""
    subject = request.args.get("subject")
    units = request.args.getlist("unit")
    topics = request.args.getlist("topic")
    query = db.session.query(QuestionSubtopic.name) \
        .join(Question, QuestionSubtopic.question_id == Question.id) \
        .join(Paper, Question.paper_id == Paper.id).distinct()
    if subject:
        query = query.filter(Paper.subject == subject)
    if units:
        query = query.filter(Question.unit.in_([int(u) for u in units]))
    if topics:
        query = query.filter(Question.topic_links.any(QuestionTopic.name.in_(topics)))
    return jsonify(sorted([s[0] for s in query.all() if s[0]]))


@app.route("/api/subjects", methods=["GET"])
def list_subjects():
    subjects = db.session.query(Paper.subject).distinct().all()
    return jsonify(sorted([s[0] for s in subjects]))


@app.route("/api/schools", methods=["GET"])
def list_schools():
    schools = db.session.query(Paper.school).distinct().all()
    return jsonify(sorted([s[0] for s in schools]))


# ---------- File serving ----------

@app.route("/files/<path:filepath>")
def serve_file(filepath):
    return send_from_directory(FILES_DIR, filepath)


if __name__ == "__main__":
    with app.app_context():
        db.create_all()
        # db.create_all() only creates tables that don't exist yet -- it
        # won't add new columns to a table that's already on disk, or move
        # data for you. Since this project isn't using Flask-Migrate/Alembic,
        # any schema change needs a small manual migration here too.
        inspector = db.inspect(db.engine)
        existing_cols = {c["name"] for c in inspector.get_columns("questions")}
        if "answer_file_path" not in existing_cols:
            with db.engine.begin() as conn:
                conn.execute(db.text("ALTER TABLE questions ADD COLUMN answer_file_path VARCHAR(300)"))
            existing_cols.add("answer_file_path")

        if "unit" not in existing_cols:
            with db.engine.begin() as conn:
                conn.execute(db.text("ALTER TABLE questions ADD COLUMN unit INTEGER"))
            existing_cols.add("unit")
            # Existing questions (e.g. from before this field existed, or
            # chopped under the old paper-level "unit" that's since been
            # removed) are left with unit=NULL -- there's no reliable way
            # to infer it automatically, especially with old-vs-new
            # syllabus content having moved between units. Use "Edit" on
            # a question in the full-screen viewer to set it retroactively,
            # question by question, without re-uploading anything.

        # Multi-page support: question/answer images now live in their own
        # question_images table (one question can have several page crops)
        # instead of a single crop_image_path / answer_file_path column. If
        # this is an existing DB with old-style single-file questions
        # (e.g. from your earlier workflow test), copy those in as each
        # question's first part so nothing gets orphaned by the change.
        if "crop_image_path" in existing_cols or "answer_file_path" in existing_cols:
            with db.engine.begin() as conn:
                cols = ", ".join(c for c in ["id", "crop_image_path", "answer_file_path"] if c in existing_cols or c == "id")
                rows = conn.execute(db.text(f"SELECT {cols} FROM questions")).fetchall()
                for row in rows:
                    row = row._mapping
                    qid = row["id"]
                    crop_path = row.get("crop_image_path")
                    answer_path = row.get("answer_file_path")
                    if crop_path:
                        exists = conn.execute(db.text(
                            "SELECT 1 FROM question_images WHERE question_id=:qid AND kind='question' LIMIT 1"
                        ), {"qid": qid}).fetchone()
                        if not exists:
                            conn.execute(db.text(
                                "INSERT INTO question_images (question_id, kind, file_path, order_index, date_added) "
                                "VALUES (:qid, 'question', :fp, 0, :now)"
                            ), {"qid": qid, "fp": crop_path, "now": datetime.utcnow()})
                    if answer_path:
                        exists = conn.execute(db.text(
                            "SELECT 1 FROM question_images WHERE question_id=:qid AND kind='answer' LIMIT 1"
                        ), {"qid": qid}).fetchone()
                        if not exists:
                            conn.execute(db.text(
                                "INSERT INTO question_images (question_id, kind, file_path, order_index, date_added) "
                                "VALUES (:qid, 'answer', :fp, 0, :now)"
                            ), {"qid": qid, "fp": answer_path, "now": datetime.utcnow()})

        # Normalize any existing question_number values to always include a
        # leading "Q", matching what new saves now produce. Some earlier
        # chopping already typed "Q1" manually, some just typed "1" -- left
        # inconsistent, any display code adding its own "Q" would double up
        # on the ones that already had one (showing "QQ1"). This is a plain
        # data normalization (not a schema change), safe to re-run every
        # startup since it's a no-op once everything's already normalized.
        to_fix = Question.query.filter(Question.question_number.isnot(None)).all()
        changed = False
        for q in to_fix:
            normalized = normalize_question_number(q.question_number)
            if normalized != q.question_number:
                q.question_number = normalized
                changed = True
        if changed:
            db.session.commit()

        # Multi-topic support. db.create_all() above has already created the
        # question_topics / question_subtopics tables (empty). This copies each
        # EXISTING question's single topic/subtopic in as its first list entry.
        # It only ever INSERTs into the new tables -- the questions table and
        # its columns are never modified -- and it's safe to re-run every
        # start-up: a question is only backfilled if it has no rows yet.
        # An older version of the app (which only knows the single-value
        # columns) may have edited or deleted questions since, so first drop
        # link rows whose question is gone, and after the backfill realign
        # the first entry of any question whose column was changed.
        with db.engine.begin() as conn:
            for table, column in (("question_topics", "topic"), ("question_subtopics", "subtopic")):
                conn.execute(db.text(f"DELETE FROM {table} WHERE question_id NOT IN (SELECT id FROM questions)"))
                conn.execute(db.text(f"""
                    INSERT INTO {table} (question_id, name, position)
                    SELECT q.id, q.{column}, 0 FROM questions q
                    WHERE q.{column} IS NOT NULL AND TRIM(q.{column}) != ''
                      AND NOT EXISTS (SELECT 1 FROM {table} l WHERE l.question_id = q.id)
                """))
                conn.execute(db.text(f"""
                    UPDATE {table}
                    SET name = (SELECT q.{column} FROM questions q WHERE q.id = {table}.question_id)
                    WHERE position = 0
                      AND (SELECT TRIM(q.{column}) FROM questions q WHERE q.id = {table}.question_id) != ''
                      AND name != (SELECT q.{column} FROM questions q WHERE q.id = {table}.question_id)
                """))

        # Indexes for the columns Browse actually filters/joins on. Safe to
        # add on top of an existing database with data already in it --
        # CREATE INDEX IF NOT EXISTS only builds a lookup structure
        # alongside the table, it doesn't move or rewrite any rows. This is
        # what keeps filtering fast as the question count grows into the
        # thousands instead of degrading into full-table scans.
        with db.engine.begin() as conn:
            conn.execute(db.text("CREATE INDEX IF NOT EXISTS idx_paper_subject ON papers(subject)"))
            conn.execute(db.text("CREATE INDEX IF NOT EXISTS idx_paper_school ON papers(school)"))
            conn.execute(db.text("CREATE INDEX IF NOT EXISTS idx_paper_exam_type ON papers(exam_type)"))
            conn.execute(db.text("CREATE INDEX IF NOT EXISTS idx_question_paper_id ON questions(paper_id)"))
            conn.execute(db.text("CREATE INDEX IF NOT EXISTS idx_question_topic ON questions(topic)"))
            conn.execute(db.text("CREATE INDEX IF NOT EXISTS idx_question_subtopic ON questions(subtopic)"))
            conn.execute(db.text("CREATE INDEX IF NOT EXISTS idx_question_difficulty ON questions(difficulty)"))
            conn.execute(db.text("CREATE INDEX IF NOT EXISTS idx_question_unit ON questions(unit)"))
            conn.execute(db.text("CREATE INDEX IF NOT EXISTS idx_qimage_question_id ON question_images(question_id)"))
            conn.execute(db.text("CREATE INDEX IF NOT EXISTS idx_qtopic_name ON question_topics(name)"))
            conn.execute(db.text("CREATE INDEX IF NOT EXISTS idx_qtopic_question_id ON question_topics(question_id)"))
            conn.execute(db.text("CREATE INDEX IF NOT EXISTS idx_qsubtopic_name ON question_subtopics(name)"))
            conn.execute(db.text("CREATE INDEX IF NOT EXISTS idx_qsubtopic_question_id ON question_subtopics(question_id)"))
    # debug=False: this runs permanently as a systemd service, not a dev
    # session -- the debug reloader can restart mid-request on a file
    # change, and the debugger's error page allows running arbitrary code
    # from the browser, which isn't something a permanently-on service
    # should expose even over Tailscale-only access.
    app.run(host="0.0.0.0", port=5000, debug=False)
