import * as pdfjsLib from "/static/vendor/pdfjs/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "/static/vendor/pdfjs/pdf.worker.min.mjs";

// ---------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");

    if (btn.dataset.tab === "browse") refreshBrowse();
    if (btn.dataset.tab === "add") refreshPapersList();
    if (btn.dataset.tab === "chop") refreshChopPicker();
  });
});

// ---------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------
async function fetchJSON(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

function populateDatalist(id, values) {
  const el = document.getElementById(id);
  el.innerHTML = values.map(v => `<option value="${escapeHtml(v)}">`).join("");
}

function populateSelect(id, values, placeholder) {
  const el = document.getElementById(id);
  const current = el.value;
  el.innerHTML = `<option value="">${placeholder}</option>` +
    values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
  el.value = current;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

async function loadDropdownData() {
  const [subjects, schools, topics] = await Promise.all([
    fetchJSON("/api/subjects"),
    fetchJSON("/api/schools"),
    fetchJSON("/api/topics"),
  ]);
  populateDatalist("subject-list", subjects);
  populateDatalist("school-list", schools);
  populateDatalist("topic-list", topics);
  populateSelect("f-subject", subjects, "Subject: any");
  populateSelect("f-school", schools, "School: any");
  populateSelect("f-topic", topics, "Topic: any");
}

// ---------------------------------------------------------------
// ADD PAPER
// ---------------------------------------------------------------
document.getElementById("add-paper-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("add-paper-status");
  statusEl.textContent = "Uploading...";
  statusEl.className = "status-msg";

  const formData = new FormData();
  formData.append("school", document.getElementById("p-school").value);
  formData.append("subject", document.getElementById("p-subject").value);
  formData.append("year_level", document.getElementById("p-year-level").value);
  formData.append("exam_type", document.getElementById("p-exam-type").value);
  const examYear = document.getElementById("p-exam-year").value;
  if (examYear) formData.append("exam_year", examYear);
  formData.append("file", document.getElementById("p-file").files[0]);
  const solFile = document.getElementById("p-solution-file").files[0];
  if (solFile) formData.append("solution_file", solFile);

  try {
    await fetchJSON("/api/papers", { method: "POST", body: formData });
    statusEl.textContent = "Paper added.";
    statusEl.className = "status-msg ok";
    document.getElementById("add-paper-form").reset();
    loadDropdownData();
    refreshPapersList();
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
    statusEl.className = "status-msg err";
  }
});

async function refreshPapersList() {
  const papers = await fetchJSON("/api/papers");
  const el = document.getElementById("papers-list");
  if (papers.length === 0) {
    el.innerHTML = `<p class="muted">No papers added yet.</p>`;
    return;
  }
  el.innerHTML = papers.map(p => `
    <div class="paper-row">
      <div class="paper-info">
        <b>${escapeHtml(p.school)}</b> — ${escapeHtml(p.subject)} (Y${p.year_level}, ${escapeHtml(p.exam_type)}${p.exam_year ? ", " + p.exam_year : ""})
        <br><span><a href="/files/${p.file_path}" target="_blank">view original</a>${p.solution_file_path ? ` | <a href="/files/${p.solution_file_path}" target="_blank">view solutions</a>` : ""}</span>
      </div>
      <button class="secondary" onclick="deletePaper(${p.id})">Delete</button>
    </div>
  `).join("");
}

async function deletePaper(id) {
  if (!confirm("Delete this paper and all its chopped questions?")) return;
  await fetchJSON(`/api/papers/${id}`, { method: "DELETE" });
  refreshPapersList();
}

// ---------------------------------------------------------------
// CHOP TAB
// ---------------------------------------------------------------
async function refreshChopPicker() {
  document.getElementById("chop-workspace").style.display = "none";
  document.getElementById("chop-picker").style.display = "block";
  const papers = await fetchJSON("/api/papers");
  papersCache = papers;
  const el = document.getElementById("chop-papers-list");
  if (papers.length === 0) {
    el.innerHTML = `<p class="muted">No papers yet — add one in the Add Paper tab first.</p>`;
    return;
  }
  el.innerHTML = papers.map(p => `
    <div class="paper-row">
      <div class="paper-info">
        <b>${escapeHtml(p.school)}</b> — ${escapeHtml(p.subject)} (Y${p.year_level}, ${escapeHtml(p.exam_type)}${p.exam_year ? ", " + p.exam_year : ""})
        ${p.solution_file_path ? `<br><span class="muted">Has a solutions file</span>` : ""}
      </div>
      <button onclick="openChopById(${p.id})">Chop this paper</button>
    </div>
  `).join("");
}

document.getElementById("chop-back").addEventListener("click", refreshChopPicker);

let papersCache = [];
let pdfDoc = null;
let currentPage = 1;
let currentPaperId = null;
let currentPaper = null;
let selectedDifficulty = null;
let pendingCropBlob = null;
let pendingCropPage = null;
let chopMode = "questions"; // "questions" | "answers"

// A question (or its answer) can span multiple pages/regions. Each drawn
// box is staged here -- {blob, page} -- until "Save question"/"Save
// answer" uploads them all in order. This is what makes multi-page
// questions just "draw several boxes before saving" instead of a
// separate flow.
let stagedQuestionParts = [];
let stagedAnswerParts = [];

// `scale` is an ABSOLUTE PDF.js scale: 1.0 always means "1 PDF point = 1 CSS
// pixel" (the PDF's real, native size), the same on every device. That's
// what makes the zoom % label mean something consistent everywhere --
// unlike a scale that's defined relative to the container's current width,
// which shifts every time the container resizes (as it constantly does in
// iOS Safari: address-bar collapse, rotation, etc).
let scale = 1;
const MIN_SCALE = 0.3;
const MAX_SCALE = 4;
const ZOOM_STEP_FACTOR = 1.15;

async function openChopById(paperId) {
  const paper = papersCache.find(p => p.id === paperId);
  if (!paper) return;
  await openChop(paper);
}

async function openChop(paper) {
  currentPaper = paper;
  currentPaperId = paper.id;
  chopMode = "questions";

  document.getElementById("chop-picker").style.display = "none";
  document.getElementById("chop-workspace").style.display = "block";
  document.getElementById("chop-paper-title").textContent = `${paper.school} — ${paper.subject}`;

  const modeSwitch = document.getElementById("chop-mode-switch");
  document.querySelectorAll(".mode-btn").forEach(b => b.classList.remove("active"));
  document.querySelector('.mode-btn[data-mode="questions"]').classList.add("active");
  modeSwitch.style.display = paper.solution_file_path ? "flex" : "none";
  showChopFormForMode();

  await loadPdfForMode();
  resetQuestionForm();
  resetAnswerForm();
}

// Loads either the paper's original file or its solutions file into
// pdf.js, depending on which mode we're chopping in.
async function loadPdfForMode() {
  const path = chopMode === "answers" ? currentPaper.solution_file_path : currentPaper.file_path;
  const loadingTask = pdfjsLib.getDocument(`/files/${path}`);
  pdfDoc = await loadingTask.promise;
  currentPage = 1;
  await fitToWidth();
  await renderPage(currentPage);
}

function showChopFormForMode() {
  document.getElementById("chop-form-questions").style.display = chopMode === "questions" ? "block" : "none";
  document.getElementById("chop-form-answers").style.display = chopMode === "answers" ? "block" : "none";
}

document.querySelectorAll(".mode-btn").forEach(btn => {
  btn.addEventListener("click", async () => {
    if (!currentPaper) return;
    chopMode = btn.dataset.mode;
    document.querySelectorAll(".mode-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    showChopFormForMode();
    clearOverlay();
    resetQuestionForm();
    resetAnswerForm();
    if (chopMode === "answers") await populateAnswerQuestionSelect();
    await loadPdfForMode();
  });
});

async function populateAnswerQuestionSelect() {
  const select = document.getElementById("answer-q-select");
  const questions = await fetchJSON(`/api/questions?paper_id=${currentPaper.id}`);
  if (questions.length === 0) {
    select.innerHTML = `<option value="">No questions chopped yet for this paper</option>`;
    return;
  }
  select.innerHTML = questions.map(q => `
    <option value="${q.id}">
      ${q.question_number ? "Q" + escapeHtml(q.question_number) + " — " : ""}${escapeHtml(q.topic)} (${q.difficulty})${q.has_answer ? " [already has an answer]" : ""}
    </option>
  `).join("");
}

// Sets `scale` to whatever absolute value makes the page fill the
// container's current width. Used for the initial view and the Fit button
// only -- it does NOT define what "100%" means (that's always native size).
async function fitToWidth() {
  const page = await pdfDoc.getPage(currentPage);
  const unscaledViewport = page.getViewport({ scale: 1 });
  const wrap = document.getElementById("pdf-canvas-wrap");
  const available = Math.max(200, wrap.clientWidth - 4);
  scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, available / unscaledViewport.width));
}

