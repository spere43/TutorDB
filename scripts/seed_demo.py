#!/usr/bin/env python3
"""
Populate TutorDB with a small, fully fictional demo dataset.

Everything here is original: the "schools" don't exist and every question
is a short, made-up exercise rendered to an image with Pillow. It exists so
you can try the app without needing any real exam papers. You get:

  * 3 papers (PDFs you can practise chopping on) with worked solutions
  * 13 classified questions, some with several topics/subtopics
  * 2 questions flagged for review (see the Classify tab -> Reclassify)
  * 4 unclassified "screenshot" questions waiting in the Classify queue

Usage (from the project root):

    pip install pillow
    python scripts/seed_demo.py

It writes into ./data/ (the same place the app stores real data), so it
refuses to run if the database already contains papers. To start over,
stop the app and delete the data/ folder first.
"""

import os
import sys
import uuid

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit("This script needs Pillow:  pip install pillow")

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)

from app import (  # noqa: E402
    app, db, FILES_DIR, Paper, Question, QuestionImage, Tag,
    set_topics, get_or_create_collection,
)

# ---------------------------------------------------------------------------
# Demo content
# ---------------------------------------------------------------------------

PAPERS = [
    dict(school="Made Up School 1", subject="Mathematical Methods",
         year_level=12, exam_type="mock", exam_year=2025, solutions=True),
    dict(school="Made Up School 2", subject="Mathematical Methods",
         year_level=11, exam_type="internal", exam_year=2024, solutions=False),
    dict(school="Made Up School 1", subject="Physics",
         year_level=12, exam_type="QCAA", exam_year=2025, solutions=True),
]

CALC = "Further differentiation and applications"

