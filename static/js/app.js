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
  // Topics/subtopics are intentionally NOT loaded here -- they're scoped
  // to a subject+unit (and subtopics further to a topic), so they're
  // fetched on demand as those cascading selections are made. Loading
  // a flat global topic list here was the bug: every subject's topics
  // showed up regardless of what you'd picked.
  const [subjects, schools] = await Promise.all([
    fetchJSON("/api/subjects"),
    fetchJSON("/api/schools"),
  ]);
  populateDatalist("subject-list", subjects);
  populateDatalist("school-list", schools);
  populateSelect("f-subject", subjects, "Subject: any");
  populateSelect("f-school", schools, "School: any");
}

// ---------------------------------------------------------------
// Browse filter cascade: Subject -> Unit -> Topic -> Subtopic
// Each level is disabled with a placeholder until the level above it
// has a value, and picking a new value at any level clears/disables
// everything below it (since a subtopic list, say, is meaningless
// once the topic it belonged to has changed).
// ---------------------------------------------------------------
function setSelectState(id, enabled, placeholder, options) {
  const el = document.getElementById(id);
  el.disabled = !enabled;
  if (options) {
    el.innerHTML = `<option value="">${placeholder}</option>` +
      options.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
  } else {
    el.innerHTML = `<option value="">${placeholder}</option>`;
  }
}

const UNIT_OPTIONS = ["1", "2", "3", "4"];

function resetUnitDown() {
  setSelectState("f-unit", false, "Unit: pick a subject first");
  resetTopicDown();
}
function resetTopicDown() {
  setSelectState("f-topic", false, "Topic: pick a unit first");
  resetSubtopicDown();
}
function resetSubtopicDown() {
  setSelectState("f-subtopic", false, "Subtopic: pick a topic first");
}

document.getElementById("f-subject").addEventListener("change", () => {
  const subject = document.getElementById("f-subject").value;
  if (subject) {
    setSelectState("f-unit", true, "Unit: any", UNIT_OPTIONS.map(u => `Unit ${u}`));
    // store the raw unit numbers as values via a second pass, since the
    // label ("Unit 3") and the filter value ("3") differ here
    const unitEl = document.getElementById("f-unit");
    unitEl.innerHTML = `<option value="">Unit: any</option>` +
      UNIT_OPTIONS.map(u => `<option value="${u}">Unit ${u}</option>`).join("");
  } else {
    resetUnitDown();
  }
  resetTopicDown();
});

document.getElementById("f-unit").addEventListener("change", async () => {
  const subject = document.getElementById("f-subject").value;
  const unit = document.getElementById("f-unit").value;
  if (subject && unit) {
    const topics = await fetchJSON(`/api/topics?subject=${encodeURIComponent(subject)}&unit=${encodeURIComponent(unit)}`);
    setSelectState("f-topic", true, topics.length ? "Topic: any" : "Topic: none chopped yet", topics);
  } else {
    resetTopicDown();
  }
  resetSubtopicDown();
});

document.getElementById("f-topic").addEventListener("change", async () => {
  const subject = document.getElementById("f-subject").value;
  const unit = document.getElementById("f-unit").value;
  const topic = document.getElementById("f-topic").value;
  if (subject && unit && topic) {
    const subtopics = await fetchJSON(
      `/api/subtopics?subject=${encodeURIComponent(subject)}&unit=${encodeURIComponent(unit)}&topic=${encodeURIComponent(topic)}`
    );
    setSelectState("f-subtopic", true, subtopics.length ? "Subtopic: any" : "Subtopic: none set yet", subtopics);
  } else {
    resetSubtopicDown();
  }
});

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

// Quick add: for a one-off circulating screenshot/question that isn't
// really "a paper" -- skips straight to chopping instead of landing back
// on this tab, since speed is the whole point.
document.getElementById("quick-add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("quick-add-status");
  const subject = document.getElementById("qa-subject").value.trim();
  const file = document.getElementById("qa-file").files[0];

  if (!subject || !file) {
    statusEl.textContent = "Subject and a file are required.";
    statusEl.className = "status-msg err";
    return;
  }

  statusEl.textContent = "Adding...";
  statusEl.className = "status-msg";

  const formData = new FormData();
  formData.append("subject", subject);
  formData.append("file", file);

  try {
    const paper = await fetchJSON("/api/papers/quick", { method: "POST", body: formData });
    document.getElementById("quick-add-form").reset();
    statusEl.textContent = "";
    loadDropdownData();
    refreshPapersList(); // keep the background list in sync for when they come back

    // jump straight to the Chop tab, workspace open on this paper
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    document.querySelector('.tab-btn[data-tab="chop"]').classList.add("active");
    document.getElementById("tab-chop").classList.add("active");
    await openChop(paper);
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
    statusEl.className = "status-msg err";
  }
});

