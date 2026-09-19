# TutorDB API reference

The web UI is a client of this JSON API, so everything the UI does can be scripted. All examples assume the app is running at `http://localhost:5000`.

- [Conventions](#conventions)
- [Objects](#objects)
- [Topics and subtopics](#topics-and-subtopics)
- [Flagging for review](#flagging-for-review)
- [Papers](#papers)
- [Screenshots](#screenshots)
- [Questions](#questions)
- [Classify queue](#classify-queue)
- [Question parts (crops and answers)](#question-parts-crops-and-answers)
- [Lookups](#lookups)
- [Operations](#operations)
- [End-to-end example](#end-to-end-example)

## Conventions

- **Base path:** `/api/...` for data, `/files/...` for uploaded files.
- **Request bodies:** JSON (`Content-Type: application/json`) for metadata, `multipart/form-data` wherever a file is uploaded.
- **Errors:** validation problems return a JSON body `{"error": "message"}` with status `400` (or `404` where noted). A request for an id that doesn't exist (`/api/questions/999`) returns Flask's default `404` page rather than JSON.
- **Deletes** return `{"deleted": <id>}` (for papers and questions) or the updated question object (for question parts).
- **No authentication.** See the [security notes](../README.md#security-and-privacy-notes).
- **Upload types:** papers, solutions and answers accept `pdf`, `doc`, `docx`, `png`, `jpg`, `jpeg`; anything else returns `400 file type not allowed`. [`/api/screenshots`](#screenshots) accepts only `png`, `jpg`, `jpeg`.
- **Key order** in JSON responses is not significant.

## Objects

### Paper

```json
{
  "id": 1,
  "school": "Made Up School 1",
  "subject": "Mathematical Methods",
  "year_level": 12,
  "exam_type": "mock",
  "exam_year": 2025,
  "file_path": "Mathematical_Methods/3f2a…_demo_paper.pdf",
  "solution_file_path": "Mathematical_Methods/9c1b…_demo_solutions.pdf",
  "is_collection": false
}
```

`file_path` and `solution_file_path` are relative to `data/files/`; fetch them at `/files/<file_path>`. `exam_year` and `solution_file_path` may be `null`.

`is_collection` is `true` for the hidden per-subject **Screenshots** paper that [`/api/screenshots`](#screenshots) attaches questions to. It has an empty `file_path` because there is no original file.

`GET /api/papers` adds one more field to each paper: `question_count`, how many questions currently belong to it.

### Question

```json
{
  "id": 7,
  "paper_id": 1,
  "question_number": "Q7",
  "unit": 3,
  "topic": "Integrals",
  "subtopic": "Rates of change",
  "topics": ["Integrals", "Further differentiation and applications"],
  "subtopics": ["Rates of change"],
  "difficulty": "CU",
  "page_number": 2,
  "notes": null,
  "question_images": [
    { "id": 12, "kind": "question", "page_number": 2, "file_path": "crops/Mathematical_Methods/…png", "order_index": 0 }
  ],
  "answer_images": [
    { "id": 13, "kind": "answer", "page_number": null, "file_path": "answers/Mathematical_Methods/…png", "order_index": 0 }
  ],
  "has_answer": true,
  "is_classified": true,
  "needs_review": true,
  "review_note": "Difficulty looks high for a CU - check against the syllabus",
  "tags": ["unique", "Tech active", "circulating"],
  "school": "Made Up School 1",
  "subject": "Mathematical Methods",
  "exam_type": "mock"
}
```

| Field | Notes |
|---|---|
| `question_number` | Normalised to always start with `Q` (`4b`, `q4b`, `Q4b` → `Q4b`). May be `null`. |
| `unit` | `1`-`4` or `null`. Lives on the question, not the paper. |
| `topic`, `subtopic` | The **first** topic and subtopic, as plain strings (`""` / `null` when there is none). Kept so older clients keep working. |
| `topics`, `subtopics` | The full lists. See [Topics and subtopics](#topics-and-subtopics). |
| `difficulty` | `SF`, `CF` or `CU` (Simple Familiar, Complex Familiar, Complex Unfamiliar), stored upper-case. `""` until classified. |
| `is_classified` | `true` once the question has both a topic and a difficulty. Questions where this is `false` make up the Classify queue. |
| `needs_review`, `review_note` | See [Flagging for review](#flagging-for-review). |
| `page_number` | Page the question *starts* on. `null` for screenshots. |
| `question_images` / `answer_images` | Ordered parts (`order_index`), so multi-page questions and solutions are just several entries. |
| `school`, `subject`, `exam_type` | Denormalised from the parent paper for convenience. |

## Topics and subtopics

A question can have **several** topics and several subtopics, like tags.

- **Reading:** `topics` and `subtopics` are arrays. `topic` and `subtopic` hold the first entry of each (or `""` / `null`).
- **Writing:** send `topics` and/or `subtopics` as arrays. The older single-value form (`topic: "Integrals"`, `subtopic: "Areas"`) still works and means exactly one entry.
- **Never split on commas.** The server treats each string as one name, because real topic names can contain commas ("Thermal, nuclear and electrical physics"). Splitting typed text on commas is the UI's job.
- **Cleaning:** names are trimmed, blanks and non-strings are dropped, duplicates are removed ignoring case (the first spelling wins), and order is kept. The first entry is the primary one.
- **On `PATCH`:** sending a list **replaces** it; leaving it out leaves it untouched; `[]` clears it.
- **Filtering:** a question matches a `topic` or `subtopic` filter if **any** of its entries match.

## Flagging for review

A question can be flagged when its classification looks wrong; flagged questions appear in the Classify tab's **Reclassify** queue.

| Field | Meaning |
|---|---|
| `needs_review` | `true` while flagged. Send `true` / `false` on `PATCH`. |
| `review_note` | Optional reason, kept **only while flagged**. Unflagging clears it, and a note sent for an unflagged question is discarded. |

Ordinary edits never change the flag.

## Papers

### `GET /api/papers`

All papers, newest first, each including `question_count`. This includes the hidden Screenshots papers (`is_collection: true`); the UI filters those out of its lists.

### `POST /api/papers`

Create a paper. `multipart/form-data`:

| Field | Required | Notes |
|---|:---:|---|
| `school` | yes | |
| `subject` | yes | Also used (sanitised) as the storage sub-folder. |
| `year_level` | yes | Integer, e.g. `11` or `12`. |
| `exam_type` | yes | e.g. `internal`, `mock`, `QCAA`. |
| `exam_year` | no | Integer. |
| `file` | yes | The paper. |
| `solution_file` | no | A worked-solutions file. If its type isn't allowed it is silently ignored. |

Returns `201` with the new [Paper](#paper).

```bash
curl -X POST http://localhost:5000/api/papers \
  -F school="Made Up School 1" -F subject="Physics" \
  -F year_level=12 -F exam_type=mock -F exam_year=2025 \
  -F file=@paper.pdf -F solution_file=@solutions.pdf
```

### `POST /api/papers/quick`

Creates a paper from a single file with placeholder details (`school="Uncategorized"`, `exam_type="misc"`, `year_level=12`), skipping the usual metadata. Fields: `subject` and `file` (both required). The web UI uses this for a lone **PDF** in Quick Add; for images, prefer [`/api/screenshots`](#screenshots), which doesn't create a paper per file.

### `POST /api/papers/collection`

Returns the subject's hidden Screenshots paper, creating it if it doesn't exist. JSON: `{ "subject": "Physics" }`. Returns `201` when created, `200` when it already existed, and `400` without a subject. The UI calls this when trimming freshly picked screenshots, so the crops you save have a paper to belong to.

### `PATCH /api/papers/<id>`

Partial update of paper metadata. JSON, any of `school`, `subject`, `year_level`, `exam_type`, `exam_year` (send `null` or `""` to clear the year). Empty values for the other fields are ignored. Returns the updated paper. The uploaded file and existing questions are untouched.

### `DELETE /api/papers/<id>`

Deletes the paper and, by cascade, all of its questions and their rows. Uploaded files remain on disk.

## Screenshots

### `POST /api/screenshots`

Bulk quick-add. Each PNG/JPG becomes an **unclassified question** (so it lands in the [Classify queue](#classify-queue)), with no paper created per screenshot and no chopping. All of a subject's screenshots share its hidden collection paper.

`multipart/form-data`: `subject` (required) and one or more `file` parts.

```bash
curl -X POST http://localhost:5000/api/screenshots \
  -F subject=Physics -F file=@snip1.png -F file=@snip2.jpg
```

Returns `201`:

```json
{
  "paper":   { "id": 5, "subject": "Physics", "is_collection": true, "…": "…" },
  "created": [ { "id": 21, "is_classified": false, "…": "…" } ],
  "skipped": [ { "filename": "notes.txt", "error": "only PNG or JPG images can be added this way" } ]
}
```

Files that aren't PNG or JPG are skipped and reported rather than failing the request. If **nothing** is usable the response is `400` with a `skipped` list, and no collection paper is left behind. A missing or blank `subject`, or no files at all, is also `400`.

## Questions

### `GET /api/questions`

List questions, newest first, optionally filtered. All filters are optional query parameters and combine with **AND**; repeatable ones combine their own values with **OR** (or **AND** for `tag`).

| Parameter | Matches |
|---|---|
| `subject` | Paper's subject (exact) |
| `school` | Paper's school (exact) |
| `exam_type` | Paper's exam type (exact) |
| `year_level` | Paper's year level |
| `paper_id` | Questions from one paper |
| `unit` | **Repeatable.** Any of the listed units (`1`-`4`) |
| `topic` | **Repeatable.** Has *any* of the listed topics |
| `subtopic` | **Repeatable.** Has *any* of the listed subtopics |
| `difficulty` | **Repeatable.** `SF` / `CF` / `CU`, case-insensitive |
| `tag` | **Repeatable.** Must have *every* listed tag |
| `exclude_tag` | **Repeatable.** Dropped if it has *any* listed tag |
| `unclassified` | Any value: only questions missing a topic or difficulty |
| `needs_review` | Any value: only questions flagged for review |
| `page` | Page number, default `1` |
| `per_page` | Page size, default `60`, capped at `500` |

```bash
# Complex Familiar Methods questions that appeared on a mock, excluding circulating ones
curl -G http://localhost:5000/api/questions \
  --data-urlencode "subject=Mathematical Methods" \
  --data-urlencode "difficulty=CF" \
  --data-urlencode "tag=appeared on mock" \
  --data-urlencode "exclude_tag=circulating"
```

Returns a page, not a bare array:

```json
{
  "questions": [ { "id": 4, "…": "…" } ],
  "total": 1,
  "page": 1,
  "per_page": 60,
  "has_more": false
}
```

`total` is the number of matches across all pages; `has_more` says whether another page follows.

### `POST /api/questions`

Create a fully classified question (attach images afterwards with [`/crop`](#post-apiquestionsidcrop)). JSON:

| Field | Required | Notes |
|---|:---:|---|
| `paper_id` | yes | Must exist, otherwise `404 {"error": "paper not found"}`. |
| `topics` (or `topic`) | yes | At least one name. See [Topics and subtopics](#topics-and-subtopics). |
| `difficulty` | yes | `SF`, `CF` or `CU`, otherwise `400`. |
| `unit` | no | `1`-`4`, otherwise `400`. |
| `question_number` | no | Normalised as described above. |
| `subtopics` (or `subtopic`) | no | |
| `page_number` | no | |
| `notes` | no | |
| `tags` | no | Array of strings. Unknown tags are created automatically. |

Returns `201` with the new [Question](#question).

```bash
curl -X POST http://localhost:5000/api/questions -H "Content-Type: application/json" \
  -d '{"paper_id": 1, "question_number": "4b", "unit": 3,
       "topics": ["Integrals", "Discrete random variables"], "subtopics": ["Areas"],
       "difficulty": "CF", "tags": ["unique"]}'
```

### `POST /api/questions/quick`

Creates an **unclassified** question (empty topic and difficulty) for the "chop everything now, classify later" workflow. JSON: `{ "paper_id": 1, "page_number": 3 }` (`page_number` optional). Attach its image with [`/crop`](#post-apiquestionsidcrop); it then shows up in the Classify queue until it's given a topic and difficulty with `PATCH`.

### `GET /api/questions/<id>`

One question.

### `PATCH /api/questions/<id>`

Partial update: send only what changes. Accepts `topics` / `subtopics` (or the single-value `topic` / `subtopic`), `difficulty`, `unit`, `question_number`, `page_number`, `notes`, `tags`, `needs_review` and `review_note`. Sending `tags` **replaces** the whole tag list, and topic lists behave as described in [Topics and subtopics](#topics-and-subtopics). Validation for `difficulty` and `unit` is the same as on create. Returns the updated question.

```bash
# Give a second topic and clear the flag in one request
curl -X PATCH http://localhost:5000/api/questions/7 -H "Content-Type: application/json" \
  -d '{"topics": ["Integrals", "Logarithmic functions"], "needs_review": false}'
```

### `DELETE /api/questions/<id>`

Deletes the question and its rows (files stay on disk).

## Classify queue

### `GET /api/classify-counts`

The two numbers on the Classify tab's badges, in one round trip:

```json
{ "needs_review": 2, "unclassified": 4 }
```

They're computed with the same filters as `/api/questions?needs_review=1` and `?unclassified=1`, so they always agree with what those queues contain.

To fetch the queues themselves, use those two filters on `GET /api/questions`.

## Question parts (crops and answers)

A question or its worked solution can consist of several images. Each upload **appends** one more part, in order.

### `POST /api/questions/<id>/crop`

Add one more region/page to the question itself. `multipart/form-data`: `image` (required) and `page_number` (optional integer). Returns the updated [Question](#question). Call it again for a question that continues elsewhere.

### `POST /api/questions/<id>/answer`

Add one more page to the question's worked solution. `multipart/form-data`: `file` (required; image, PDF or Word) and `page_number` (optional). Returns the updated question. Used both by the Chop tab's *Chop Answers* mode and by manual uploads in the viewer.

### `DELETE /api/questions/<id>/answer`

Remove **all** solution parts for the question (files are deleted from disk). Returns the updated question.

### `DELETE /api/questions/<id>/images/<image_id>`

Remove one specific part (a question crop or a single solution page), deleting its file. Returns the updated question. Use this when only one page of a multi-page solution needs redoing.

## Lookups

These power the UI's suggestion chips and cascading filters.

| Endpoint | Returns |
|---|---|
| `GET /api/tags` | All tag names, alphabetical. |
| `GET /api/subjects` | Distinct paper subjects, alphabetical. |
| `GET /api/schools` | Distinct paper schools, alphabetical. |
| `GET /api/topics?subject=&unit=` | Distinct topics, scoped to a subject and/or unit(s). `unit` is repeatable. |
| `GET /api/subtopics?subject=&unit=&topic=` | Distinct subtopics, scoped to subject, unit(s) and/or topic(s). `unit` and `topic` are repeatable. |

`topics` and `subtopics` include every entry of every matching question, not only the first. All return a JSON array of strings.

## Operations

### `GET /api/status`

```json
{ "status": "ok", "message": "TutorDB is running", "paper_count": 5, "question_count": 17 }
```

Handy as a health check. `paper_count` counts every paper, including the hidden Screenshots papers.

### `GET /api/backup`

Streams `tutordb-backup-<UTC timestamp>.zip` containing `questions.db` (an online-backup snapshot, safe to take while the app is being written to) and `files/...`. Restore by extracting into `data/`. Old backup temp files (older than 10 minutes) are swept on the next request.

### `GET /files/<path>`

Serves an uploaded file by the relative `file_path` stored in the database.

## End-to-end example

Create a paper, classify a question on it, attach its cropped image, then flag it and query it back:

```bash
# 1. Create a paper (returns JSON including "id")
curl -X POST http://localhost:5000/api/papers \
  -F school="Made Up School 1" -F subject="Physics" -F year_level=12 \
  -F exam_type=internal -F file=@paper.pdf

# 2. Create a question on paper 1 with two topics
curl -X POST http://localhost:5000/api/questions -H "Content-Type: application/json" \
  -d '{"paper_id": 1, "question_number": "3a", "unit": 2,
       "topics": ["Linear motion and waves", "Gravity and electromagnetism"],
       "subtopics": ["Kinematics"], "difficulty": "SF", "tags": ["unique"]}'

# 3. Attach the cropped image (question 1 = the id returned above)
curl -X POST http://localhost:5000/api/questions/1/crop -F image=@q3a.png -F page_number=2

# 4. Flag it for review with a note
curl -X PATCH http://localhost:5000/api/questions/1 -H "Content-Type: application/json" \
  -d '{"needs_review": true, "review_note": "check the difficulty"}'

# 5. Query it back, by either topic
curl -G http://localhost:5000/api/questions \
  --data-urlencode "subject=Physics" --data-urlencode "topic=Gravity and electromagnetism"
```