QUESTIONS = [
    # ---- Paper 0: Methods, Made Up School 1 mock ---------------------------------
    dict(paper=0, num="Q1", unit=3, topic=CALC, sub="Product rule", diff="SF",
         tags=["unique", "Tech free"], marks=2,
         q=["Differentiate  f(x) = x² sin(x)  with respect to x."],
         a=["f′(x) = 2x sin(x) + x² cos(x)", "(product rule: u = x², v = sin x)"]),
    dict(paper=0, num="Q2", unit=3, topic="Integrals", sub="Definite integrals", diff="SF",
         tags=["appeared on mock", "Tech free"], marks=2,
         q=["Evaluate the definite integral", "", "        ∫ sin(x) dx     from x = 0 to x = π"],
         a=["[ −cos(x) ] from 0 to π  =  −cos(π) + cos(0)", "= 1 + 1  =  2"]),
    dict(paper=0, num="Q3", unit=3, topic="Discrete random variables", sub="Binomial distribution",
         diff="CF", tags=["unique"], marks=3,
         q=["A biased coin lands heads with probability 0.6.",
            "It is tossed 5 times. Let X be the number of heads.",
            "", "Find P(X = 3), correct to four decimal places."],
         a=["X ~ Bin(5, 0.6)", "P(X = 3) = C(5,3) × 0.6³ × 0.4²",
            "        = 10 × 0.216 × 0.16", "        = 0.3456"]),
    dict(paper=0, num="Q4", unit=3, topic=CALC, sub="Optimisation", diff="CF",
         subs=["Optimisation", "Rates of change"],           # several subtopics on one question
         tags=["appeared on mock", "Tech active"], marks=4,
         q=["A farmer has 200 m of fencing to enclose a rectangular paddock",
            "that borders a straight river. No fence is needed along the river.",
            "", "Find the dimensions that maximise the enclosed area,",
            "and state that maximum area."],
         a=["Let width = w (two sides), length = 200 − 2w.",
            "A(w) = w(200 − 2w) = 200w − 2w²",
            "A′(w) = 200 − 4w = 0   →   w = 50.",
            "Length = 100 m.   Maximum area = 50 × 100 = 5000 m²."]),
    dict(paper=0, num="Q5", unit=4, topic="Logarithmic functions", sub="Logarithm laws", diff="CF",
         tags=["unique"], marks=3,
         q=["Solve for x:", "", "        2 ln(x) − ln(x − 1) = ln(4)"],
         a=["ln(x²/(x − 1)) = ln 4   →   x² = 4(x − 1)",
            "x² − 4x + 4 = 0   →   (x − 2)² = 0   →   x = 2"]),
    dict(paper=0, num="Q6", unit=4, topic="Continuous random variables and the normal distribution",
         sub="Standardising", diff="SF", tags=["appeared on mock"], marks=2,
         q=["The random variable X is normally distributed with mean 50",
            "and standard deviation 4.", "", "Find P(X > 58)."],
         a=["z = (58 − 50) / 4 = 2", "P(X > 58) = P(Z > 2) ≈ 0.0228"]),
    dict(paper=0, num="Q7", unit=3, topic="Integrals", sub="Rates of change", diff="CU",
         topics=["Integrals", CALC],                         # several topics on one question
         flag="Difficulty looks high for a CU - check against the syllabus",
         tags=["circulating", "unique", "Tech active"], marks=4,
         q=["Water flows into a tank at the rate", "",
            "        r(t) = 6 + 4 sin(πt / 12)   litres per hour,", "",
            "where t is the time in hours after midnight.",
            "(a) Find the total volume that flows in during one full day.",
            "(b) Explain why the sine term does not affect your answer."],
         a=["(a) V = ∫ r(t) dt from 0 to 24 = [6t − (48/π) cos(πt/12)] from 0 to 24",
            "     = 144 − (48/π)(cos 2π − cos 0) = 144 L",
            "(b) sin(πt/12) has period 24 h, so over a whole period its",
            "     positive and negative areas cancel exactly."]),

    # ---- Paper 1: Methods, Made Up School 2 internal -----------------------------
    dict(paper=1, num="Q1", unit=3, topic=CALC, sub="Chain rule", diff="SF",
         tags=["unique"], marks=2,
         q=["Differentiate  g(x) = (3x + 1)⁵."], a=["g′(x) = 5(3x + 1)⁴ × 3 = 15(3x + 1)⁴"]),
    dict(paper=1, num="Q2", unit=3, topic="Discrete random variables", sub="Bernoulli trials",
         diff="SF", tags=["appeared on mock"], marks=2,
         q=["A fair die is rolled once. A success is rolling a six.",
            "State the mean and variance of the Bernoulli random variable X."],
         a=["p = 1/6:  E(X) = 1/6,   Var(X) = p(1 − p) = 5/36"]),

    # ---- Paper 2: Physics, Made Up School 1 QCAA-style ---------------------------
    dict(paper=2, num="Q1", unit=2, topic="Linear motion and waves", sub="Kinematics", diff="SF",
         tags=["unique"], marks=2,
         q=["A ball is thrown vertically upward at 14 m/s.",
            "Taking g = 9.8 m/s², find the maximum height reached."],
         a=["v² = u² + 2as  →  0 = 14² − 2(9.8)h", "h = 196 / 19.6 = 10 m"]),
    dict(paper=2, num="Q2", unit=3, topic="Gravity and electromagnetism", sub="Orbital motion", diff="CF",
         flag="Unit 3 or Unit 4?",
         tags=["appeared on mock"], marks=3,
         q=["A satellite is in a circular orbit of radius 7.0 × 10⁶ m about Earth.",
            "(M = 5.97 × 10²⁴ kg,  G = 6.67 × 10⁻¹¹ N m² kg⁻²)", "",
            "Calculate the satellite's orbital speed."],
         a=["v = √(GM / r) = √(6.67×10⁻¹¹ × 5.97×10²⁴ / 7.0×10⁶)",
            "  ≈ 7.5 × 10³ m/s"]),
    dict(paper=2, num="Q3", unit=4, topic="Revolutions in modern physics", sub="Photoelectric effect",
         diff="CF", tags=["unique"], marks=3,
         q=["Light of frequency 8.0 × 10¹⁴ Hz is incident on a metal",
            "with work function 2.5 eV.", "",
            "Calculate the maximum kinetic energy of the emitted photoelectrons, in eV."],
         a=["E = hf = 6.63×10⁻³⁴ × 8.0×10¹⁴ = 5.30×10⁻¹⁹ J ≈ 3.31 eV",
            "KE(max) = 3.31 − 2.5 ≈ 0.81 eV"]),
    dict(paper=2, num="Q4", unit=1, topic="Thermal, nuclear and electrical physics", sub="Specific heat",
         diff="SF", tags=["circulating"], marks=2,
         q=["How much energy is needed to heat 0.50 kg of water from 20 °C to 100 °C?",
            "(c = 4180 J kg⁻¹ K⁻¹)"],
         a=["Q = mcΔT = 0.50 × 4180 × 80 = 1.7 × 10⁵ J"]),
]