async function renderPage(num) {
  const page = await pdfDoc.getPage(num);
  const viewport = page.getViewport({ scale });

  // Render at the device's actual pixel density so it's crisp on
  // Retina-style screens (iPad/iPhone), while keeping the on-screen
  // (CSS) size tied to `scale` so touch/mouse drawing stays accurate.
  const dpr = window.devicePixelRatio || 1;

  const pdfCanvas = document.getElementById("pdf-canvas");
  const overlayCanvas = document.getElementById("overlay-canvas");

  pdfCanvas.width = Math.round(viewport.width * dpr);
  pdfCanvas.height = Math.round(viewport.height * dpr);
  pdfCanvas.style.width = `${viewport.width}px`;
  pdfCanvas.style.height = `${viewport.height}px`;

  overlayCanvas.width = pdfCanvas.width;
  overlayCanvas.height = pdfCanvas.height;
  overlayCanvas.style.width = `${viewport.width}px`;
  overlayCanvas.style.height = `${viewport.height}px`;

  const ctx = pdfCanvas.getContext("2d");
  const renderContext = { canvasContext: ctx, viewport };
  if (dpr !== 1) renderContext.transform = [dpr, 0, 0, dpr, 0, 0];
  await page.render(renderContext).promise;

  document.getElementById("page-indicator").textContent = `Page ${num} / ${pdfDoc.numPages}`;
  document.getElementById("zoom-indicator").textContent = `${Math.round(scale * 100)}%`;
  clearOverlay();
}

