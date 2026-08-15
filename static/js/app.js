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
  const el = document.getElementById("chop-papers-list");
  if (papers.length === 0) {
    el.innerHTML = `<p class="muted">No papers yet — add one in the Add Paper tab first.</p>`;
    return;
  }
  el.innerHTML = papers.map(p => `
    <div class="paper-row">
      <div class="paper-info">
        <b>${escapeHtml(p.school)}</b> — ${escapeHtml(p.subject)} (Y${p.year_level}, ${escapeHtml(p.exam_type)}${p.exam_year ? ", " + p.exam_year : ""})
      </div>
      <button onclick="openChop(${p.id}, '${escapeHtml(p.file_path)}', '${escapeHtml(p.school)} — ${escapeHtml(p.subject)}')">Chop this paper</button>
    </div>
  `).join("");
}

document.getElementById("chop-back").addEventListener("click", refreshChopPicker);

let pdfDoc = null;
let currentPage = 1;
let currentPaperId = null;
let scale = 1.4;
let selectedDifficulty = null;
let pendingCropBlob = null;
let currentScale = 1.0;
let userScaleOverride = null; // Track manual zoom adjustments

async function openChop(paperId, filePath, title) {
  currentPaperId = paperId;
  document.getElementById("chop-picker").style.display = "none";
  document.getElementById("chop-workspace").style.display = "block";
  document.getElementById("chop-paper-title").textContent = title;

  const loadingTask = pdfjsLib.getDocument(`/files/${filePath}`);
  pdfDoc = await loadingTask.promise;
  currentPage = 1;
  await renderPage(currentPage);
  resetQuestionForm();
}

async function renderPage(num) {
  if (!pdfDoc) return;

  const page = await pdfDoc.getPage(num);
  const pdfCanvas = document.getElementById("pdf-canvas");
  const overlayCanvas = document.getElementById("overlay-canvas");
  const container = document.querySelector(".pdf-canvas-wrap");

  // Get base PDF dimensions at scale = 1.0
  const unscaledViewport = page.getViewport({ scale: 1.0 });

  // Calculate fit-to-width scale based on screen/container size
  const containerWidth = container.clientWidth - 20; // 20px padding margin
  const autoScale = containerWidth / unscaledViewport.width;

  // Use user manual scale if set; otherwise, use responsive autoScale
  currentScale = userScaleOverride || autoScale;

  const viewport = page.getViewport({ scale: currentScale });

  // Size both canvases to match viewport dimensions exactly
  pdfCanvas.width = viewport.width;
  pdfCanvas.height = viewport.height;
  overlayCanvas.width = viewport.width;
  overlayCanvas.height = viewport.height;

  // FIX FOR IPHONE ZOOM/SCROLL BUG: Lock display styles explicitly
  pdfCanvas.style.width = viewport.width + 'px';
  pdfCanvas.style.height = viewport.height + 'px';
  overlayCanvas.style.width = viewport.width + 'px';
  overlayCanvas.style.height = viewport.height + 'px';

  // Render PDF content onto PDF Canvas
  const ctx = pdfCanvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;

  // Update UI indicators
  document.getElementById("page-indicator").textContent = `Page ${num} / ${pdfDoc.numPages}`;
  document.getElementById("zoom-indicator").textContent = `${Math.round(currentScale * 100)}%`;

  clearOverlay();
}

// --- Zoom Event Listeners ---

document.getElementById("zoom-in").addEventListener("click", async () => {
  userScaleOverride = (currentScale || 1.0) + 0.15;
  await renderPage(currentPage);
});

document.getElementById("zoom-out").addEventListener("click", async () => {
  if (currentScale > 0.3) {
    userScaleOverride = currentScale - 0.15;
    await renderPage(currentPage);
  }
});

document.getElementById("zoom-fit").addEventListener("click", async () => {
  userScaleOverride = null; // Reset back to dynamic auto-fit
  await renderPage(currentPage);
});

// Re-render automatically on window/screen orientation change
window.addEventListener("resize", () => {
  if (pdfDoc && !userScaleOverride) {
    renderPage(currentPage);
  }
});

document.getElementById("prev-page").addEventListener("click", async () => {
  if (currentPage > 1) {
    currentPage--;
    await renderPage(currentPage);
  }
});
document.getElementById("next-page").addEventListener("click", async () => {
  if (pdfDoc && currentPage < pdfDoc.numPages) {
    currentPage++;
    await renderPage(currentPage);
  }
});

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
  const clientX = evt.touches ? evt.touches[0].clientX : evt.clientX;
  const clientY = evt.touches ? evt.touches[0].clientY : evt.clientY;
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
    const previewUrl = URL.createObjectURL(blob);
    document.getElementById("crop-preview").src = previewUrl;
    document.getElementById("crop-preview-wrap").style.display = "block";
    document.getElementById("save-question").disabled = false;
  }, "image/png");
}

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
  document.getElementById("crop-preview-wrap").style.display = "none";
  document.getElementById("save-question").disabled = true;
  document.getElementById("chop-status").textContent = "";
}

document.getElementById("save-question").addEventListener("click", async () => {
  const statusEl = document.getElementById("chop-status");
  const topic = document.getElementById("q-topic").value.trim();

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
  if (!pendingCropBlob) {
    statusEl.textContent = "Draw a box around the question first.";
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
        page_number: currentPage,
        notes: document.getElementById("q-notes").value.trim() || null,
        tags,
      }),
    });

    const cropForm = new FormData();
    cropForm.append("image", pendingCropBlob, "crop.png");
    await fetchJSON(`/api/questions/${question.id}/crop`, { method: "POST", body: cropForm });

    statusEl.textContent = "Question saved. Draw the next one.";
    statusEl.className = "status-msg ok";
    clearOverlay();
    resetQuestionForm();
    loadDropdownData();
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
  document.getElementById("results-count").textContent = `${questions.length} question(s)`;

  const grid = document.getElementById("results-grid");
  if (questions.length === 0) {
    grid.innerHTML = `<p class="muted">No questions match these filters yet.</p>`;
    return;
  }

  grid.innerHTML = questions.map(q => `
    <div class="q-card">
      ${q.crop_image_path
        ? `<img src="/files/${q.crop_image_path}" alt="Question ${q.question_number || ""}">`
        : `<div class="muted">No crop image (page ${q.page_number || "?"})</div>`
      }
      <div class="meta-row">
        <span>${escapeHtml(q.school)} · ${escapeHtml(q.subject)}</span>
        <span class="diff-tag ${q.difficulty}">${q.difficulty}</span>
      </div>
      <div class="muted">${escapeHtml(q.topic)}${q.subtopic ? " · " + escapeHtml(q.subtopic) : ""}</div>
      <div>${q.tags.map(t => `<span class="tag-pill">${escapeHtml(t)}</span>`).join("")}</div>
      <div class="card-actions">
        <a href="/api/questions/${q.id}" target="_blank">details</a>
        <button class="secondary" onclick="deleteQuestion(${q.id})">delete</button>
      </div>
    </div>
  `).join("");
}

async function deleteQuestion(id) {
  if (!confirm("Delete this question?")) return;
  await fetchJSON(`/api/questions/${id}`, { method: "DELETE" });
  refreshBrowse();
}

// ---------------------------------------------------------------
// Init
// ---------------------------------------------------------------
window.deletePaper = deletePaper;
window.openChop = openChop;
window.deleteQuestion = deleteQuestion;

loadDropdownData();
refreshBrowse();