# Like screenshots added with Quick Add: unclassified questions on a subject's
# hidden "Screenshots" paper, waiting in the Classify queue.
SCREENSHOTS = [
    dict(subject="Mathematical Methods", label="Screenshot",
         lines=["Find the derivative of  y = e^(3x) cos(x)."]),
    dict(subject="Mathematical Methods", label="Screenshot",
         lines=["A fair coin is tossed 8 times.", "Find the probability of exactly 5 heads."]),
    dict(subject="Physics", label="Screenshot",
         lines=["A 2.0 kg trolley accelerates from rest at 3.0 m/s².", "How far does it travel in 4.0 s?"]),
    dict(subject="Physics", label="Screenshot",
         lines=["State two differences between fission and fusion."]),
]

# ---------------------------------------------------------------------------
# Image rendering helpers
# ---------------------------------------------------------------------------

FONT_CANDIDATES = ["DejaVuSans.ttf", "Arial Unicode.ttf", "arial.ttf", "seguisym.ttf",
                   "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"]
BOLD_CANDIDATES = ["DejaVuSans-Bold.ttf", "arialbd.ttf", "Arial Bold.ttf"]


def load_font(candidates, size):
    for name in candidates:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


BODY = load_font(FONT_CANDIDATES, 20)
BOLD = load_font(BOLD_CANDIDATES, 20)
SMALL = load_font(FONT_CANDIDATES, 15)

BLOCK_W = 720
PAGE_W, PAGE_H = 827, 1169  # ~A4 at 100 dpi
MARGIN = 54


def wrap(line, font, max_w):
    """Greedy word-wrap that keeps a line's leading indent on continuation lines."""
    indent = line[: len(line) - len(line.lstrip(" "))]
    words, out, cur = line.strip().split(" "), [], indent
    probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    for w in words:
        trial = (cur + " " + w) if cur.strip() else (cur + w)
        if probe.textlength(trial, font=font) <= max_w or not cur.strip():
            cur = trial
        else:
            out.append(cur)
            cur = indent + "    " + w
    out.append(cur)
    return out


def render_block(label, marks, lines):
    """One question (or solution) rendered as a tightly-cropped white image."""
    lines = [sub for line in lines for sub in (wrap(line, BODY, BLOCK_W - 28) if line.strip() else [""])]
    line_h = 30
    h = 24 + line_h * (len(lines) + 1) + 20
    img = Image.new("RGB", (BLOCK_W, h), "white")
    d = ImageDraw.Draw(img)
    d.text((14, 16), label, font=BOLD, fill="black")
    if marks:
        tag = f"({marks} marks)"
        d.text((BLOCK_W - 14 - d.textlength(tag, font=SMALL), 20), tag, font=SMALL, fill="#444")
    y = 16 + line_h
    for line in lines:
        d.text((14, y), line, font=BODY, fill="black")
        y += line_h
    return img


def paginate(blocks, title, footer):
    """Stack (block, key) pairs onto A4-ish pages. Returns (pages, {key: page_no})."""
    pages, placement = [], {}

    def new_page():
        p = Image.new("RGB", (PAGE_W, PAGE_H), "white")
        d = ImageDraw.Draw(p)
        d.text((MARGIN, 40), title, font=BOLD, fill="black")
        d.line((MARGIN, 76, PAGE_W - MARGIN, 76), fill="black", width=2)
        d.text((MARGIN, PAGE_H - 50), footer, font=SMALL, fill="#666")
        return p, 100

    page, y = new_page()
    for img, key in blocks:
        if y + img.height > PAGE_H - 80:
            pages.append(page)
            page, y = new_page()
        page.paste(img, (MARGIN, y))
        placement[key] = len(pages) + 1
        y += img.height + 26
    pages.append(page)
    return pages, placement


def store(subfolder, filename, writer):
    """Write a file under data/files/<subfolder>/ and return its relative path."""
    target_dir = os.path.join(FILES_DIR, subfolder)
    os.makedirs(target_dir, exist_ok=True)
    name = f"{uuid.uuid4().hex}_{filename}"
    writer(os.path.join(target_dir, name))
    return f"{subfolder.replace(os.sep, '/')}/{name}"


def save_png(subfolder, filename, img):
    return store(subfolder, filename, lambda p: img.save(p, "PNG", optimize=True))