document.getElementById("prev-page").addEventListener("click", async () => {
  if (currentPage > 1) {
    currentPage--;
    await renderPage(currentPage); // keep the same absolute zoom across pages
  }
});
document.getElementById("next-page").addEventListener("click", async () => {
  if (pdfDoc && currentPage < pdfDoc.numPages) {
    currentPage++;
    await renderPage(currentPage);
  }
});

document.getElementById("zoom-in").addEventListener("click", async () => {
  if (!pdfDoc) return;
  scale = Math.min(MAX_SCALE, +(scale * ZOOM_STEP_FACTOR).toFixed(3));
  await renderPage(currentPage);
});
document.getElementById("zoom-out").addEventListener("click", async () => {
  if (!pdfDoc) return;
  scale = Math.max(MIN_SCALE, +(scale / ZOOM_STEP_FACTOR).toFixed(3));
  await renderPage(currentPage);
});
document.getElementById("zoom-fit").addEventListener("click", async () => {
  if (!pdfDoc) return;
  await fitToWidth();
  await renderPage(currentPage);
});

// Note: we deliberately do NOT auto-refit on window "resize". iOS Safari
// fires resize events constantly during ordinary scrolling (its address
// bar collapses/expands), which was silently nudging the zoom % by a few
// points every time you scrolled. Refitting only happens when you open a
// paper or explicitly tap "Fit" -- after rotating the device, just tap
// Fit again if the page no longer looks right.

// ---- Box drawing on overlay canvas (mouse + touch) ----
const overlay = document.getElementById("overlay-canvas");
let drawing = false;
let startX = 0, startY = 0;

function clearOverlay() {
  const ctx = overlay.getContext("2d");
  ctx.clearRect(0, 0, overlay.width, overlay.height);
}

