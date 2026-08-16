from flask import Flask, jsonify, request, send_from_directory, render_template
from flask_sqlalchemy import SQLAlchemy
from werkzeug.utils import secure_filename
from datetime import datetime
import os
import uuid

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "questions.db")

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(os.path.join(DATA_DIR, "files"), exist_ok=True)

app = Flask(__name__)
app.config["SQLALCHEMY_DATABASE_URI"] = f"sqlite:///{DB_PATH}"
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

db = SQLAlchemy(app)

ALLOWED_EXTENSIONS = {"pdf", "doc", "docx", "png", "jpg", "jpeg"}
FILES_DIR = os.path.join(DATA_DIR, "files")


def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


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
    unit = db.Column(db.Integer, nullable=True)  # QCE unit: 1, 2, 3, or 4 -- what topics get scoped under
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
            "unit": self.unit,
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
    topic = db.Column(db.String(120), nullable=False)
    subtopic = db.Column(db.String(120), nullable=True)
    difficulty = db.Column(db.String(2), nullable=False)  # SF / CF / CU
    page_number = db.Column(db.Integer, nullable=True)  # page the question STARTS on
    notes = db.Column(db.Text, nullable=True)
    date_added = db.Column(db.DateTime, default=datetime.utcnow)

    tags = db.relationship("Tag", secondary=question_tags, backref="questions")

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
            "topic": self.topic,
            "subtopic": self.subtopic,
            "difficulty": self.difficulty,
            "page_number": self.page_number,
            "notes": self.notes,
            "question_images": q_images,
            "answer_images": a_images,
            "has_answer": len(a_images) > 0,
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
    unit = request.form.get("unit")
    exam_type = request.form.get("exam_type")
    exam_year = request.form.get("exam_year")

    if not all([school, subject, year_level, unit, exam_type]):
        return jsonify({"error": "school, subject, year_level, unit, exam_type are required"}), 400

    if unit not in {"1", "2", "3", "4"}:
        return jsonify({"error": "unit must be 1, 2, 3, or 4"}), 400

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
        unit=int(unit),
        exam_type=exam_type,
        exam_year=int(exam_year) if exam_year else None,
        file_path=file_path,
        solution_file_path=solution_path,
    )
    db.session.add(paper)
    db.session.commit()
    return jsonify(paper.to_dict()), 201


@app.route("/api/papers/<int:paper_id>", methods=["PATCH"])
def update_paper(paper_id):
    """Partial update for a paper's metadata (school, subject, year_level,
    unit, exam_type, exam_year) -- for backfilling fields like "unit" on
    a paper you added before that field existed, without re-uploading
    the file or touching any questions already chopped from it."""
    paper = Paper.query.get_or_404(paper_id)
    data = request.get_json() or {}

    if "school" in data and data["school"]:
        paper.school = data["school"]
    if "subject" in data and data["subject"]:
        paper.subject = data["subject"]
    if "year_level" in data and data["year_level"]:
        paper.year_level = int(data["year_level"])
    if "unit" in data:
        if data["unit"] in (None, ""):
            paper.unit = None
        elif str(data["unit"]) in {"1", "2", "3", "4"}:
            paper.unit = int(data["unit"])
        else:
            return jsonify({"error": "unit must be 1, 2, 3, or 4"}), 400
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

@app.route("/api/questions", methods=["GET"])
def list_questions():
    """
    Filterable via query params, e.g.:
    /api/questions?subject=Methods&topic=Calculus&difficulty=CU&school=SchoolX&tag=appeared_on_mock
    Multiple tag params are AND'd together (must have all listed tags).
    """
    query = Question.query.join(Paper)

    subject = request.args.get("subject")
    school = request.args.get("school")
    unit = request.args.get("unit")
    topic = request.args.get("topic")
    subtopic = request.args.get("subtopic")
    difficulty = request.args.get("difficulty")
    exam_type = request.args.get("exam_type")
    year_level = request.args.get("year_level")
    paper_id = request.args.get("paper_id")
    tags = request.args.getlist("tag")

    if subject:
        query = query.filter(Paper.subject == subject)
    if school:
        query = query.filter(Paper.school == school)
    if unit:
        query = query.filter(Paper.unit == int(unit))
    if topic:
        query = query.filter(Question.topic == topic)
    if subtopic:
        query = query.filter(Question.subtopic == subtopic)
    if difficulty:
        query = query.filter(Question.difficulty == difficulty.upper())
    if exam_type:
        query = query.filter(Paper.exam_type == exam_type)
    if year_level:
        query = query.filter(Paper.year_level == int(year_level))
    if paper_id:
        query = query.filter(Question.paper_id == int(paper_id))

    results = query.all()

    if tags:
        tag_set = set(tags)
        results = [q for q in results if tag_set.issubset({t.name for t in q.tags})]

    return jsonify([q.to_dict() for q in results])