def save_pdf(subfolder, filename, pages):
    return store(subfolder, filename,
                 lambda p: pages[0].save(p, "PDF", save_all=True, append_images=pages[1:], resolution=100))


def slug(text):
    return "".join(c for c in text.replace(" ", "_") if c.isalnum() or c in "_-")


# ---------------------------------------------------------------------------
# Seed
# ---------------------------------------------------------------------------

def main():
    with app.app_context():
        db.create_all()
        if Paper.query.count() > 0:
            sys.exit("data/ already contains papers - refusing to add demo data on top of it.\n"
                     "Stop the app and delete the data/ folder if you really want a fresh demo.")

        tags = {}

        def tag(name):
            if name not in tags:
                tags[name] = Tag.query.filter_by(name=name).first() or Tag(name=name)
            return tags[name]

        for idx, spec in enumerate(PAPERS):
            subject_dir = slug(spec["subject"])
            items = [(i, q) for i, q in enumerate(QUESTIONS) if q["paper"] == idx]
            title = f'{spec["school"]} - {spec["subject"]} ({spec["exam_type"]}, {spec["exam_year"]})'

            q_blocks = [(render_block(q["num"], q["marks"], q["q"]), i) for i, q in items]
            pages, placement = paginate(q_blocks, title, "DEMO DATA - fictional questions")
            paper_path = save_pdf(subject_dir, "demo_paper.pdf", pages)

            solution_path = None
            if spec["solutions"]:
                a_blocks = [(render_block(q["num"] + " - worked solution", None, q["a"]), i) for i, q in items]
                sol_pages, _ = paginate(a_blocks, title + " - SOLUTIONS", "DEMO DATA - fictional solutions")
                solution_path = save_pdf(subject_dir, "demo_solutions.pdf", sol_pages)

            paper = Paper(school=spec["school"], subject=spec["subject"], year_level=spec["year_level"],
                          exam_type=spec["exam_type"], exam_year=spec["exam_year"],
                          file_path=paper_path, solution_file_path=solution_path)
            db.session.add(paper)
            db.session.flush()

            for (i, q), (q_img, _) in zip(items, q_blocks):
                page_no = placement[i]
                question = Question(paper_id=paper.id, question_number=q["num"], unit=q["unit"],
                                    topic=q["topic"], subtopic=None, difficulty=q["diff"],
                                    page_number=page_no)
                # set_topics keeps the topic lists and the single-value columns in sync
                set_topics(question, q.get("topics", [q["topic"]]), q.get("subs", [q["sub"]]))
                if q.get("flag"):
                    question.needs_review, question.review_note = True, q["flag"]
                question.tags = [tag(t) for t in q["tags"]]
                db.session.add(question)
                db.session.flush()

                db.session.add(QuestionImage(
                    question_id=question.id, kind="question", page_number=page_no, order_index=0,
                    file_path=save_png(os.path.join("crops", subject_dir), f"q{i}.png", q_img)))

                # Give most (not all) questions a worked solution, like a real bank.
                if spec["solutions"] and i % 5 != 4:
                    a_img = render_block(q["num"] + " - worked solution", None, q["a"])
                    db.session.add(QuestionImage(
                        question_id=question.id, kind="answer", page_number=None, order_index=0,
                        file_path=save_png(os.path.join("answers", subject_dir), f"a{i}.png", a_img)))

        # Unclassified "screenshot" questions (no paper of their own, no chopping).
        for i, shot in enumerate(SCREENSHOTS):
            paper, _ = get_or_create_collection(shot["subject"])
            question = Question(paper_id=paper.id, question_number=None, unit=None,
                                topic="", subtopic=None, difficulty="", page_number=None)
            db.session.add(question)
            db.session.flush()
            img = render_block(shot["label"], None, shot["lines"])
            db.session.add(QuestionImage(
                question_id=question.id, kind="question", page_number=None, order_index=0,
                file_path=save_png(os.path.join("crops", slug(shot["subject"])), f"shot{i}.png", img)))

        db.session.commit()
        unclassified = Question.query.filter(Question.topic == "").count()
        flagged = Question.query.filter(Question.needs_review.is_(True)).count()
        print(f"Seeded {Paper.query.filter_by(is_collection=False).count()} papers and "
              f"{Question.query.count()} questions ({unclassified} unclassified, {flagged} flagged) into data/.")
        print("Start the app with:  python app.py   ->  http://localhost:5000")


if __name__ == "__main__":
    main()