function getPos(evt) {
  const rect = overlay.getBoundingClientRect();
  // On touchend/touchcancel, evt.touches is already empty (the finger has
  // lifted) -- the touch that just ended lives in evt.changedTouches
  // instead. Using evt.touches here made endDraw() read undefined
  // coordinates on every touch device, silently throwing before
  // cropSelection() ever ran -- which is why the box drew fine but no
  // preview ever appeared on iPhone/iPad.
  let clientX, clientY;
  if (evt.changedTouches && evt.changedTouches.length) {
    clientX = evt.changedTouches[0].clientX;
    clientY = evt.changedTouches[0].clientY;
  } else if (evt.touches && evt.touches.length) {
    clientX = evt.touches[0].clientX;
    clientY = evt.touches[0].clientY;
  } else {
    clientX = evt.clientX;
    clientY = evt.clientY;
  }
  return {
    x: (clientX - rect.left) * (overlay.width / rect.width),
    y: (clientY - rect.top) * (overlay.height / rect.height),
  };
}

function startDraw(evt) {
  evt.preventDefault();
  const pos = getPos(evt);
  drawing = true;
  startX = pos.x;
  startY = pos.y;
}

function moveDraw(evt) {
  if (!drawing) return;
  evt.preventDefault();
  const pos = getPos(evt);
  clearOverlay();
  const ctx = overlay.getContext("2d");
  ctx.strokeStyle = "#4f8cff";
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  const w = pos.x - startX;
  const h = pos.y - startY;
  ctx.strokeRect(startX, startY, w, h);
}

function endDraw(evt) {
  if (!drawing) return;
  drawing = false;
  const pos = getPos(evt);
  const x = Math.min(startX, pos.x);
  const y = Math.min(startY, pos.y);
  const w = Math.abs(pos.x - startX);
  const h = Math.abs(pos.y - startY);

  if (w < 10 || h < 10) return; // ignore accidental tiny drags

  cropSelection(x, y, w, h);
}

overlay.addEventListener("mousedown", startDraw);
overlay.addEventListener("mousemove", moveDraw);
overlay.addEventListener("mouseup", endDraw);
overlay.addEventListener("touchstart", startDraw, { passive: false });
overlay.addEventListener("touchmove", moveDraw, { passive: false });
overlay.addEventListener("touchend", endDraw, { passive: false });

function cropSelection(x, y, w, h) {
  const pdfCanvas = document.getElementById("pdf-canvas");
  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = w;
  cropCanvas.height = h;
  const ctx = cropCanvas.getContext("2d");
  ctx.drawImage(pdfCanvas, x, y, w, h, 0, 0, w, h);

  cropCanvas.toBlob(blob => {
    pendingCropBlob = blob;
    pendingCropPage = currentPage;
    const previewUrl = URL.createObjectURL(blob);
    if (chopMode === "answers") {
      document.getElementById("answer-crop-preview").src = previewUrl;
      document.getElementById("answer-crop-preview-wrap").style.display = "block";
      document.getElementById("save-answer").disabled = false;
      document.getElementById("add-answer-part").disabled = false;
    } else {
      document.getElementById("crop-preview").src = previewUrl;
      document.getElementById("crop-preview-wrap").style.display = "block";
      document.getElementById("save-question").disabled = false;
      document.getElementById("add-question-part").disabled = false;
    }
  }, "image/png");
}

// ---- Multi-page staging (question side) ----
function renderStagedParts(listElId, staged) {
  const el = document.getElementById(listElId);
  if (staged.length === 0) {
    el.innerHTML = "";
    el.style.display = "none";
    return;
  }
  el.style.display = "flex";
  el.innerHTML = staged.map((part, i) => `
    <div class="staged-part">
      <img src="${URL.createObjectURL(part.blob)}" alt="part ${i + 1}">
      <span class="staged-part-page">p${part.page}</span>
      <button type="button" class="staged-part-remove" onclick="removeStagedPart('${listElId}', ${i})">&times;</button>
    </div>
  `).join("");
}