let papersListCache = [];

// Groups papers by subject and renders them under subject headings, so
// the list stays scannable as it grows. `filterSubject` (empty = all)
// narrows to one subject; `rowRenderer` produces each paper's own row
// markup, since the Add Paper list and Chop picker use different row
// templates for the same underlying data.
function renderGroupedPapers(papers, filterSubject, rowRenderer, emptyMessage) {
  const filtered = filterSubject ? papers.filter(p => p.subject === filterSubject) : papers;
  if (filtered.length === 0) {
    return `<p class="muted">${emptyMessage}</p>`;
  }
  const groups = {};
  filtered.forEach(p => {
    if (!groups[p.subject]) groups[p.subject] = [];
    groups[p.subject].push(p);
  });
  const subjects = Object.keys(groups).sort();
  return subjects.map(subj => `
    <h4 class="paper-group-heading">${escapeHtml(subj)} <span class="muted">(${groups[subj].length})</span></h4>
    ${groups[subj].map(rowRenderer).join("")}
  `).join("");
}

function paperRowTemplate(p) {
  return `
    <div class="paper-row-wrap">
      <div class="paper-row">
        <div class="paper-info">
          <b>${escapeHtml(p.school)}</b> — ${escapeHtml(p.subject)} (Y${p.year_level}, ${escapeHtml(p.exam_type)}${p.exam_year ? ", " + p.exam_year : ""})
          <br><span><a href="/files/${p.file_path}" target="_blank">view original</a>${p.solution_file_path ? ` | <a href="/files/${p.solution_file_path}" target="_blank">view solutions</a>` : ""}</span>
        </div>
        <div class="paper-row-actions">
          <button class="secondary" onclick="togglePaperEdit(${p.id})" id="paper-edit-btn-${p.id}">Edit</button>
          <button class="secondary" onclick="deletePaper(${p.id})">Delete</button>
        </div>
      </div>
      <div class="paper-edit-form" id="paper-edit-${p.id}" style="display:none;"></div>
    </div>
  `;
}

async function refreshPapersList() {
  const papers = await fetchJSON("/api/papers");
  papersListCache = papers;
  populateSelect("papers-subject-filter", [...new Set(papers.map(p => p.subject))].sort(), "All subjects");
  renderPapersListFiltered();
}

function renderPapersListFiltered() {
  const filterSubject = document.getElementById("papers-subject-filter").value;
  document.getElementById("papers-list").innerHTML =
    renderGroupedPapers(papersListCache, filterSubject, paperRowTemplate, "No papers added yet.");
}

document.getElementById("papers-subject-filter").addEventListener("change", renderPapersListFiltered);

// Lets you fix/backfill a paper's metadata -- e.g. set "unit" on a paper
// added before that field existed -- without touching the uploaded file
// or any questions already chopped from it.
function togglePaperEdit(id) {
  const panel = document.getElementById(`paper-edit-${id}`);
  const isOpen = panel.style.display !== "none";
  if (isOpen) {
    panel.style.display = "none";
    panel.innerHTML = "";
    return;
  }
  const p = papersListCache.find(x => x.id === id);
  if (!p) return;
  panel.style.display = "block";
  panel.innerHTML = `
    <label>School
      <input type="text" id="edit-school-${id}" list="school-list" value="${escapeHtml(p.school)}">
    </label>
    <label>Subject
      <input type="text" id="edit-subject-${id}" list="subject-list" value="${escapeHtml(p.subject)}">
    </label>
    <label>Year level
      <select id="edit-year-${id}">
        <option value="11" ${p.year_level === 11 ? "selected" : ""}>11</option>
        <option value="12" ${p.year_level === 12 ? "selected" : ""}>12</option>
      </select>
    </label>
    <label>Exam type
      <select id="edit-examtype-${id}">
        <option value="internal" ${p.exam_type === "internal" ? "selected" : ""}>Internal</option>
        <option value="mock" ${p.exam_type === "mock" ? "selected" : ""}>Mock</option>
        <option value="QCAA" ${p.exam_type === "QCAA" ? "selected" : ""}>QCAA-style</option>
      </select>
    </label>
    <label>Exam year (optional)
      <input type="number" id="edit-examyear-${id}" value="${p.exam_year || ""}" min="2000" max="2100">
    </label>
    <div class="paper-edit-actions">
      <button type="button" onclick="savePaperEdit(${id})">Save</button>
      <button type="button" class="secondary" onclick="togglePaperEdit(${id})">Cancel</button>
    </div>
    <div class="status-msg" id="paper-edit-status-${id}"></div>
  `;
}