@app.route("/api/questions", methods=["POST"])
def create_question():
    """
    Expects JSON:
    {
      "paper_id": 1,
      "question_number": "4b",
      "topic": "Calculus",
      "subtopic": "Related rates",
      "difficulty": "CU",
      "page_number": 3,
      "notes": "...",
      "tags": ["appeared_on_mock", "unique"]
    }
    Cropped image upload happens via a separate endpoint (see /api/questions/<id>/crop).
    """
    data = request.get_json()
    if not data or not data.get("paper_id") or not data.get("topic") or not data.get("difficulty"):
        return jsonify({"error": "paper_id, topic, and difficulty are required"}), 400

    paper = Paper.query.get(data["paper_id"])
    if not paper:
        return jsonify({"error": "paper not found"}), 404

    if data["difficulty"].upper() not in {"SF", "CF", "CU"}:
        return jsonify({"error": "difficulty must be SF, CF, or CU"}), 400

    question = Question(
        paper_id=paper.id,
        question_number=data.get("question_number"),
        topic=data["topic"],
        subtopic=data.get("subtopic"),
        difficulty=data["difficulty"].upper(),
        page_number=data.get("page_number"),
        notes=data.get("notes"),
    )

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

    for field in ["question_number", "topic", "subtopic", "notes", "page_number"]:
        if field in data:
            setattr(question, field, data[field])

    if "difficulty" in data:
        if data["difficulty"].upper() not in {"SF", "CF", "CU"}:
            return jsonify({"error": "difficulty must be SF, CF, or CU"}), 400
        question.difficulty = data["difficulty"].upper()

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
    """Topics are scoped to a subject+unit rather than global, so the
    dropdown only ever shows topics that actually belong to what you've
    selected (e.g. Physics Unit 4 topics, not every topic in the DB)."""
    subject = request.args.get("subject")
    unit = request.args.get("unit")
    query = db.session.query(Question.topic).join(Paper).distinct()
    if subject:
        query = query.filter(Paper.subject == subject)
    if unit:
        query = query.filter(Paper.unit == int(unit))
    return jsonify(sorted([t[0] for t in query.all()]))


@app.route("/api/subtopics", methods=["GET"])
def list_subtopics():
    """Subtopics scoped to subject+unit+topic (e.g. Bernoulli/Binomial
    under Maths Methods Unit 3's "Discrete random variables" topic)."""
    subject = request.args.get("subject")
    unit = request.args.get("unit")
    topic = request.args.get("topic")
    query = db.session.query(Question.subtopic).join(Paper) \
        .filter(Question.subtopic.isnot(None)).distinct()
    if subject:
        query = query.filter(Paper.subject == subject)
    if unit:
        query = query.filter(Paper.unit == int(unit))
    if topic:
        query = query.filter(Question.topic == topic)
    return jsonify(sorted([s[0] for s in query.all()]))


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

        existing_paper_cols = {c["name"] for c in inspector.get_columns("papers")}
        if "unit" not in existing_paper_cols:
            with db.engine.begin() as conn:
                conn.execute(db.text("ALTER TABLE papers ADD COLUMN unit INTEGER"))
            # existing papers from before "unit" existed are left NULL --
            # they'll just show "no unit" in the UI until you edit them.

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
    app.run(host="0.0.0.0", port=5000, debug=True)