function removeStagedPart(listElId, index) {
  const staged = listElId === "question-staged-parts" ? stagedQuestionParts : stagedAnswerParts;
  staged.splice(index, 1);
  renderStagedParts(listElId, staged);
}
window.removeStagedPart = removeStagedPart;

document.getElementById("add-question-part").addEventListener("click", () => {
  if (!pendingCropBlob) return;
  stagedQuestionParts.push({ blob: pendingCropBlob, page: pendingCropPage });
  renderStagedParts("question-staged-parts", stagedQuestionParts);
  pendingCropBlob = null;
  pendingCropPage = null;
  document.getElementById("crop-preview-wrap").style.display = "none";
  document.getElementById("save-question").disabled = stagedQuestionParts.length === 0;
  document.getElementById("add-question-part").disabled = true;
  clearOverlay();
});

document.getElementById("add-answer-part").addEventListener("click", () => {
  if (!pendingCropBlob) return;
  stagedAnswerParts.push({ blob: pendingCropBlob, page: pendingCropPage });
  renderStagedParts("answer-staged-parts", stagedAnswerParts);
  pendingCropBlob = null;
  pendingCropPage = null;
  document.getElementById("answer-crop-preview-wrap").style.display = "none";
  document.getElementById("save-answer").disabled = stagedAnswerParts.length === 0;
  document.getElementById("add-answer-part").disabled = true;
  clearOverlay();
});

// ---- Difficulty buttons ----
document.querySelectorAll(".diff-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".diff-btn").forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");
    selectedDifficulty = btn.dataset.diff;
  });
});

function resetQuestionForm() {
  document.getElementById("q-number").value = "";
  document.getElementById("q-topic").value = "";
  document.getElementById("q-subtopic").value = "";
  document.getElementById("q-tags").value = "";
  document.getElementById("q-notes").value = "";
  document.querySelectorAll(".diff-btn").forEach(b => b.classList.remove("selected"));
  selectedDifficulty = null;
  pendingCropBlob = null;
  pendingCropPage = null;
  stagedQuestionParts = [];
  renderStagedParts("question-staged-parts", stagedQuestionParts);
  document.getElementById("crop-preview-wrap").style.display = "none";
  document.getElementById("save-question").disabled = true;
  document.getElementById("add-question-part").disabled = true;
  document.getElementById("chop-status").textContent = "";
}

function resetAnswerForm() {
  pendingCropBlob = null;
  pendingCropPage = null;
  stagedAnswerParts = [];
  renderStagedParts("answer-staged-parts", stagedAnswerParts);
  document.getElementById("answer-crop-preview-wrap").style.display = "none";
  document.getElementById("save-answer").disabled = true;
  document.getElementById("add-answer-part").disabled = true;
  document.getElementById("answer-chop-status").textContent = "";
}

// Uploads each staged/pending part for a freshly-created question or an
// existing one, in order, so a multi-page question ends up with its
// parts in the order they were drawn.
async function uploadParts(questionId, endpoint, fileField, parts) {
  for (const part of parts) {
    const form = new FormData();
    form.append(fileField, part.blob, "part.png");
    if (part.page != null) form.append("page_number", part.page);
    await fetchJSON(`/api/questions/${questionId}${endpoint}`, { method: "POST", body: form });
  }
}

document.getElementById("save-question").addEventListener("click", async () => {
  const statusEl = document.getElementById("chop-status");
  const topic = document.getElementById("q-topic").value.trim();

  const parts = [...stagedQuestionParts];
  if (pendingCropBlob) parts.push({ blob: pendingCropBlob, page: pendingCropPage });

  if (!topic) {
    statusEl.textContent = "Topic is required.";
    statusEl.className = "status-msg err";
    return;
  }
  if (!selectedDifficulty) {
    statusEl.textContent = "Pick a difficulty (SF/CF/CU).";
    statusEl.className = "status-msg err";
    return;
  }
  if (parts.length === 0) {
    statusEl.textContent = "Draw a box around the question first (draw more than one if it spans several pages).";
    statusEl.className = "status-msg err";
    return;
  }

  statusEl.textContent = "Saving...";
  statusEl.className = "status-msg";

  const tags = document.getElementById("q-tags").value
    .split(",").map(t => t.trim()).filter(Boolean);

  try {
    const question = await fetchJSON("/api/questions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paper_id: currentPaperId,
        question_number: document.getElementById("q-number").value.trim() || null,
        topic,
        subtopic: document.getElementById("q-subtopic").value.trim() || null,
        difficulty: selectedDifficulty,
        page_number: parts[0].page,
        notes: document.getElementById("q-notes").value.trim() || null,
        tags,
      }),
    });

    await uploadParts(question.id, "/crop", "image", parts);

    statusEl.textContent = parts.length > 1
      ? `Question saved with ${parts.length} pages. Draw the next one.`
      : "Question saved. Draw the next one.";
    statusEl.className = "status-msg ok";
    clearOverlay();
    resetQuestionForm();
    loadDropdownData();
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
    statusEl.className = "status-msg err";
  }
});