async function savePaperEdit(id) {
  const statusEl = document.getElementById(`paper-edit-status-${id}`);
  statusEl.textContent = "Saving...";
  statusEl.className = "status-msg";
  try {
    await fetchJSON(`/api/papers/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        school: document.getElementById(`edit-school-${id}`).value.trim(),
        subject: document.getElementById(`edit-subject-${id}`).value.trim(),
        year_level: document.getElementById(`edit-year-${id}`).value,
        exam_type: document.getElementById(`edit-examtype-${id}`).value,
        exam_year: document.getElementById(`edit-examyear-${id}`).value || null,
      }),
    });
    await refreshPapersList();
    loadDropdownData();
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
    statusEl.className = "status-msg err";
  }
}

async function deletePaper(id) {
  if (!confirm("Delete this paper and all its chopped questions?")) return;
  await fetchJSON(`/api/papers/${id}`, { method: "DELETE" });
  refreshPapersList();
}

// ---------------------------------------------------------------
// CHOP TAB
// ---------------------------------------------------------------
function chopPaperRowTemplate(p) {
  return `
    <div class="paper-row">
      <div class="paper-info">
        <b>${escapeHtml(p.school)}</b> — ${escapeHtml(p.subject)} (Y${p.year_level}, ${escapeHtml(p.exam_type)}${p.exam_year ? ", " + p.exam_year : ""})
        ${p.solution_file_path ? `<br><span class="muted">Has a solutions file</span>` : ""}
      </div>
      <button onclick="openChopById(${p.id})">Chop this paper</button>
    </div>
  `;
}

async function refreshChopPicker() {
  document.getElementById("chop-workspace").style.display = "none";
  document.getElementById("chop-picker").style.display = "block";
  const papers = await fetchJSON("/api/papers");
  papersCache = papers;
  populateSelect("chop-subject-filter", [...new Set(papers.map(p => p.subject))].sort(), "All subjects");
  renderChopPickerFiltered();
}

function renderChopPickerFiltered() {
  const filterSubject = document.getElementById("chop-subject-filter").value;
  document.getElementById("chop-papers-list").innerHTML = renderGroupedPapers(
    papersCache, filterSubject, chopPaperRowTemplate,
    papersCache.length === 0 ? "No papers yet — add one in the Add Paper tab first." : "No papers for this subject."
  );
}

document.getElementById("chop-subject-filter").addEventListener("change", renderChopPickerFiltered);
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

  document.getElementById("q-unit").value = "";
  populateDatalist("topic-list", []);
  populateDatalist("subtopic-list", []);

  await loadPdfForMode();
  resetQuestionForm();
  resetAnswerForm();
}

// Unit lives on the QUESTION, not the paper -- a single paper (especially
// an older-syllabus one) can genuinely contain content from more than one
// unit, so it's picked per-question here rather than inherited from the
// paper. Topics are then scoped to (paper's subject, this question's
// chosen unit) instead of a global list.
document.getElementById("q-unit").addEventListener("change", async () => {
  const unit = document.getElementById("q-unit").value;
  if (!currentPaper || !unit) {
    populateDatalist("topic-list", []);
    populateDatalist("subtopic-list", []);
    return;
  }
  const topics = await fetchJSON(
    `/api/topics?subject=${encodeURIComponent(currentPaper.subject)}&unit=${encodeURIComponent(unit)}`
  );
  populateDatalist("topic-list", topics);
  populateDatalist("subtopic-list", []); // repopulated once a topic is entered
});

// Debounced: refreshes the subtopic datalist to match whatever topic
// value is currently typed/selected, scoped to this paper's subject +
// whichever unit is picked for this question.
let subtopicFetchTimer = null;
document.getElementById("q-topic").addEventListener("input", () => {
  clearTimeout(subtopicFetchTimer);
  subtopicFetchTimer = setTimeout(async () => {
    const topic = document.getElementById("q-topic").value.trim();
    const unit = document.getElementById("q-unit").value;
    if (!currentPaper || !unit || !topic) {
      populateDatalist("subtopic-list", []);
      return;
    }
    const subtopics = await fetchJSON(
      `/api/subtopics?subject=${encodeURIComponent(currentPaper.subject)}&unit=${encodeURIComponent(unit)}&topic=${encodeURIComponent(topic)}`
    );
    populateDatalist("subtopic-list", subtopics);
  }, 250);
});

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
      ${q.question_number ? escapeHtml(q.question_number) + " — " : ""}${escapeHtml(q.topic)} (${q.difficulty})${q.has_answer ? " [already has an answer]" : ""}
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
  document.getElementById("zoom-input").value = Math.round(scale * 100);
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

// Type a specific zoom % directly, as an alternative to the +/-/Fit
// buttons. Applies on Enter or when you click away from the field.
function applyTypedZoom() {
  if (!pdfDoc) return;
  const input = document.getElementById("zoom-input");
  const minPct = MIN_SCALE * 100;
  const maxPct = MAX_SCALE * 100;
  let val = parseFloat(input.value);
  if (isNaN(val)) {
    input.value = Math.round(scale * 100); // reject garbage input, restore current value
    return;
  }
  val = Math.max(minPct, Math.min(maxPct, val));
  scale = val / 100;
  renderPage(currentPage);
}
document.getElementById("zoom-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    applyTypedZoom();
    document.getElementById("zoom-input").blur();
  }
});
document.getElementById("zoom-input").addEventListener("blur", applyTypedZoom);

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
  const unit = document.getElementById("q-unit").value;

  const parts = [...stagedQuestionParts];
  if (pendingCropBlob) parts.push({ blob: pendingCropBlob, page: pendingCropPage });

  if (!unit) {
    statusEl.textContent = "Pick a unit (1-4).";
    statusEl.className = "status-msg err";
    return;
  }
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
        unit: parseInt(unit, 10),
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
  ["f-subject", "f-school", "f-difficulty", "f-exam-type"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("f-tags").value = "";
  document.getElementById("f-tags-exclude").value = "";
  resetUnitDown(); // also clears/disables topic + subtopic beneath it
  refreshBrowse();
});

async function refreshBrowse() {
  await loadDropdownData();

  const params = new URLSearchParams();
  const subject = document.getElementById("f-subject").value;
  const school = document.getElementById("f-school").value;
  const unit = document.getElementById("f-unit").value;
  const topic = document.getElementById("f-topic").value;
  const subtopic = document.getElementById("f-subtopic").value;
  const difficulty = document.getElementById("f-difficulty").value;
  const examType = document.getElementById("f-exam-type").value;
  const tagsRaw = document.getElementById("f-tags").value;
  const excludeTagsRaw = document.getElementById("f-tags-exclude").value;

  if (subject) params.append("subject", subject);
  if (school) params.append("school", school);
  if (unit) params.append("unit", unit);
  if (topic) params.append("topic", topic);
  if (subtopic) params.append("subtopic", subtopic);
  if (difficulty) params.append("difficulty", difficulty);
  if (examType) params.append("exam_type", examType);
  if (tagsRaw) tagsRaw.split(",").map(t => t.trim()).filter(Boolean).forEach(t => params.append("tag", t));
  if (excludeTagsRaw) excludeTagsRaw.split(",").map(t => t.trim()).filter(Boolean).forEach(t => params.append("exclude_tag", t));

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
        <button class="secondary" onclick="deleteQuestion(${q.id})">Delete</button>
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
let modalEditing = false;
let modalEditDifficulty = null;

function openQuestionModal(id) {
  const idx = browseResultsCache.findIndex(q => q.id === id);
  if (idx === -1) return;
  modalIndex = idx;
  modalEditing = false;
  document.getElementById("question-modal").style.display = "flex";
  document.body.style.overflow = "hidden";
  renderModalQuestion();
}

function closeQuestionModal() {
  document.getElementById("question-modal").style.display = "none";
  document.body.style.overflow = "";
  modalIndex = -1;
  modalEditing = false;
}

function modalNav(delta) {
  if (modalIndex === -1) return;
  const next = modalIndex + delta;
  if (next < 0 || next >= browseResultsCache.length) return;
  modalIndex = next;
  modalEditing = false; // don't carry an in-progress edit over to a different question
  renderModalQuestion();
}

function renderModalQuestion() {
  const q = browseResultsCache[modalIndex];
  if (!q) return;

  document.getElementById("modal-position").textContent = `${modalIndex + 1} / ${browseResultsCache.length}`;
  document.getElementById("modal-meta").textContent =
    `${q.school} · ${q.subject}${q.unit ? " · Unit " + q.unit : ""}${q.topic ? " · " + q.topic : ""}${q.subtopic ? " · " + q.subtopic : ""}`;
  document.getElementById("modal-prev").disabled = modalIndex === 0;
  document.getElementById("modal-next").disabled = modalIndex === browseResultsCache.length - 1;

  if (modalEditing) {
    renderModalEditForm(q);
  } else {
    renderModalViewBody(q);
  }
}

function renderModalViewBody(q) {
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
      ${q.unit ? `<span class="tag-pill">Unit ${q.unit}</span>` : `<span class="tag-pill unit-missing">Unit not set</span>`}
      ${q.tags.map(t => `<span class="tag-pill">${escapeHtml(t)}</span>`).join("")}
    </div>
    ${pages || `<p class="muted">No crop image (page ${q.page_number || "?"})</p>`}
    ${q.notes ? `<div class="q-notes">${escapeHtml(q.notes)}</div>` : ""}
    <div class="answer-section" id="modal-answer-section"></div>
  `;
  renderAnswerSection();
}

// Edit form: lets you fix up unit/topic/subtopic/etc on a question you've
// already chopped, without deleting and re-uploading it. This is what
// retroactively assigning a unit (or correcting a topic under the new
// syllabus) actually looks like for existing questions.
function renderModalEditForm(q) {
  modalEditDifficulty = q.difficulty;

  document.getElementById("modal-body").innerHTML = `
    <div id="modal-edit-form">
      <label>Unit
        <select id="modal-edit-unit">
          <option value="">Choose a unit</option>
          <option value="1">Unit 1</option>
          <option value="2">Unit 2</option>
          <option value="3">Unit 3</option>
          <option value="4">Unit 4</option>
        </select>
      </label>

      <label>Topic
        <input type="text" id="modal-edit-topic" list="modal-edit-topic-list">
        <datalist id="modal-edit-topic-list"></datalist>
      </label>

      <label>Subtopic (optional)
        <input type="text" id="modal-edit-subtopic" list="modal-edit-subtopic-list">
        <datalist id="modal-edit-subtopic-list"></datalist>
      </label>

      <label>Question number
        <input type="text" id="modal-edit-number" placeholder="e.g. 4b">
      </label>

      <label>Difficulty</label>
      <div class="difficulty-buttons">
        <button type="button" class="diff-btn" data-diff="SF">SF</button>
        <button type="button" class="diff-btn" data-diff="CF">CF</button>
        <button type="button" class="diff-btn" data-diff="CU">CU</button>
      </div>

      <label>Tags (comma separated)
        <input type="text" id="modal-edit-tags">
      </label>

      <label>Notes (optional)
        <textarea id="modal-edit-notes" rows="2"></textarea>
      </label>

      <div class="modal-edit-actions">
        <button type="button" id="modal-edit-save">Save changes</button>
        <button type="button" id="modal-edit-cancel" class="secondary">Cancel</button>
      </div>
      <div id="modal-edit-status" class="status-msg"></div>
    </div>
  `;

  document.getElementById("modal-edit-unit").value = q.unit || "";
  document.getElementById("modal-edit-topic").value = q.topic || "";
  document.getElementById("modal-edit-subtopic").value = q.subtopic || "";
  document.getElementById("modal-edit-number").value = q.question_number || "";
  document.getElementById("modal-edit-tags").value = q.tags.join(", ");
  document.getElementById("modal-edit-notes").value = q.notes || "";

  const form = document.getElementById("modal-edit-form");
  form.querySelectorAll(".diff-btn").forEach(btn => {
    if (btn.dataset.diff === q.difficulty) btn.classList.add("selected");
    btn.addEventListener("click", () => {
      form.querySelectorAll(".diff-btn").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      modalEditDifficulty = btn.dataset.diff;
    });
  });

  // Same subject+unit -> topic -> subtopic scoping as the chop form, so
  // editing suggests topics that already exist for this subject/unit
  // rather than a global list.
  async function refreshEditTopics() {
    const unit = document.getElementById("modal-edit-unit").value;
    if (!unit) { populateDatalist("modal-edit-topic-list", []); return; }
    const topics = await fetchJSON(`/api/topics?subject=${encodeURIComponent(q.subject)}&unit=${encodeURIComponent(unit)}`);
    populateDatalist("modal-edit-topic-list", topics);
  }
  async function refreshEditSubtopics() {
    const unit = document.getElementById("modal-edit-unit").value;
    const topic = document.getElementById("modal-edit-topic").value.trim();
    if (!unit || !topic) { populateDatalist("modal-edit-subtopic-list", []); return; }
    const subtopics = await fetchJSON(`/api/subtopics?subject=${encodeURIComponent(q.subject)}&unit=${encodeURIComponent(unit)}&topic=${encodeURIComponent(topic)}`);
    populateDatalist("modal-edit-subtopic-list", subtopics);
  }
  document.getElementById("modal-edit-unit").addEventListener("change", () => {
    refreshEditTopics();
    refreshEditSubtopics();
  });
  let editSubtopicTimer = null;
  document.getElementById("modal-edit-topic").addEventListener("input", () => {
    clearTimeout(editSubtopicTimer);
    editSubtopicTimer = setTimeout(refreshEditSubtopics, 250);
  });
  refreshEditTopics();
  refreshEditSubtopics();

  document.getElementById("modal-edit-cancel").addEventListener("click", () => {
    modalEditing = false;
    renderModalQuestion();
  });
  document.getElementById("modal-edit-save").addEventListener("click", saveModalEdit);
}

async function saveModalEdit() {
  const q = browseResultsCache[modalIndex];
  const statusEl = document.getElementById("modal-edit-status");
  const topic = document.getElementById("modal-edit-topic").value.trim();
  const unit = document.getElementById("modal-edit-unit").value;

  if (!topic) {
    statusEl.textContent = "Topic is required.";
    statusEl.className = "status-msg err";
    return;
  }
  if (!modalEditDifficulty) {
    statusEl.textContent = "Pick a difficulty (SF/CF/CU).";
    statusEl.className = "status-msg err";
    return;
  }

  statusEl.textContent = "Saving...";
  statusEl.className = "status-msg";

  const tags = document.getElementById("modal-edit-tags").value
    .split(",").map(t => t.trim()).filter(Boolean);

  try {
    const updated = await fetchJSON(`/api/questions/${q.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        unit: unit ? parseInt(unit, 10) : null,
        topic,
        subtopic: document.getElementById("modal-edit-subtopic").value.trim() || null,
        question_number: document.getElementById("modal-edit-number").value.trim() || null,
        difficulty: modalEditDifficulty,
        notes: document.getElementById("modal-edit-notes").value.trim() || null,
        tags,
      }),
    });
    browseResultsCache[modalIndex] = updated;
    modalEditing = false;
    renderModalQuestion();
    // keep the grid behind the modal in sync without a full refetch
    const grid = document.getElementById("results-grid");
    if (grid) grid.innerHTML = browseResultsCache.map(renderQuestionCard).join("");
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
    statusEl.className = "status-msg err";
  }
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
document.getElementById("modal-edit").addEventListener("click", () => {
  if (modalEditing) return; // already editing -- use Cancel/Save inside the form
  modalEditing = true;
  renderModalQuestion();
});

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
window.togglePaperEdit = togglePaperEdit;
window.savePaperEdit = savePaperEdit;
window.openChopById = openChopById;
window.deleteQuestion = deleteQuestion;
window.openQuestionModal = openQuestionModal;
window.uploadAnswer = uploadAnswer;
window.removeAnswerImage = removeAnswerImage;

loadDropdownData();
refreshBrowse();
