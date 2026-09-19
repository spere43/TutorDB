# TutorDB API reference

The web UI is a client of this JSON API, so everything the UI does can be scripted. All examples assume the app is running at `http://localhost:5000`.

- [Conventions](#conventions)
- [Objects](#objects)
- [Papers](#papers)
- [Questions](#questions)
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
- **Allowed upload types:** `pdf`, `doc`, `docx`, `png`, `jpg`, `jpeg`. Anything else returns `400 file type not allowed`.

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
  "solution_file_path": "Mathematical_Methods/9c1b…_demo_solutions.pdf"
}
```

`file_path` and `solution_file_path` are relative to `data/files/`; fetch them at `/files/<file_path>`. `exam_year` and `solution_file_path` may be `null`.

### Question

```json
{
  "id": 4,
  "paper_id": 1,
  "question_number": "Q4",
  "unit": 3,
  "topic": "Further differentiation and applications",
  "subtopic": "Optimisation",
  "difficulty": "CF",
  "page_number": 1,
  "notes": null,
  "question_images": [
    { "id": 4, "kind": "question", "page_number": 1, "file_path": "crops/Mathematical_Methods/…png", "order_index": 0 }
  ],
  "answer_images": [
    { "id": 17, "kind": "answer", "page_number": null, "file_path": "answers/Mathematical_Methods/…png", "order_index": 0 }
  ],
  "has_answer": true,
  "tags": ["appeared on mock", "tech active"],
  "school": "Made Up School 1",
  "subject": "Mathematical Methods",
  "exam_type": "mock"
}
```

| Field | Notes |
|---|---|
| `question_number` | Normalised to always start with `Q` (`4b`, `q4b`, `Q4b` → `Q4b`). May be `null`. |
| `unit` | `1`-`4` or `null`. Lives on the question, not the paper. |
| `difficulty` | `SF`, `CF` or `CU` (Simple Familiar, Complex Familiar, Complex Unfamiliar). Stored upper-case. |
| `page_number` | Page the question *starts* on. |
| `question_images` / `answer_images` | Ordered parts (`order_index`), so multi-page questions and solutions are just several entries. |
| `school`, `subject`, `exam_type` | Denormalised from the parent paper for convenience. |

## Papers

### `GET /api/papers`

All papers, newest first. Returns an array of [Paper](#paper) objects.

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

Fast path for a one-off question that isn't from a tracked paper. Fields: `subject` and `file` (both required). The paper is stored with placeholder values (`school="Uncategorized"`, `exam_type="misc"`, `year_level=12`) that you can correct later with `PATCH`.

### `PATCH /api/papers/<id>`

Partial update of paper metadata. JSON, any of `school`, `subject`, `year_level`, `exam_type`, `exam_year` (send `null` or `""` to clear the year). Empty values for the other fields are ignored. Returns the updated paper. The uploaded file and existing questions are untouched.

### `DELETE /api/papers/<id>`

Deletes the paper and, by cascade, all of its questions and their image rows. Uploaded files remain on disk.

## Questions

### `GET /api/questions`

List questions, optionally filtered. All filters are optional query parameters and combine with **AND**:

| Parameter | Matches |
|---|---|
| `subject` | Paper's subject (exact) |
| `school` | Paper's school (exact) |
| `exam_type` | Paper's exam type (exact) |
| `year_level` | Paper's year level |
| `paper_id` | Questions from one paper |
| `unit` | `1`-`4` |
| `topic` | Topic (exact) |
| `subtopic` | Subtopic (exact) |
| `difficulty` | `SF` / `CF` / `CU` (case-insensitive) |
| `tag` | **Repeatable.** The question must have *every* listed tag. |
| `exclude_tag` | **Repeatable.** The question is dropped if it has *any* listed tag. |

```bash
# Complex Familiar Methods questions that appeared on a mock, excluding circulating ones
curl -G http://localhost:5000/api/questions \
  --data-urlencode "subject=Mathematical Methods" \
  --data-urlencode "difficulty=CF" \
  --data-urlencode "tag=appeared on mock" \
  --data-urlencode "exclude_tag=circulating"
```

Returns an array of [Question](#question) objects. There is currently no pagination.

### `POST /api/questions`

Create a question's metadata (attach images afterwards with [`/crop`](#post-apiquestionsidcrop)). JSON:

| Field | Required | Notes |
|---|:---:|---|
| `paper_id` | yes | Must exist, otherwise `404 {"error": "paper not found"}`. |
| `topic` | yes | |
| `difficulty` | yes | `SF`, `CF` or `CU`, otherwise `400`. |
| `unit` | no | `1`-`4`, otherwise `400`. |
| `question_number` | no | Normalised as described above. |
| `subtopic` | no | |
| `page_number` | no | |
| `notes` | no | |
| `tags` | no | Array of strings. Unknown tags are created automatically. |

Returns `201` with the new [Question](#question).

### `GET /api/questions/<id>`

One question.

### `PATCH /api/questions/<id>`

Partial update: send only what changes. Accepts `topic`, `subtopic`, `notes`, `page_number`, `question_number`, `difficulty`, `unit` and `tags`. Sending `tags` **replaces** the whole tag list. Validation for `difficulty` and `unit` is the same as on create. Returns the updated question.

### `DELETE /api/questions/<id>`

Deletes the question and its image rows (files stay on disk).

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

These power the UI's autocomplete and cascading dropdowns.

| Endpoint | Returns |
|---|---|
| `GET /api/tags` | All tag names, alphabetical. |
| `GET /api/subjects` | Distinct paper subjects, alphabetical. |
| `GET /api/schools` | Distinct paper schools, alphabetical. |
| `GET /api/topics?subject=&unit=` | Distinct topics, scoped to a subject and/or unit. |
| `GET /api/subtopics?subject=&unit=&topic=` | Distinct non-null subtopics, scoped to subject, unit and/or topic. |

All return a JSON array of strings.

## Operations

### `GET /api/status`

```json
{ "status": "ok", "message": "TutorDB is running", "paper_count": 3, "question_count": 13 }
```

Handy as a health check.

### `GET /api/backup`

Streams `tutordb-backup-<UTC timestamp>.zip` containing `questions.db` (an online-backup snapshot, safe to take while the app is being written to) and `files/...`. Restore by extracting into `data/`. Old backup temp files (older than 10 minutes) are swept on the next request.

### `GET /files/<path>`

Serves an uploaded file by the relative `file_path` stored in the database.

## End-to-end example

Create a paper, add a question to it and attach a cropped image:

```bash
# 1. Create a paper (returns JSON including "id")
curl -X POST http://localhost:5000/api/papers \
  -F school="Made Up School 1" -F subject="Physics" -F year_level=12 \
  -F exam_type=internal -F file=@paper.pdf

# 2. Create a question on paper 1
curl -X POST http://localhost:5000/api/questions \
  -H "Content-Type: application/json" \
  -d '{"paper_id": 1, "question_number": "3a", "unit": 2, "topic": "Linear motion and waves",
       "subtopic": "Kinematics", "difficulty": "SF", "tags": ["unique"]}'

# 3. Attach the cropped image (question 1 = the id returned above)
curl -X POST http://localhost:5000/api/questions/1/crop -F image=@q3a.png -F page_number=2

# 4. Query it back
curl "http://localhost:5000/api/questions?subject=Physics&tag=unique"
```