document.getElementById("save-answer").addEventListener("click", async () => {
  const statusEl = document.getElementById("answer-chop-status");
  const questionId = document.getElementById("answer-q-select").value;

  const parts = [...stagedAnswerParts];
  if (pendingCropBlob) parts.push({ blob: pendingCropBlob, page: pendingCropPage });

  if (!questionId) {
    statusEl.textContent = "Pick which question this answers.";
    statusEl.className = "status-msg err";
    return;
  }
  if (parts.length === 0) {
    statusEl.textContent = "Draw a box around the worked solution first (draw more than one if it spans several pages).";
    statusEl.className = "status-msg err";
    return;
  }

  statusEl.textContent = "Saving...";
  statusEl.className = "status-msg";

  try {
    await uploadParts(questionId, "/answer", "file", parts);

    statusEl.textContent = parts.length > 1
      ? `Answer linked with ${parts.length} pages. Draw the next one.`
      : "Answer linked. Draw the next one.";
    statusEl.className = "status-msg ok";
    clearOverlay();
    resetAnswerForm();
    await populateAnswerQuestionSelect(); // refresh the "[already has an answer]" labels
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
    statusEl.className = "status-msg err";
  }
});

// ---------------------------------------------------------------
// BROWSE TAB
// ---------------------------------------------------------------
document.getElementById("apply-filters").addEventListener("click", refreshBrowse);
document.getElementById("clear-filters").addEventListener("click", () => {
  ["f-subject", "f-school", "f-topic", "f-difficulty", "f-exam-type"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("f-tags").value = "";
  refreshBrowse();
});

async function refreshBrowse() {
  await loadDropdownData();

  const params = new URLSearchParams();
  const subject = document.getElementById("f-subject").value;
  const school = document.getElementById("f-school").value;
  const topic = document.getElementById("f-topic").value;
  const difficulty = document.getElementById("f-difficulty").value;
  const examType = document.getElementById("f-exam-type").value;
  const tagsRaw = document.getElementById("f-tags").value;

  if (subject) params.append("subject", subject);
  if (school) params.append("school", school);
  if (topic) params.append("topic", topic);
  if (difficulty) params.append("difficulty", difficulty);
  if (examType) params.append("exam_type", examType);
  if (tagsRaw) tagsRaw.split(",").map(t => t.trim()).filter(Boolean).forEach(t => params.append("tag", t));

  const questions = await fetchJSON("/api/questions?" + params.toString());
  browseResultsCache = questions;
  document.getElementById("results-count").textContent = `${questions.length} question(s)`;

  const grid = document.getElementById("results-grid");
  if (questions.length === 0) {
    grid.innerHTML = `<p class="muted">No questions match these filters yet.</p>`;
    return;
  }

  grid.innerHTML = questions.map(renderQuestionCard).join("");
}

let browseResultsCache = [];

function findCachedQuestion(id) {
  return browseResultsCache.find(q => q.id === id);
}

function renderQuestionCard(q) {
  const thumb = q.question_images[0];
  return `
    <div class="q-card" id="q-card-${q.id}">
      ${thumb
        ? `<img src="/files/${thumb.file_path}" alt="Question ${q.question_number || ""}">`
        : `<div class="muted">No crop image (page ${q.page_number || "?"})</div>`
      }
      ${q.question_images.length > 1 ? `<div class="page-count-badge">${q.question_images.length} pages</div>` : ""}
      <div class="meta-row">
        <span>${escapeHtml(q.school)} · ${escapeHtml(q.subject)}</span>
        <span class="diff-tag ${q.difficulty}">${q.difficulty}</span>
      </div>
      <div class="muted">${escapeHtml(q.topic)}${q.subtopic ? " · " + escapeHtml(q.subtopic) : ""}</div>
      <div>${q.tags.map(t => `<span class="tag-pill">${escapeHtml(t)}</span>`).join("")}</div>
      <div class="card-actions">
        <button class="secondary" onclick="openQuestionModal(${q.id})">Details</button>
        <button class="secondary" onclick="deleteQuestion(${q.id})">delete</button>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------
// Full-screen question viewer (opened via "Details")
// ---------------------------------------------------------------
// modalIndex points into browseResultsCache -- the CURRENT filtered
// list -- so prev/next arrows walk through whatever you've filtered to,
// not the whole database.
let modalIndex = -1;

function openQuestionModal(id) {
  const idx = browseResultsCache.findIndex(q => q.id === id);
  if (idx === -1) return;
  modalIndex = idx;
  document.getElementById("question-modal").style.display = "flex";
  document.body.style.overflow = "hidden";
  renderModalQuestion();
}

function closeQuestionModal() {
  document.getElementById("question-modal").style.display = "none";
  document.body.style.overflow = "";
  modalIndex = -1;
}

function modalNav(delta) {
  if (modalIndex === -1) return;
  const next = modalIndex + delta;
  if (next < 0 || next >= browseResultsCache.length) return;
  modalIndex = next;
  renderModalQuestion();
}

function renderModalQuestion() {
  const q = browseResultsCache[modalIndex];
  if (!q) return;

  document.getElementById("modal-position").textContent = `${modalIndex + 1} / ${browseResultsCache.length}`;
  document.getElementById("modal-meta").textContent =
    `${q.school} · ${q.subject}${q.topic ? " · " + q.topic : ""}${q.subtopic ? " · " + q.subtopic : ""}`;
  document.getElementById("modal-prev").disabled = modalIndex === 0;
  document.getElementById("modal-next").disabled = modalIndex === browseResultsCache.length - 1;

  const pages = q.question_images.map(img => `
    <div class="detail-page">
      ${img.page_number ? `<span class="detail-page-label">Page ${img.page_number}</span>` : ""}
      <img class="detail-full-img" src="/files/${img.file_path}" alt="Question ${q.question_number || ""}">
    </div>
  `).join("");

  document.getElementById("modal-body").innerHTML = `
    <div class="modal-question-meta">
      <span class="diff-tag ${q.difficulty}">${q.difficulty}</span>
      ${q.question_number ? `<span class="muted">Question ${escapeHtml(q.question_number)}</span>` : ""}
      ${q.tags.map(t => `<span class="tag-pill">${escapeHtml(t)}</span>`).join("")}
    </div>
    ${pages || `<p class="muted">No crop image (page ${q.page_number || "?"})</p>`}
    ${q.notes ? `<div class="q-notes">${escapeHtml(q.notes)}</div>` : ""}
    <div class="answer-section" id="modal-answer-section"></div>
  `;
  renderAnswerSection();
}

function renderAnswerSection() {
  const q = browseResultsCache[modalIndex];
  const el = document.getElementById("modal-answer-section");
  if (!q || !el) return;

  const uploadPrompt = `
    <label class="answer-upload-label">
      ${q.answer_images.length ? "Add another solution page" : "Attach a worked solution (image, PDF, or Word doc)"}
      <input type="file" multiple accept=".pdf,.doc,.docx,.png,.jpg,.jpeg" onchange="uploadAnswer(${q.id}, this.files)">
    </label>
  `;

  if (q.answer_images.length > 0) {
    const label = `Reveal answer${q.answer_images.length > 1 ? "s" : ""}`;
    const pages = q.answer_images.map(img => {
      const isImage = /\.(png|jpe?g)$/i.test(img.file_path);
      return `
        <div class="detail-page">
          ${img.page_number ? `<span class="detail-page-label">Page ${img.page_number}</span>` : ""}
          ${isImage
            ? `<img class="detail-full-img" src="/files/${img.file_path}" alt="Worked solution">`
            : `<a href="/files/${img.file_path}" target="_blank">Open worked solution file</a>`
          }
          <button type="button" class="secondary small" onclick="removeAnswerImage(${q.id}, ${img.id})">Remove this page</button>
        </div>
      `;
    }).join("");

    el.innerHTML = `
      <button type="button" class="answer-toggle" id="modal-reveal-answer">${label} ▾</button>
      <div class="answer-body" id="modal-answer-body" style="display:none;">
        ${pages}
        ${uploadPrompt}
      </div>
    `;
    document.getElementById("modal-reveal-answer").addEventListener("click", () => {
      const body = document.getElementById("modal-answer-body");
      const btn = document.getElementById("modal-reveal-answer");
      const isOpen = body.style.display !== "none";
      body.style.display = isOpen ? "none" : "block";
      btn.textContent = isOpen ? `${label} ▾` : `Hide answer${q.answer_images.length > 1 ? "s" : ""} ▴`;
    });
  } else {
    el.innerHTML = `
      <p class="hint">No worked solution linked yet.</p>
      ${uploadPrompt}
    `;
  }
}

// Accepts a FileList so a multi-page solution can be attached in one go --
// each file becomes its own page/part, uploaded in the order selected.
async function uploadAnswer(id, files) {
  if (!files || files.length === 0) return;
  const el = document.getElementById("modal-answer-section");
  el.innerHTML = `<p class="muted">Uploading...</p>`;
  try {
    let updated;
    for (const file of files) {
      const form = new FormData();
      form.append("file", file);
      updated = await fetchJSON(`/api/questions/${id}/answer`, { method: "POST", body: form });
    }
    const idx = browseResultsCache.findIndex(q => q.id === id);
    if (idx !== -1) browseResultsCache[idx] = updated;
    renderAnswerSection();
  } catch (err) {
    el.innerHTML = `<p class="status-msg err">Error: ${escapeHtml(err.message)}</p>`;
  }
}

async function removeAnswerImage(id, imageId) {
  if (!confirm("Remove this page of the worked solution?")) return;
  const updated = await fetchJSON(`/api/questions/${id}/images/${imageId}`, { method: "DELETE" });
  const idx = browseResultsCache.findIndex(q => q.id === id);
  if (idx !== -1) browseResultsCache[idx] = updated;
  renderAnswerSection();
}

async function deleteQuestionFromModal() {
  const q = browseResultsCache[modalIndex];
  if (!q) return;
  if (!confirm("Delete this question?")) return;
  await fetchJSON(`/api/questions/${q.id}`, { method: "DELETE" });
  closeQuestionModal();
  refreshBrowse();
}

async function deleteQuestion(id) {
  if (!confirm("Delete this question?")) return;
  await fetchJSON(`/api/questions/${id}`, { method: "DELETE" });
  refreshBrowse();
}

document.getElementById("modal-close").addEventListener("click", closeQuestionModal);
document.getElementById("modal-prev").addEventListener("click", () => modalNav(-1));
document.getElementById("modal-next").addEventListener("click", () => modalNav(1));
document.getElementById("modal-delete").addEventListener("click", deleteQuestionFromModal);

document.addEventListener("keydown", (e) => {
  if (document.getElementById("question-modal").style.display === "none") return;
  if (e.key === "ArrowLeft") modalNav(-1);
  if (e.key === "ArrowRight") modalNav(1);
  if (e.key === "Escape") closeQuestionModal();
});

// ---------------------------------------------------------------
// Init
// ---------------------------------------------------------------
window.deletePaper = deletePaper;
window.openChopById = openChopById;
window.deleteQuestion = deleteQuestion;
window.openQuestionModal = openQuestionModal;
window.uploadAnswer = uploadAnswer;
window.removeAnswerImage = removeAnswerImage;

loadDropdownData();
refreshBrowse();
