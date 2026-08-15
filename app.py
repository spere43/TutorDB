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
    topic = db.Column(db.String(120), nullable=False)
    subtopic = db.Column(db.String(120), nullable=True)
    difficulty = db.Column(db.String(2), nullable=False)  # SF / CF / CU
    crop_image_path = db.Column(db.String(300), nullable=True)  # chopped-out question image
    page_number = db.Column(db.Integer, nullable=True)  # fallback if not cropped
    notes = db.Column(db.Text, nullable=True)
    date_added = db.Column(db.DateTime, default=datetime.utcnow)

    tags = db.relationship("Tag", secondary=question_tags, backref="questions")

    def to_dict(self):
        return {
            "id": self.id,
            "paper_id": self.paper_id,
            "question_number": self.question_number,
            "topic": self.topic,
            "subtopic": self.subtopic,
            "difficulty": self.difficulty,
            "crop_image_path": self.crop_image_path,
            "page_number": self.page_number,
            "notes": self.notes,
            "tags": [t.name for t in self.tags],
            "school": self.paper.school,
            "subject": self.paper.subject,
            "exam_type": self.paper.exam_type,
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
    topic = request.args.get("topic")
    difficulty = request.args.get("difficulty")
    exam_type = request.args.get("exam_type")
    year_level = request.args.get("year_level")
    tags = request.args.getlist("tag")

    if subject:
        query = query.filter(Paper.subject == subject)
    if school:
        query = query.filter(Paper.school == school)
    if topic:
        query = query.filter(Question.topic == topic)
    if difficulty:
        query = query.filter(Question.difficulty == difficulty.upper())
    if exam_type:
        query = query.filter(Paper.exam_type == exam_type)
    if year_level:
        query = query.filter(Paper.year_level == int(year_level))

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
    """Upload a cropped image of this question (from the chopping UI)."""
    question = Question.query.get_or_404(question_id)
    if "image" not in request.files or request.files["image"].filename == "":
        return jsonify({"error": "image file is required"}), 400

    image = request.files["image"]
    crop_path = save_upload(image, subfolder=os.path.join("crops", secure_filename(question.paper.subject)))
    question.crop_image_path = crop_path
    db.session.commit()
    return jsonify(question.to_dict())


# ---------- Tags ----------

@app.route("/api/tags", methods=["GET"])
def list_tags():
    tags = Tag.query.order_by(Tag.name).all()
    return jsonify([t.name for t in tags])


# ---------- Topics (distinct list, useful for populating dropdowns) ----------

@app.route("/api/topics", methods=["GET"])
def list_topics():
    subject = request.args.get("subject")
    query = db.session.query(Question.topic).join(Paper).distinct()
    if subject:
        query = query.filter(Paper.subject == subject)
    return jsonify(sorted([t[0] for t in query.all()]))


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
    app.run(host="0.0.0.0", port=5000, debug=True)
