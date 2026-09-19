import * as pdfjsLib from "/static/vendor/pdfjs/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "/static/vendor/pdfjs/pdf.worker.min.mjs";

// ---------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------
// Show a tab without running its click handler (which would, for Chop, reset
// the workspace to the paper picker).
function showTabQuietly(tab) {
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
  document.querySelector(`.tab-btn[data-tab="${tab}"]`).classList.add("active");
  document.getElementById(`tab-${tab}`).classList.add("active");
}

document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");

    if (btn.dataset.tab === "browse") refreshBrowse();
    if (btn.dataset.tab === "add") refreshPapersList();
    if (btn.dataset.tab === "chop") refreshChopPicker();
    if (btn.dataset.tab === "classify") refreshClassifyTab();
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

// For values placed inside an HTML attribute (escapeHtml leaves quotes alone).
function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;");
}

// Your existing tags "Tech free" / "Tech active" / "MCQ" -- pressing one
// of these just types that same text into the comma-separated tag field,
// so a button-added tag and a hand-typed one are the exact same string
// in the database. Won't duplicate if it's already present, and leaves
// the cursor in the field so you can keep typing more tags after it.
const QUICK_TAGS = ["Tech free", "Tech active", "MCQ"];

function quickTagButtonsHtml(inputId) {
  return `<div class="quick-tag-row">${
    QUICK_TAGS.map(t => `<button type="button" class="quick-tag-btn" data-target="${inputId}" data-tag="${escapeHtml(t)}">+ ${escapeHtml(t)}</button>`).join("")
  }</div>`;
}

function wireQuickTagButtons(containerEl) {
  containerEl.querySelectorAll(".quick-tag-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const input = document.getElementById(btn.dataset.target);
      const current = input.value.split(",").map(t => t.trim()).filter(Boolean);
      if (!current.includes(btn.dataset.tag)) current.push(btn.dataset.tag);
      input.value = current.join(", ");
      input.focus();
    });
  });
}

// ---------------------------------------------------------------
// Multi-value topic / subtopic fields
// ---------------------------------------------------------------
// A question can have several topics and subtopics, typed comma-separated
// exactly like tags ("Integrals, Discrete random variables"). The first one
// is the primary topic.

// Splits a comma-separated field into a clean list: trimmed, blanks dropped,
// de-duplicated (case-insensitive), order kept. `known` is the names already
// in use -- a name that itself contains a comma (e.g. "Thermal, nuclear and
// electrical physics") is kept whole when it appears in that list, rather
// than being split apart.
function parseMulti(raw, known = []) {
  const commaNames = known.filter(k => k.includes(",")).sort((a, b) => b.length - a.length);
  const out = [];
  let rest = raw;
  for (;;) {
    rest = rest.replace(/^[\s,]+/, "");
    if (!rest) break;
    let item = null;
    const lower = rest.toLowerCase();
    for (const name of commaNames) {
      const n = name.toLowerCase();
      if (lower.startsWith(n) && /^\s*(,|$)/.test(rest.slice(n.length))) {
        item = rest.slice(0, n.length);
        rest = rest.slice(n.length);
        break;
      }
    }
    if (item === null) {
      const i = rest.indexOf(",");
      item = i === -1 ? rest : rest.slice(0, i);
      rest = i === -1 ? "" : rest.slice(i);
    }
    item = item.trim();
    if (item && !out.some(o => o.toLowerCase() === item.toLowerCase())) out.push(item);
  }
  return out;
}

function sameList(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function datalistValues(id) {
  const dl = document.getElementById(id);
  return dl ? [...dl.options].map(o => o.value).filter(Boolean) : [];
}

// "&topic=A&topic=B" for the topics currently typed in a topic field -- used
// to scope subtopic suggestions (the API ORs repeated topic params).
function topicParams(topicInput, extraKnown = []) {
  const known = [...datalistValues(topicInput.dataset.suggestFrom), ...extraKnown];
  return parseMulti(topicInput.value, known).map(t => `&topic=${encodeURIComponent(t)}`).join("");
}

// A native <datalist> can only autocomplete the whole field value, so it stops
// helping after the first comma. This keeps the datalist as the source of
// names (so all the existing code that fills it still works) and shows the
// ones not yet used as click-to-add chips under the field, narrowed by
// whatever is being typed after the last comma -- same look as the tag chips.
function attachMultiSuggest(input) {
  const sourceId = input.dataset.suggestFrom;
  const box = document.createElement("div");
  box.className = "quick-tag-row";
  // every name is shown (none hidden); a long list scrolls inside the box
  // instead of pushing the rest of the form down
  box.style.maxHeight = "132px";
  box.style.overflowY = "auto";
  input.insertAdjacentElement("afterend", box);

  function render() {
    const options = datalistValues(sourceId);
    const cut = input.value.lastIndexOf(",");
    const chosen = parseMulti(cut === -1 ? "" : input.value.slice(0, cut), options).map(v => v.toLowerCase());
    const typing = input.value.slice(cut + 1).trim().toLowerCase();
    const seen = new Set();
    const shown = options
      .filter(o => {
        const key = o.trim().toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        // skip names already chosen, and one that's been typed out in full
        return !chosen.includes(key) && key !== typing && key.includes(typing);
      });
    box.replaceChildren(...shown.map(o => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "quick-tag-btn";
      btn.dataset.value = o;
      btn.textContent = "+ " + o;
      return btn;
    }));
    box.style.display = shown.length ? "" : "none";
  }

  box.addEventListener("click", e => {
    const btn = e.target.closest("button[data-value]");
    if (!btn) return;
    const cut = input.value.lastIndexOf(",");
    const head = cut === -1 ? "" : input.value.slice(0, cut + 1).trimEnd() + " ";
    input.value = head + btn.dataset.value + ", ";
    input.focus();
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  input.addEventListener("input", render);
  const source = document.getElementById(sourceId);
  if (source) new MutationObserver(render).observe(source, { childList: true });
  render();
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
// ---------------------------------------------------------------
// BROWSE FILTER CASCADE -- Subject anchors everything (single-select,
// unchanged); Unit/Topic/Subtopic below it are toggle-chip multi-select
// rather than dropdowns. Cascade is "loose": with nothing picked at a
// level, the level below shows everything for the current subject
// (not nothing) -- so e.g. leaving Unit unpicked still lets you browse
// every topic for that subject, rather than forcing a unit choice
// first. Subject is still required before Unit/Topic/Subtopic show
// anything, since without it the topic list would be every topic
// across every subject at once.
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
const DIFFICULTY_OPTIONS = ["SF", "CF", "CU"];

let browseSelectedUnits = [];
let browseSelectedTopics = [];
let browseSelectedSubtopics = [];
let browseSelectedDifficulties = [];

function renderChipRow(containerId, options, selectedArr, onToggle, emptyHint) {
  const el = document.getElementById(containerId);
  if (options.length === 0) {
    el.innerHTML = emptyHint ? `<span class="muted">${emptyHint}</span>` : "";
    return;
  }
  el.innerHTML = options.map(opt => `
    <button type="button" class="chip-btn${selectedArr.includes(opt) ? " selected" : ""}" data-value="${escapeHtml(opt)}">${escapeHtml(opt)}</button>
  `).join("");
  el.querySelectorAll(".chip-btn").forEach(btn => {
    btn.addEventListener("click", () => onToggle(btn.dataset.value));
  });
}

function renderUnitChips() {
  renderChipRow("f-unit-chips", UNIT_OPTIONS, browseSelectedUnits, toggleUnit);
}
function renderDifficultyChips() {
  renderChipRow("f-difficulty-chips", DIFFICULTY_OPTIONS, browseSelectedDifficulties, toggleDifficulty);
}

async function refreshTopicChips() {
  const subject = document.getElementById("f-subject").value;
  if (!subject) {
    renderChipRow("f-topic-chips", [], browseSelectedTopics, toggleTopic, "Pick a subject first");
    return;
  }
  const params = new URLSearchParams({ subject });
  browseSelectedUnits.forEach(u => params.append("unit", u));
  const topics = await fetchJSON("/api/topics?" + params.toString());
  // Drop any selected topic that no longer applies (e.g. unit selection
  // narrowed the list) so stale filters can't silently keep applying.
  browseSelectedTopics = browseSelectedTopics.filter(t => topics.includes(t));
  renderChipRow("f-topic-chips", topics, browseSelectedTopics, toggleTopic,
    topics.length === 0 ? "No topics chopped yet for this scope" : null);
}

async function refreshSubtopicChips() {
  const subject = document.getElementById("f-subject").value;
  if (!subject) {
    renderChipRow("f-subtopic-chips", [], browseSelectedSubtopics, toggleSubtopic, "Pick a subject first");
    return;
  }
  const params = new URLSearchParams({ subject });
  browseSelectedUnits.forEach(u => params.append("unit", u));
  browseSelectedTopics.forEach(t => params.append("topic", t));
  const subtopics = await fetchJSON("/api/subtopics?" + params.toString());
  browseSelectedSubtopics = browseSelectedSubtopics.filter(s => subtopics.includes(s));
  renderChipRow("f-subtopic-chips", subtopics, browseSelectedSubtopics, toggleSubtopic,
    subtopics.length === 0 ? "No subtopics set for this scope" : null);
}

function toggleArrValue(arr, value) {
  const i = arr.indexOf(value);
  if (i === -1) arr.push(value); else arr.splice(i, 1);
}

function toggleUnit(value) {
  toggleArrValue(browseSelectedUnits, value);
  renderUnitChips();
  refreshTopicChips().then(refreshSubtopicChips);
  refreshBrowse(true);
}
function toggleTopic(value) {
  toggleArrValue(browseSelectedTopics, value);
  refreshTopicChips();
  refreshSubtopicChips();
  refreshBrowse(true);
}
function toggleSubtopic(value) {
  toggleArrValue(browseSelectedSubtopics, value);
  refreshSubtopicChips();
  refreshBrowse(true);
}
function toggleDifficulty(value) {
  toggleArrValue(browseSelectedDifficulties, value);
  renderDifficultyChips();
  refreshBrowse(true);
}

document.getElementById("f-subject").addEventListener("change", async () => {
  // A subject change invalidates whatever units/topics/subtopics were
  // picked for the OLD subject, same reasoning as the old strict cascade.
  browseSelectedUnits = [];
  browseSelectedTopics = [];
  browseSelectedSubtopics = [];
  renderUnitChips();
  await refreshTopicChips();
  await refreshSubtopicChips();
  refreshBrowse(true);
});

renderUnitChips();
renderDifficultyChips();

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

// ---------------------------------------------------------------
// QUICK ADD
// ---------------------------------------------------------------
// Pick or paste screenshots (several is fine). Each becomes a question that
// goes straight to the Classify queue -- no chopping, and no paper per
// screenshot (they all hang off one hidden "Screenshots" paper per subject).
// "Trim first" walks through them in Chop instead. A PDF still opens in Chop.
let quickQueue = []; // [{ file, url }] -- url is a preview object URL (images only)

const isImageFile = f => /\.(png|jpe?g)$/i.test(f.name || "") || /^image\/(png|jpeg)$/.test(f.type || "");
const isPdfFile = f => /\.pdf$/i.test(f.name || "") || f.type === "application/pdf";

function quickStatus(text, kind) {
  const el = document.getElementById("quick-add-status");
  el.textContent = text;
  el.className = "status-msg" + (kind ? " " + kind : "");
}

// A pasted screenshot often arrives as a nameless "image.png", or with no
// extension at all -- give it a proper name so the server accepts it.
function normalizeImageFile(f, n) {
  if (/\.(png|jpe?g)$/i.test(f.name || "")) return f;
  const ext = /jpeg/.test(f.type) ? "jpg" : "png";
  return new File([f], `screenshot-${Date.now()}-${n}.${ext}`, { type: f.type || "image/png" });
}

function updateQuickSubmitLabel() {
  const btn = document.getElementById("qa-submit");
  const n = quickQueue.length;
  if (n === 1 && isPdfFile(quickQueue[0].file)) btn.textContent = "Add & start chopping";
  else if (n === 0) btn.textContent = "Add";
  else btn.textContent = (document.getElementById("qa-trim").checked ? "Trim " : "Add ") + n + (n === 1 ? " screenshot" : " screenshots");
}

function renderQuickQueue() {
  document.getElementById("qa-queue").replaceChildren(...quickQueue.map((item, i) => {
    const tile = document.createElement("div");
    tile.className = "qa-thumb" + (item.url ? "" : " qa-file");
    if (item.url) {
      const img = document.createElement("img");
      img.src = item.url;
      img.alt = "screenshot";
      tile.append(img);
    } else {
      tile.append(item.file.name);
    }
    const x = document.createElement("button");
    x.type = "button";
    x.className = "qa-remove";
    x.title = "Remove";
    x.textContent = "×";
    x.dataset.index = i;
    tile.append(x);
    return tile;
  }));
  updateQuickSubmitLabel();
}

function clearQuickQueue() {
  quickQueue.forEach(q => q.url && URL.revokeObjectURL(q.url));
  quickQueue = [];
  renderQuickQueue();
}

function addToQuickQueue(files) {
  const accepted = [], rejected = [];
  files.forEach((f, i) => {
    if (isImageFile(f)) accepted.push(normalizeImageFile(f, i));
    else if (isPdfFile(f)) accepted.push(f);
    else rejected.push(f.name || "an unnamed file");
  });
  if (rejected.length) quickStatus(`Skipped ${rejected.join(", ")} -- only PNG, JPG or PDF files can be added.`, "err");
  if (!accepted.length) return;
  const combined = [...quickQueue.map(q => q.file), ...accepted];
  const pdfs = combined.filter(isPdfFile).length;
  if (pdfs && (pdfs > 1 || combined.length > 1)) {
    quickStatus("Add screenshots, or a single PDF -- not both.", "err");
    return;
  }
  if (!rejected.length) quickStatus("", "");
  accepted.forEach(f => quickQueue.push({ file: f, url: isImageFile(f) ? URL.createObjectURL(f) : null }));
  renderQuickQueue();
}

document.getElementById("qa-file").addEventListener("change", (e) => {
  addToQuickQueue([...e.target.files]);
  e.target.value = ""; // so picking the same file again still registers
});
document.getElementById("qa-trim").addEventListener("change", updateQuickSubmitLabel);
document.getElementById("qa-queue").addEventListener("click", (e) => {
  const btn = e.target.closest(".qa-remove");
  if (!btn) return;
  const [removed] = quickQueue.splice(Number(btn.dataset.index), 1);
  if (removed && removed.url) URL.revokeObjectURL(removed.url);
  renderQuickQueue();
});

// Ctrl/Cmd+V anywhere on the Add Paper tab. Plain-text pastes (into the
// subject box, say) are left alone -- only clipboards that carry files.
document.addEventListener("paste", (e) => {
  if (!document.getElementById("tab-add").classList.contains("active")) return;
  const cd = e.clipboardData;
  if (!cd) return;
  let files = [...cd.files];
  if (!files.length) files = [...cd.items].filter(i => i.kind === "file").map(i => i.getAsFile()).filter(Boolean);
  if (!files.length) return;
  e.preventDefault();
  addToQuickQueue(files);
});

function showQuickAdded(res) {
  const statusEl = document.getElementById("quick-add-status");
  const n = res.created.length;
  statusEl.className = "status-msg ok";
  statusEl.textContent = `Added ${n} screenshot${n === 1 ? "" : "s"} to the Classify queue. `;
  const link = document.createElement("a");
  link.href = "#";
  link.textContent = "Classify now";
  link.addEventListener("click", (ev) => {
    ev.preventDefault();
    document.querySelector('.tab-btn[data-tab="classify"]').click();
  });
  statusEl.append(link);
  if (res.skipped && res.skipped.length) {
    const note = document.createElement("div");
    note.className = "muted";
    note.textContent = `Skipped: ${res.skipped.map(x => x.filename).join(", ")}`;
    statusEl.append(note);
  }
}

document.getElementById("quick-add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const subject = document.getElementById("qa-subject").value.trim();
  if (!subject) { quickStatus("Subject is required.", "err"); return; }
  if (quickQueue.length === 0) { quickStatus("Pick or paste at least one screenshot (or a PDF).", "err"); return; }

  const files = quickQueue.map(q => q.file);
  const submitBtn = document.getElementById("qa-submit");
  submitBtn.disabled = true;
  quickStatus("Adding...", "");

  try {
    if (isPdfFile(files[0])) {
      // a PDF still becomes a paper and opens in Chop, as before
      const formData = new FormData();
      formData.append("subject", subject);
      formData.append("file", files[0]);
      const paper = await fetchJSON("/api/papers/quick", { method: "POST", body: formData });
      clearQuickQueue();
      quickStatus("", "");
      loadDropdownData();
      refreshPapersList();
      endTrimSession();
      showTabQuietly("chop");
      await openChop(paper);
    } else if (document.getElementById("qa-trim").checked) {
      // Trim first: nothing is uploaded yet. Chop opens each picked image and
      // only the crops you save are stored, on the subject's Screenshots paper.
      const paper = await fetchJSON("/api/papers/collection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject }),
      });
      clearQuickQueue();
      quickStatus("", "");
      loadDropdownData();
      await startTrimSession(paper, files);
    } else {
      const formData = new FormData();
      formData.append("subject", subject);
      files.forEach(f => formData.append("file", f));
      const res = await fetchJSON("/api/screenshots", { method: "POST", body: formData });
      clearQuickQueue();
      loadDropdownData();
      refreshClassifyBadges();
      showQuickAdded(res);
    }
  } catch (err) {
    quickStatus("Error: " + err.message, "err");
  } finally {
    submitBtn.disabled = false;
  }
});

let papersListCache = [];

// Groups papers by subject and renders them under subject headings, so
// the list stays scannable as it grows. `filterSubject` (empty = all)
// narrows to one subject; `rowRenderer` produces each paper's own row
// markup, since the Add Paper list and Chop picker use different row
// templates for the same underlying data.
function renderGroupedPapers(papers, filterSubject, rowRenderer, emptyMessage, context) {
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
  return subjects.map(subj => {
    // Papers made with Quick Add collapse into one "Random screenshots" row
    // per subject instead of cluttering the list one row each.
    const regular = groups[subj].filter(p => !isQuickPaper(p));
    const quick = groups[subj].filter(isQuickPaper);
    return `
    <h4 class="paper-group-heading">${escapeHtml(subj)}${regular.length ? ` <span class="muted">(${regular.length})</span>` : ""}</h4>
    ${quick.length ? quickGroupHtml(context, subj, quick) : ""}
    ${regular.map(rowRenderer).join("")}
  `;
  }).join("");
}

// Papers made with Quick Add (before screenshots became questions directly)
// all carry these placeholder values, which is what identifies one. Editing
// a paper's details later turns it back into a normal paper.
const QUICK_SCHOOL = "Uncategorized";
const QUICK_EXAM_TYPE = "misc";
const isQuickPaper = p => !p.is_collection && p.school === QUICK_SCHOOL && p.exam_type === QUICK_EXAM_TYPE;

const expandedQuickGroups = new Set(); // "add:Physics" / "chop:Physics"
const quickSelected = new Set();        // paper ids ticked in the Add tab's galleries

function quickGroupHtml(context, subject, quick) {
  const open = expandedQuickGroups.has(`${context}:${subject}`);
  const subj = escapeAttr(subject);
  const head = `<button type="button" class="quick-group-toggle" data-qg="toggle" data-subject="${subj}">${open ? "▾" : "▸"} Random screenshots <span class="muted">(${quick.length})</span></button>`;
  if (!open) return `<div class="quick-group">${head}</div>`;
  const picked = quick.filter(p => quickSelected.has(p.id)).length;
  const tools = context === "add" ? `
      <div class="quick-gallery-toolbar">
        <button type="button" class="secondary small" data-qg="select-all" data-subject="${subj}">Select all</button>
        <button type="button" class="secondary small" data-qg="select-empty" data-subject="${subj}">Select ones with no questions</button>
        <button type="button" class="secondary small" data-qg="select-none" data-subject="${subj}">Clear</button>
        <button type="button" class="small" data-qg="delete-selected" data-subject="${subj}" ${picked ? "" : "disabled"}>Delete selected (${picked})</button>
      </div>` : "";
  return `<div class="quick-group">${head}<div class="quick-gallery">${tools}<div class="quick-tiles">${quick.map(p => quickTileHtml(context, p)).join("")}</div></div></div>`;
}

function quickTileHtml(context, p) {
  const url = `/files/${escapeAttr(p.file_path)}`;
  const thumb = IMAGE_PATH_RE.test(p.file_path)
    ? `<a class="qt-thumb" href="${url}" target="_blank" title="Open full size"><img loading="lazy" src="${url}" alt="Screenshot"></a>`
    : `<a class="qt-thumb" href="${url}" target="_blank"><span class="qt-file">${escapeHtml(p.file_path.split(/[\\/]/).pop())}</span></a>`;
  const used = p.question_count > 0 ? `${p.question_count} question${p.question_count === 1 ? "" : "s"}` : "no questions yet";
  const ticked = context === "add" && quickSelected.has(p.id);
  const check = context === "add" ? `<input type="checkbox" data-qg-check="${p.id}" ${ticked ? "checked" : ""}>` : "";
  const del = context === "add" ? `<button type="button" class="secondary small" data-qg="delete-one" data-id="${p.id}">Delete</button>` : "";
  return `
    <div class="quick-tile${ticked ? " selected" : ""}">
      <div class="qt-top">${check}<span class="muted">${used}</span></div>
      ${thumb}
      <div class="qt-actions"><button type="button" class="small" data-qg="chop" data-id="${p.id}">Chop</button>${del}</div>
    </div>`;
}

function quickGroupHandler(context) {
  return (e) => {
    const el = e.target.closest("[data-qg]");
    if (!el) return;
    const action = el.dataset.qg, subject = el.dataset.subject, id = Number(el.dataset.id);
    const list = context === "add" ? papersListCache : papersCache;
    const inGroup = () => list.filter(p => p.subject === subject && isQuickPaper(p));
    const rerender = () => (context === "add" ? renderPapersListFiltered() : renderChopPickerFiltered());
    if (action === "toggle") {
      const key = `${context}:${subject}`;
      if (expandedQuickGroups.has(key)) expandedQuickGroups.delete(key); else expandedQuickGroups.add(key);
      rerender();
    } else if (action === "select-all") {
      inGroup().forEach(p => quickSelected.add(p.id));
      rerender();
    } else if (action === "select-empty") {
      inGroup().forEach(p => (p.question_count === 0 ? quickSelected.add(p.id) : quickSelected.delete(p.id)));
      rerender();
    } else if (action === "select-none") {
      inGroup().forEach(p => quickSelected.delete(p.id));
      rerender();
    } else if (action === "delete-selected") {
      deleteSelectedQuick(subject);
    } else if (action === "delete-one") {
      deletePaper(id);
    } else if (action === "chop") {
      chopQuickPaper(context, id);
    }
  };
}

function updateQuickDeleteButtons() {
  document.querySelectorAll('#papers-list [data-qg="delete-selected"]').forEach(btn => {
    const n = papersListCache.filter(p => p.subject === btn.dataset.subject && isQuickPaper(p) && quickSelected.has(p.id)).length;
    btn.textContent = `Delete selected (${n})`;
    btn.disabled = n === 0;
  });
}

async function chopQuickPaper(context, id) {
  const paper = (context === "add" ? papersListCache : papersCache).find(p => p.id === id);
  if (!paper) return;
  endTrimSession();
  if (context === "add") showTabQuietly("chop");
  try {
    await openChop(paper);
  } catch (err) {
    alert("Couldn't open this file in Chop: " + err.message);
  }
}

async function deleteSelectedQuick(subject) {
  const chosen = papersListCache.filter(p => p.subject === subject && isQuickPaper(p) && quickSelected.has(p.id));
  if (chosen.length === 0) return;
  const questions = chosen.reduce((n, p) => n + p.question_count, 0);
  const what = `${chosen.length} screenshot${chosen.length === 1 ? "" : "s"}`;
  const warn = questions > 0 ? ` ${questions} question${questions === 1 ? "" : "s"} already chopped from them will be deleted too.` : "";
  if (!confirm(`Delete ${what}?${warn}`)) return;
  try {
    for (const p of chosen) {
      await fetchJSON(`/api/papers/${p.id}`, { method: "DELETE" });
      quickSelected.delete(p.id);
    }
  } catch (err) {
    alert("Couldn't delete everything: " + err.message);
  }
  await refreshPapersList();
  refreshClassifyBadges();
  loadDropdownData();
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
  const papers = (await fetchJSON("/api/papers")).filter(p => !p.is_collection); // collections are managed via their questions
  papersListCache = papers;
  for (const id of [...quickSelected]) if (!papers.some(p => p.id === id)) quickSelected.delete(id);
  populateSelect("papers-subject-filter", [...new Set(papers.map(p => p.subject))].sort(), "All subjects");
  renderPapersListFiltered();
}

function renderPapersListFiltered() {
  const filterSubject = document.getElementById("papers-subject-filter").value;
  document.getElementById("papers-list").innerHTML =
    renderGroupedPapers(papersListCache, filterSubject, paperRowTemplate, "No papers added yet.", "add");
}

document.getElementById("papers-subject-filter").addEventListener("change", renderPapersListFiltered);
document.getElementById("papers-list").addEventListener("click", quickGroupHandler("add"));
document.getElementById("papers-list").addEventListener("change", (e) => {
  const cb = e.target.closest("[data-qg-check]");
  if (!cb) return;
  const id = Number(cb.dataset.qgCheck);
  if (cb.checked) quickSelected.add(id); else quickSelected.delete(id);
  cb.closest(".quick-tile").classList.toggle("selected", cb.checked);
  updateQuickDeleteButtons();
});

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
  refreshClassifyBadges(); // its questions may have been unclassified or flagged
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
  endTrimSession();
  document.getElementById("chop-workspace").style.display = "none";
  document.getElementById("chop-picker").style.display = "block";
  const papers = (await fetchJSON("/api/papers")).filter(p => !p.is_collection);
  papersCache = papers;
  populateSelect("chop-subject-filter", [...new Set(papers.map(p => p.subject))].sort(), "All subjects");
  renderChopPickerFiltered();
}

function renderChopPickerFiltered() {
  const filterSubject = document.getElementById("chop-subject-filter").value;
  document.getElementById("chop-papers-list").innerHTML = renderGroupedPapers(
    papersCache, filterSubject, chopPaperRowTemplate,
    papersCache.length === 0 ? "No papers yet — add one in the Add Paper tab first." : "No papers for this subject.",
    "chop"
  );
}

document.getElementById("chop-subject-filter").addEventListener("change", renderChopPickerFiltered);
document.getElementById("chop-papers-list").addEventListener("click", quickGroupHandler("chop"));
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
  endTrimSession();
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
    const topics = topicParams(document.getElementById("q-topic"));
    const unit = document.getElementById("q-unit").value;
    if (!currentPaper || !unit || !topics) {
      populateDatalist("subtopic-list", []);
      return;
    }
    const subtopics = await fetchJSON(
      `/api/subtopics?subject=${encodeURIComponent(currentPaper.subject)}&unit=${encodeURIComponent(unit)}${topics}`
    );
    populateDatalist("subtopic-list", subtopics);
  }, 250);
});

// Loads either the paper's original file or its solutions file into
// pdf.js, depending on which mode we're chopping in.
async function loadPdfForMode() {
  const path = chopMode === "answers" ? currentPaper.solution_file_path : currentPaper.file_path;
  if (chopSession && chopMode === "questions") {
    // a freshly-picked screenshot being trimmed (still on this device)
    pdfDoc = await loadImageDocument(chopSession.urls[chopSession.index]);
  } else if (IMAGE_PATH_RE.test(path)) {
    // an image stored as a paper's file (e.g. from the old Quick Add)
    pdfDoc = await loadImageDocument(`/files/${path}`);
  } else {
    pdfDoc = await pdfjsLib.getDocument(`/files/${path}`).promise;
  }
  currentPage = 1;
  await fitToWidth();
  await renderPage(currentPage);
}

// ---- Images as one-page "documents" ----
// A screenshot is a single raster page. This wraps a loaded <img> in the small
// interface the Chop code already uses for a pdf.js document/page
// (numPages, getPage, getViewport, render), so the viewer, zoom, box drawing
// and cropping all work on images unchanged. The image's natural pixel size is
// scale 1, which lets crops be cut from the original pixels 1:1.
const IMAGE_PATH_RE = /\.(png|jpe?g)$/i;

class ImagePage {
  constructor(img) {
    this.img = img;
    this.isImage = true;
  }
  getViewport({ scale }) {
    return { width: this.img.naturalWidth * scale, height: this.img.naturalHeight * scale, scale };
  }
  render({ canvasContext: ctx, viewport, transform }) {
    ctx.save();
    if (transform) ctx.transform(...transform);
    ctx.fillStyle = "#fff"; // a transparent PNG shouldn't show the dark page behind it
    ctx.fillRect(0, 0, viewport.width, viewport.height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(this.img, 0, 0, viewport.width, viewport.height);
    ctx.restore();
    return { promise: Promise.resolve() };
  }
}

async function loadImageDocument(url) {
  const img = new Image();
  img.src = url;
  await img.decode(); // rejects if the file isn't a readable image
  const page = new ImagePage(img);
  return { numPages: 1, getPage: async () => page };
}

// ---- Trimming freshly-picked screenshots (Quick Add's "Trim first") ----
// { files, urls, index } while walking through the screenshots you picked. The
// untrimmed originals are never uploaded -- only the crops you save are, as
// questions on the subject's Screenshots paper.
let chopSession = null;

function endTrimSession() {
  if (!chopSession) return;
  chopSession.urls.forEach(u => URL.revokeObjectURL(u));
  chopSession = null;
  document.getElementById("chop-session").style.display = "none";
}

function renderSessionStrip() {
  const strip = document.getElementById("chop-session");
  if (!chopSession) { strip.style.display = "none"; return; }
  const last = chopSession.index === chopSession.files.length - 1;
  strip.style.display = "flex";
  document.getElementById("session-label").textContent = `Screenshot ${chopSession.index + 1} / ${chopSession.files.length}`;
  document.getElementById("session-prev").disabled = chopSession.index === 0;
  document.getElementById("session-next").textContent = last ? "Finish" : "Next ›";
}

async function startTrimSession(paper, files) {
  endTrimSession();
  chopSession = { files, urls: files.map(f => URL.createObjectURL(f)), index: 0 };
  showTabQuietly("chop");
  await openChop(paper);
  document.getElementById("chop-paper-title").textContent = `Screenshots — ${paper.subject}`;
  renderSessionStrip();
}

async function sessionStep(delta) {
  if (!chopSession) return;
  if (pendingCropBlob || stagedQuestionParts.length) {
    if (!confirm("Discard the selection you haven't saved on this screenshot?")) return;
  }
  const next = chopSession.index + delta;
  if (next < 0) return;
  if (next >= chopSession.files.length) { // Finish
    endTrimSession();
    refreshClassifyBadges();
    showTabQuietly("add");
    quickStatus("Finished trimming.", "ok");
    return;
  }
  chopSession.index = next;
  resetQuestionForm();
  clearOverlay();
  await loadPdfForMode();
  renderSessionStrip();
}

document.getElementById("session-prev").addEventListener("click", () => sessionStep(-1));
document.getElementById("session-next").addEventListener("click", () => sessionStep(1));

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

// Natural sort for question numbers like "Q2" vs "Q10" vs "Q4b" -- splits
// into digit/non-digit chunks and compares digit chunks numerically, so
// Q10 sorts after Q2 instead of before it (plain string comparison would
// put "10" before "2" since '1' < '2' as characters).
function naturalCompare(a, b) {
  const chunk = s => (s || "").match(/\d+|\D+/g) || [];
  const ca = chunk(a), cb = chunk(b);
  for (let i = 0; i < Math.max(ca.length, cb.length); i++) {
    const xa = ca[i] || "", xb = cb[i] || "";
    const na = parseInt(xa, 10), nb = parseInt(xb, 10);
    if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
    if (xa !== xb) return xa < xb ? -1 : 1;
  }
  return 0;
}

async function populateAnswerQuestionSelect() {
  const select = document.getElementById("answer-q-select");
  // per_page comfortably covers even a very large single paper -- this
  // list is scoped to one paper_id, not the whole database, so it stays
  // small regardless of how many thousand questions are in TutorDB overall.
  const data = await fetchJSON(`/api/questions?paper_id=${currentPaper.id}&per_page=500`);
  const questions = data.questions;
  if (questions.length === 0) {
    select.innerHTML = `<option value="">No questions chopped yet for this paper</option>`;
    return;
  }
  // Ordered to match how you'd naturally chop through a paper -- by page,
  // then by question number -- so "next in the list" after saving an
  // answer really does mean "the next question on the paper", which is
  // what makes the auto-advance below useful rather than arbitrary.
  questions.sort((a, b) => {
    const pa = a.question_images[0]?.page_number ?? Infinity;
    const pb = b.question_images[0]?.page_number ?? Infinity;
    if (pa !== pb) return pa - pb;
    return naturalCompare(a.question_number, b.question_number);
  });
  select.innerHTML = questions.map(q => `
    <option value="${q.id}" data-has-answer="${q.has_answer ? "1" : ""}">
      ${q.question_number ? escapeHtml(q.question_number) + " — " : ""}${escapeHtml(q.topics.join(", "))} (${q.difficulty})${q.has_answer ? " [already has an answer]" : ""}
    </option>
  `).join("");
}

// Called right after an answer is saved. Moves the "Link to question"
// dropdown to the next question (in paper order) that doesn't have an
// answer yet -- so chopping a paper's worked solutions is just "draw a
// box, save, draw the next box, save" without re-picking the question
// each time. The dropdown itself is untouched otherwise, so overriding
// it manually (to answer out of order) still works exactly as before.
function advanceAnswerSelect(justAnsweredId) {
  const select = document.getElementById("answer-q-select");
  const options = [...select.options];
  const idx = options.findIndex(o => o.value === String(justAnsweredId));
  if (idx === -1) return;
  for (let i = idx + 1; i < options.length; i++) {
    if (!options[i].dataset.hasAnswer) {
      select.value = options[i].value;
      return;
    }
  }
  // Nothing unanswered left after this one -- leave the selection as-is
  // rather than jumping somewhere unexpected.
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

  document.getElementById("page-input").value = num;
  document.getElementById("page-total").textContent = pdfDoc.numPages;
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

// Type a specific page number directly, as an alternative to </>. Applies
// on Enter or when you click away from the field -- same interaction
// pattern as the zoom box right next to it.
function applyTypedPage() {
  if (!pdfDoc) return;
  const input = document.getElementById("page-input");
  let val = parseInt(input.value, 10);
  if (isNaN(val)) {
    input.value = currentPage; // reject garbage input, restore current value
    return;
  }
  val = Math.max(1, Math.min(pdfDoc.numPages, val));
  if (val !== currentPage) {
    currentPage = val;
    renderPage(currentPage);
  } else {
    input.value = currentPage;
  }
}
document.getElementById("page-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    applyTypedPage();
    document.getElementById("page-input").blur();
  }
});
document.getElementById("page-input").addEventListener("blur", applyTypedPage);

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

// ---- Crop export resolution ----
// The on-screen canvas is only as sharp as the current zoom level and the
// device's pixel density, so copying pixels straight off it gives soft,
// low-resolution crops (and the size varied with zoom). Instead, when a box
// is drawn, just that region is re-rendered straight from the PDF at a
// fixed, higher scale.
//
// PDF pages are laid out in points (1/72 inch), so a scale of 3 is roughly
// 216 DPI. Raise it for sharper crops (bigger files); lower it to save disk.
const CROP_EXPORT_SCALE = 3;
// Browsers cap canvas size (iOS Safari is the tightest at ~16.7M pixels), so
// the export scale is reduced automatically for very large selections.
const MAX_CROP_PIXELS = 16000000;

let cropRequestId = 0; // lets a newer selection supersede one still rendering

// x/y/w/h arrive in overlay-canvas pixels (what the mouse/touch handlers
// work in). Converts them to page units at scale 1, then renders only that
// region into an offscreen canvas at the export scale.
async function renderCropHighRes(x, y, w, h) {
  // Snapshot everything the maths depends on BEFORE awaiting, so a zoom or
  // page flip landing mid-render can't skew the selection.
  const doc = pdfDoc;
  const pageNum = currentPage;
  const cssWidth = parseFloat(overlay.style.width); // on-screen page width, CSS px
  const renderedDpr = overlay.width / cssWidth;
  const pxToPage = 1 / (renderedDpr * scale);

  const page = await doc.getPage(pageNum);
  let pageX = x * pxToPage, pageY = y * pxToPage;
  let pageW = w * pxToPage, pageH = h * pxToPage;

  // A screenshot is already raster: cut its own pixels out 1:1 (a whole-pixel
  // box, no resampling) instead of re-rendering at a higher scale, which would
  // only upsample it.
  const native = !!page.isImage;
  if (native) {
    const imgW = page.img.naturalWidth, imgH = page.img.naturalHeight;
    const x0 = Math.max(0, Math.round(pageX)), y0 = Math.max(0, Math.round(pageY));
    const x1 = Math.min(imgW, Math.round(pageX + pageW)), y1 = Math.min(imgH, Math.round(pageY + pageH));
    pageX = x0;
    pageY = y0;
    pageW = Math.max(1, x1 - x0);
    pageH = Math.max(1, y1 - y0);
  }

  // Never export softer than what's on screen (e.g. zoomed in on a Retina
  // display), but never exceed the browser's canvas limit either.
  let exportScale = native ? 1 : Math.max(CROP_EXPORT_SCALE, scale * renderedDpr);
  const pixels = pageW * pageH * exportScale * exportScale;
  if (pixels > MAX_CROP_PIXELS) exportScale *= Math.sqrt(MAX_CROP_PIXELS / pixels);

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(pageW * exportScale));
  canvas.height = Math.max(1, Math.round(pageH * exportScale));

  await page.render({
    canvasContext: canvas.getContext("2d"),
    viewport: page.getViewport({ scale: exportScale }),
    // shift the page so the selected region lands at the canvas origin
    transform: [1, 0, 0, 1, -pageX * exportScale, -pageY * exportScale],
  }).promise;
  return canvas;
}

// Original behaviour, kept as a fallback in case the high-res render fails:
// copy the selection's pixels straight off the on-screen canvas.
function copyCropFromScreen(x, y, w, h) {
  const pdfCanvas = document.getElementById("pdf-canvas");
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(pdfCanvas, x, y, w, h, 0, 0, w, h);
  return canvas;
}

async function cropSelection(x, y, w, h) {
  const requestId = ++cropRequestId;
  const pageNum = currentPage; // capture now: the user may flip pages mid-render
  const mode = chopMode;

  let cropCanvas;
  try {
    cropCanvas = await renderCropHighRes(x, y, w, h);
  } catch (err) {
    console.warn("High-res crop failed, using on-screen pixels instead:", err);
    cropCanvas = copyCropFromScreen(x, y, w, h);
  }
  if (requestId !== cropRequestId) return; // a newer selection took over

  cropCanvas.toBlob(blob => {
    if (requestId !== cropRequestId) return;
    pendingCropBlob = blob;
    pendingCropPage = pageNum;
    const previewUrl = URL.createObjectURL(blob);
    if (mode === "answers") {
      document.getElementById("answer-crop-preview").src = previewUrl;
      document.getElementById("answer-crop-preview-wrap").style.display = "block";
      document.getElementById("save-answer").disabled = false;
      document.getElementById("add-answer-part").disabled = false;
    } else {
      document.getElementById("crop-preview").src = previewUrl;
      document.getElementById("crop-preview-wrap").style.display = "block";
      document.getElementById("save-question").disabled = false;
      document.getElementById("quick-save-question").disabled = false;
      document.getElementById("add-question-part").disabled = false;
    }
    cropCanvas.width = cropCanvas.height = 0; // free the canvas memory promptly
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
  document.getElementById("quick-save-question").disabled = stagedQuestionParts.length === 0;
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
  // clearing programmatically fires no event, so refresh the suggestion chips
  document.getElementById("q-topic").dispatchEvent(new Event("input"));
  document.getElementById("q-subtopic").dispatchEvent(new Event("input"));
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
  document.getElementById("quick-save-question").disabled = true;
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
  const topics = parseMulti(document.getElementById("q-topic").value, datalistValues("topic-list"));
  const unit = document.getElementById("q-unit").value;

  const parts = [...stagedQuestionParts];
  if (pendingCropBlob) parts.push({ blob: pendingCropBlob, page: pendingCropPage });

  if (!unit) {
    statusEl.textContent = "Pick a unit (1-4).";
    statusEl.className = "status-msg err";
    return;
  }
  if (!topics.length) {
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
        topics,
        subtopics: parseMulti(document.getElementById("q-subtopic").value, datalistValues("subtopic-list")),
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

// Chop-everything-fast-now path: skips the topic/unit/difficulty
// requirement entirely and creates the question via /api/questions/quick
// (stored unclassified), then uploads whatever's been drawn exactly like
// the normal save does. The full "chop then classify, chop then
// classify" flow above is unchanged and still the default -- this is
// just an alternate button for when you'd rather batch the classifying
// into the Classify tab afterward.
document.getElementById("quick-save-question").addEventListener("click", async () => {
  const statusEl = document.getElementById("chop-status");
  const parts = [...stagedQuestionParts];
  if (pendingCropBlob) parts.push({ blob: pendingCropBlob, page: pendingCropPage });

  if (parts.length === 0) {
    statusEl.textContent = "Draw a box around the question first (draw more than one if it spans several pages).";
    statusEl.className = "status-msg err";
    return;
  }

  statusEl.textContent = "Saving...";
  statusEl.className = "status-msg";

  try {
    const question = await fetchJSON("/api/questions/quick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paper_id: currentPaperId, page_number: parts[0].page }),
    });

    await uploadParts(question.id, "/crop", "image", parts);

    statusEl.textContent = parts.length > 1
      ? `Quick-saved with ${parts.length} pages -- classify later on the Classify tab. Draw the next one.`
      : "Quick-saved -- classify later on the Classify tab. Draw the next one.";
    statusEl.className = "status-msg ok";
    clearOverlay();
    resetQuestionForm();
    refreshClassifyBadges();
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
    advanceAnswerSelect(questionId);
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
    statusEl.className = "status-msg err";
  }
});

// ---------------------------------------------------------------
// BROWSE TAB
// ---------------------------------------------------------------
const BROWSE_PAGE_SIZE = 60;

document.getElementById("apply-filters").addEventListener("click", () => refreshBrowse(true));
document.getElementById("clear-filters").addEventListener("click", async () => {
  ["f-subject", "f-school", "f-exam-type", "f-paper"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("f-tags").value = "";
  document.getElementById("f-tags-exclude").value = "";
  browseSelectedUnits = [];
  browseSelectedTopics = [];
  browseSelectedSubtopics = [];
  browseSelectedDifficulties = [];
  renderUnitChips();
  renderDifficultyChips();
  await refreshTopicChips();
  await refreshSubtopicChips();
  resetPaperDown();
  refreshBrowse(true);
});

// The Paper filter is scoped to whatever Subject (and School, if set) is
// currently picked -- same cascading idea as Unit/Topic/Subtopic, just
// against the papers list instead of topics, so you're not scrolling
// through every paper in the whole database to find the one you want.
function resetPaperDown() {
  setSelectState("f-paper", false, "Paper: pick a subject first");
}

async function refreshPaperFilterOptions() {
  const subject = document.getElementById("f-subject").value;
  if (!subject) {
    resetPaperDown();
    return;
  }
  const school = document.getElementById("f-school").value;
  const papers = await fetchJSON("/api/papers");
  // Quick Add papers are all identical placeholders ("Uncategorized -- Y12,
  // misc"), so they're left out; the School filter finds them. A subject's
  // Screenshots collection gets a readable name.
  const matches = papers.filter(p => p.subject === subject && (!school || p.school === school) && !isQuickPaper(p));
  const el = document.getElementById("f-paper");
  const current = el.value;
  el.disabled = false;
  el.innerHTML = `<option value="">Paper: any</option>` + matches.map(p => p.is_collection
    ? `<option value="${p.id}">Screenshots (added with Quick Add)</option>`
    : `<option value="${p.id}">${escapeHtml(p.school)} — Y${p.year_level}, ${escapeHtml(p.exam_type)}${p.exam_year ? ", " + p.exam_year : ""}</option>`
  ).join("");
  if (matches.some(p => String(p.id) === current)) el.value = current;
}

document.getElementById("f-subject").addEventListener("change", refreshPaperFilterOptions);
document.getElementById("f-school").addEventListener("change", refreshPaperFilterOptions);

let browsePage = 1;
let browseHasMore = false;
let browseLoading = false;

// Tag-based section ordering for the "one specific paper" view -- your
// papers are tagged "Tech free" / "Tech active" (MCQs included, since
// they're tagged with one of those plus "MCQ"), so that's the grouping
// key: untagged first, then Tech free, then Tech active, natural-sorted
// by question number within each group.
function paperClassSortKey(q) {
  if (q.tags.includes("Tech free")) return 1;
  if (q.tags.includes("Tech active")) return 2;
  return 0;
}
function sortForSinglePaper(questions) {
  return [...questions].sort((a, b) => {
    const ka = paperClassSortKey(a), kb = paperClassSortKey(b);
    if (ka !== kb) return ka - kb;
    return naturalCompare(a.question_number, b.question_number);
  });
}

// `reset` = true for a fresh filter/search (page 1, replace results);
// false is used only internally by "Load more" to append the next page.
async function refreshBrowse(reset = true) {
  if (reset) {
    await loadDropdownData();
    browsePage = 1;
    browseResultsCache = [];
  }
  if (browseLoading) return;
  browseLoading = true;

  const params = new URLSearchParams();
  const subject = document.getElementById("f-subject").value;
  const school = document.getElementById("f-school").value;
  const examType = document.getElementById("f-exam-type").value;
  const paperId = document.getElementById("f-paper").value;
  const tagsRaw = document.getElementById("f-tags").value;
  const excludeTagsRaw = document.getElementById("f-tags-exclude").value;

  if (subject) params.append("subject", subject);
  if (school) params.append("school", school);
  browseSelectedUnits.forEach(u => params.append("unit", u));
  browseSelectedTopics.forEach(t => params.append("topic", t));
  browseSelectedSubtopics.forEach(s => params.append("subtopic", s));
  browseSelectedDifficulties.forEach(d => params.append("difficulty", d));
  if (examType) params.append("exam_type", examType);
  if (paperId) params.append("paper_id", paperId);
  if (tagsRaw) tagsRaw.split(",").map(t => t.trim()).filter(Boolean).forEach(t => params.append("tag", t));
  if (excludeTagsRaw) excludeTagsRaw.split(",").map(t => t.trim()).filter(Boolean).forEach(t => params.append("exclude_tag", t));

  // A specific paper is selected -- a paper only ever has dozens of
  // questions, so fetch all of them in one go (no pagination needed)
  // and sort into the Tech free / Tech active ordering client-side,
  // instead of the usual server-paginated recency order.
  const singlePaperMode = !!paperId;

  if (singlePaperMode) {
    params.append("page", 1);
    params.append("per_page", 500);
  } else {
    params.append("page", browsePage);
    params.append("per_page", BROWSE_PAGE_SIZE);
  }

  try {
    const data = await fetchJSON("/api/questions?" + params.toString());
    if (singlePaperMode) {
      browseResultsCache = sortForSinglePaper(data.questions);
      browseHasMore = false;
    } else {
      browseResultsCache = reset ? data.questions : browseResultsCache.concat(data.questions);
      browseHasMore = data.has_more;
    }
    document.getElementById("results-count").textContent =
      `${data.total} question(s)${browseResultsCache.length < data.total ? ` — showing ${browseResultsCache.length}` : ""}`;

    const grid = document.getElementById("results-grid");
    if (browseResultsCache.length === 0) {
      grid.innerHTML = `<p class="muted">No questions match these filters yet.</p>`;
    } else {
      grid.innerHTML = browseResultsCache.map(renderQuestionCard).join("");
    }
    renderLoadMoreButton();
  } finally {
    browseLoading = false;
  }
}

function renderLoadMoreButton() {
  const el = document.getElementById("results-load-more");
  if (!el) return;
  if (!browseHasMore) {
    el.style.display = "none";
    return;
  }
  el.style.display = "block";
  el.disabled = false;
  el.textContent = "Load more";
}

document.getElementById("results-load-more").addEventListener("click", async () => {
  const btn = document.getElementById("results-load-more");
  btn.disabled = true;
  btn.textContent = "Loading...";
  browsePage += 1;
  await refreshBrowse(false);
});

let browseResultsCache = [];

function findCachedQuestion(id) {
  return browseResultsCache.find(q => q.id === id);
}

function renderQuestionCard(q) {
  const thumb = q.question_images[0];
  return `
    <div class="q-card" id="q-card-${q.id}">
      ${thumb
        ? `<img src="/files/${thumb.file_path}" alt="Question ${q.question_number || ""}" loading="lazy">`
        : `<div class="muted">No crop image (page ${q.page_number || "?"})</div>`
      }
      ${q.question_images.length > 1 ? `<div class="page-count-badge">${q.question_images.length} pages</div>` : ""}
      ${!q.is_classified ? `<div class="page-count-badge">⚠ unclassified</div>` : ""}
      ${q.needs_review ? `<div class="page-count-badge review-flag" title="${escapeAttr(q.review_note || "Flagged for review")}">⚑ review</div>` : ""}
      <div class="meta-row">
        <span>${escapeHtml(q.school)} · ${escapeHtml(q.subject)}</span>
        <span class="diff-tag ${q.difficulty}">${q.difficulty || "?"}</span>
      </div>
      ${q.topics.length
        ? `<div>${q.topics.map(t => `<span class="tag-pill topic-pill" title="Topic">${escapeHtml(t)}</span>`).join("")}${q.subtopics.map(s => `<span class="tag-pill subtopic-pill" title="Subtopic">${escapeHtml(s)}</span>`).join("")}</div>`
        : `<div class="muted">Not classified yet</div>`}
      <div>${q.tags.map(t => `<span class="tag-pill">${escapeHtml(t)}</span>`).join("")}</div>
      <div class="card-actions">
        <button class="secondary" onclick="openQuestionModal(${q.id})">Details</button>
        <button class="secondary" onclick="deleteQuestion(${q.id})">Delete</button>
      </div>
    </div>
  `;
}


// ---------------------------------------------------------------
// CLASSIFY TAB -- sort quickly through everything chopped via
// "Quick save (classify later)". Works as a queue: always shows
// classifyQueue[0]; a successful save/delete removes it from the front
// and the next one is already there, so the whole loop is
// draw-nothing / type-a-few-fields / click / repeat with no re-picking
// of "what's next" in between.
// ---------------------------------------------------------------
let classifyQueue = [];
let classifyRemaining = 0;
let classifySubjectFilter = "";
let classifySelectedDifficulty = null;
// "classify" = the quick-saved backlog; "reclassify" = questions flagged for review
let classifyMode = "classify";
// Pending subtopic-suggestion refresh for the CURRENT form. Module-level so a
// re-render (next question, empty state, mode switch) can cancel it -- it must
// never fire against a form that's already been replaced.
let clSubtopicTimer = null;

const CLASSIFY_COPY = {
  classify: {
    title: "Classify",
    hint: 'Questions chopped with "Quick save (classify later)" on the Chop tab show up here, one at a time, so you can sort through a whole backlog quickly without re-opening a picker each time.',
    remaining: "unclassified",
    empty: "Nothing to classify -- everything's sorted.",
  },
  reclassify: {
    title: "Reclassify",
    hint: "Questions you flagged for review in the viewer show up here with their current classification filled in. Fix what's wrong and save, or unflag if it's fine as it is.",
    remaining: "flagged for review",
    empty: "Nothing flagged for review.",
  },
};

document.querySelectorAll("#classify-mode-switch .classify-mode-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    if (classifyMode === btn.dataset.mode) return;
    classifyMode = btn.dataset.mode;
    document.querySelectorAll("#classify-mode-switch .classify-mode-btn")
      .forEach(b => b.classList.toggle("active", b === btn));
    refreshClassifyTab();
  });
});

async function refreshClassifyTab() {
  document.getElementById("classify-title").textContent = CLASSIFY_COPY[classifyMode].title;
  document.getElementById("classify-hint").textContent = CLASSIFY_COPY[classifyMode].hint;
  refreshClassifyBadges();
  const subjects = await fetchJSON("/api/subjects");
  populateSelect("classify-subject-filter", subjects, "All subjects");
  document.getElementById("classify-subject-filter").value = classifySubjectFilter;
  classifyQueue = [];
  await loadMoreClassifyQueue();
  renderClassifyCurrent();
}

document.getElementById("classify-subject-filter").addEventListener("change", () => {
  classifySubjectFilter = document.getElementById("classify-subject-filter").value;
  refreshClassifyTab();
});

// Pulls another batch of unclassified questions. Deliberately small and
// re-fetched as the queue runs low, rather than loading every
// unclassified question in the database up front -- keeps this fast
// whether the backlog is a dozen questions or several hundred.
async function loadMoreClassifyQueue() {
  const params = new URLSearchParams();
  params.append(classifyMode === "reclassify" ? "needs_review" : "unclassified", "1");
  if (classifySubjectFilter) params.append("subject", classifySubjectFilter);
  params.append("per_page", "40");
  const data = await fetchJSON("/api/questions?" + params.toString());
  classifyRemaining = data.total;
  // Skip any already in the queue (in case a batch reload overlaps with
  // what's already staged locally after a subject-filter change).
  const existingIds = new Set(classifyQueue.map(q => q.id));
  classifyQueue = classifyQueue.concat(data.questions.filter(q => !existingIds.has(q.id)));
}

// The two coloured counts read "99+" / "9+" past their cap (the exact number
// is in the tooltip, and on the Classify tab itself).
const CLASSIFY_BADGE_CAP = 99;
const REVIEW_BADGE_CAP = 9;

function badgeHtml(cls, n, cap, label) {
  if (n <= 0) return "";
  return `<span class="${cls}" title="${n} ${label}">${n > cap ? cap + "+" : n}</span>`;
}

// One request feeds both counts: on the tab button and on the
// Classify / Reclassify switch inside the tab.
async function refreshClassifyBadges() {
  const { unclassified, needs_review } = await fetchJSON("/api/classify-counts");
  const toClassify = badgeHtml("unclassified-badge", unclassified, CLASSIFY_BADGE_CAP, "to classify");
  const toReview = badgeHtml("review-badge", needs_review, REVIEW_BADGE_CAP, "flagged for review");
  document.getElementById("classify-tab-btn").innerHTML = `Classify${toClassify}${toReview}`;
  document.getElementById("cl-mode-classify").innerHTML = `Classify${toClassify}`;
  document.getElementById("cl-mode-reclassify").innerHTML = `Reclassify${toReview}`;
}

function renderClassifyCurrent() {
  clearTimeout(clSubtopicTimer);
  const area = document.getElementById("classify-area");
  const copy = CLASSIFY_COPY[classifyMode];
  document.getElementById("classify-remaining").textContent =
    classifyRemaining > 0 ? `${classifyRemaining} ${copy.remaining}` : "";

  const q = classifyQueue[0];
  if (!q) {
    area.innerHTML = classifyRemaining === 0
      ? `<p class="muted">${copy.empty}</p>`
      : `<p class="muted">Loading...</p>`;
    return;
  }

  classifySelectedDifficulty = null;

  const pages = q.question_images.map(img => `
    <div class="detail-page">
      ${img.page_number ? `<span class="detail-page-label">Page ${img.page_number}</span>` : ""}
      <img class="detail-full-img" src="/files/${img.file_path}" alt="Question">
    </div>
  `).join("");

  area.innerHTML = `
    <div class="classify-layout">
      <div class="classify-images">
        ${pages || `<p class="muted">No crop image (page ${q.page_number || "?"})</p>`}
      </div>
      <div class="classify-form">
        ${classifyMode === "reclassify" ? flagBannerHtml(q) : ""}
        <div class="muted">${escapeHtml(q.school)} · ${escapeHtml(q.subject)}</div>

        <label>Unit
          <select id="cl-unit">
            <option value="">Choose a unit</option>
            <option value="1">Unit 1</option>
            <option value="2">Unit 2</option>
            <option value="3">Unit 3</option>
            <option value="4">Unit 4</option>
          </select>
        </label>

        <label>Topic (comma separated)
          <input type="text" id="cl-topic" data-suggest-from="cl-topic-list" autofocus>
          <datalist id="cl-topic-list"></datalist>
        </label>

        <label>Subtopic (optional, comma separated)
          <input type="text" id="cl-subtopic" data-suggest-from="cl-subtopic-list">
          <datalist id="cl-subtopic-list"></datalist>
        </label>

        <label>Question number
          <input type="text" id="cl-number" placeholder="e.g. 4b" value="${escapeHtml(q.question_number || "")}">
        </label>

        <label>Difficulty</label>
        <div class="difficulty-buttons" id="cl-diff-buttons">
          <button type="button" class="diff-btn" data-diff="SF">SF</button>
          <button type="button" class="diff-btn" data-diff="CF">CF</button>
          <button type="button" class="diff-btn" data-diff="CU">CU</button>
        </div>

        <label>Tags (comma separated)
          <input type="text" id="cl-tags">
        </label>
        ${quickTagButtonsHtml("cl-tags")}

        <label>Notes (optional)
          <textarea id="cl-notes" rows="2"></textarea>
        </label>

        <div class="classify-actions">
          <button type="button" id="cl-save-next">${classifyMode === "reclassify" ? "Save &amp; clear flag" : "Save &amp; next"}</button>
          ${classifyMode === "reclassify" ? `<button type="button" class="secondary" id="cl-unflag">Looks fine — unflag</button>` : ""}
          <button type="button" class="secondary" id="cl-skip">Skip for now</button>
          <button type="button" class="secondary" id="cl-delete">Delete</button>
        </div>
        <div id="classify-status" class="status-msg"></div>
      </div>
    </div>
  `;

  document.querySelectorAll("#cl-diff-buttons .diff-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#cl-diff-buttons .diff-btn").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      classifySelectedDifficulty = btn.dataset.diff;
    });
  });

  // Same subject+unit -> topic -> subtopic scoping used everywhere else
  // in the app, so the suggestions here match what you've already used.
  async function refreshClTopics() {
    const unit = document.getElementById("cl-unit").value;
    if (!unit) { populateDatalist("cl-topic-list", []); return; }
    const topics = await fetchJSON(`/api/topics?subject=${encodeURIComponent(q.subject)}&unit=${encodeURIComponent(unit)}`);
    if (classifyQueue[0] !== q) return; // the form moved on while this was loading
    populateDatalist("cl-topic-list", topics);
  }
  async function refreshClSubtopics() {
    const unit = document.getElementById("cl-unit").value;
    const topics = topicParams(document.getElementById("cl-topic"));
    if (!unit || !topics) { populateDatalist("cl-subtopic-list", []); return; }
    const subtopics = await fetchJSON(`/api/subtopics?subject=${encodeURIComponent(q.subject)}&unit=${encodeURIComponent(unit)}${topics}`);
    if (classifyQueue[0] !== q) return; // the form moved on while this was loading
    populateDatalist("cl-subtopic-list", subtopics);
  }
  document.getElementById("cl-unit").addEventListener("change", () => {
    refreshClTopics();
    // Unit just changed, so whatever's sitting in the topic box (partial
    // text from before the switch) no longer scopes anything -- clear
    // subtopics now and only repopulate once a fresh topic is typed
    // (below), instead of eagerly re-querying with a stale topic value.
    // This matches how the original Chop form's unit handler behaves.
    populateDatalist("cl-subtopic-list", []);
  });
  document.getElementById("cl-topic").addEventListener("input", () => {
    clearTimeout(clSubtopicTimer);
    clSubtopicTimer = setTimeout(refreshClSubtopics, 250);
  });

  document.getElementById("cl-save-next").addEventListener("click", saveClassifyCurrent);
  wireQuickTagButtons(area);
  attachMultiSuggest(document.getElementById("cl-topic"));
  attachMultiSuggest(document.getElementById("cl-subtopic"));
  document.getElementById("cl-skip").addEventListener("click", skipClassifyCurrent);
  document.getElementById("cl-delete").addEventListener("click", deleteClassifyCurrent);

  if (classifyMode === "reclassify") {
    document.getElementById("cl-unflag").addEventListener("click", unflagClassifyCurrent);
    // Reclassify starts from what the question already has, not a blank form.
    document.getElementById("cl-unit").value = q.unit || "";
    document.getElementById("cl-topic").value = q.topics.join(", ");
    document.getElementById("cl-subtopic").value = q.subtopics.join(", ");
    document.getElementById("cl-tags").value = q.tags.join(", ");
    document.getElementById("cl-notes").value = q.notes || "";
    classifySelectedDifficulty = q.difficulty || null;
    document.querySelectorAll("#cl-diff-buttons .diff-btn")
      .forEach(b => b.classList.toggle("selected", b.dataset.diff === q.difficulty));
    refreshClTopics();
    // typing events refresh the suggestion chips and the scoped subtopic list
    document.getElementById("cl-topic").dispatchEvent(new Event("input"));
    document.getElementById("cl-subtopic").dispatchEvent(new Event("input"));
  }
}

async function advanceClassifyQueue() {
  classifyQueue.shift();
  if (classifyQueue.length < 5) await loadMoreClassifyQueue();
  renderClassifyCurrent();
  refreshClassifyBadges();
}

async function saveClassifyCurrent() {
  const q = classifyQueue[0];
  const statusEl = document.getElementById("classify-status");
  // `q.topics` counts as "known" so a name containing a comma on this very
  // question parses back to itself (matters when reclassifying).
  const topics = parseMulti(document.getElementById("cl-topic").value,
    [...datalistValues("cl-topic-list"), ...q.topics]);
  const subtopics = parseMulti(document.getElementById("cl-subtopic").value,
    [...datalistValues("cl-subtopic-list"), ...q.subtopics]);
  const unit = document.getElementById("cl-unit").value;

  if (!unit) {
    statusEl.textContent = "Pick a unit (1-4).";
    statusEl.className = "status-msg err";
    return;
  }
  if (!topics.length) {
    statusEl.textContent = "Topic is required.";
    statusEl.className = "status-msg err";
    return;
  }
  if (!classifySelectedDifficulty) {
    statusEl.textContent = "Pick a difficulty (SF/CF/CU).";
    statusEl.className = "status-msg err";
    return;
  }

  statusEl.textContent = "Saving...";
  statusEl.className = "status-msg";

  const tags = document.getElementById("cl-tags").value
    .split(",").map(t => t.trim()).filter(Boolean);

  try {
    await fetchJSON(`/api/questions/${q.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        unit: parseInt(unit, 10),
        // only what actually changed, so saving can never rewrite a
        // classification you didn't touch
        ...(sameList(topics, q.topics.map(t => t.trim())) ? {} : { topics }),
        ...(sameList(subtopics, q.subtopics.map(t => t.trim())) ? {} : { subtopics }),
        question_number: document.getElementById("cl-number").value.trim() || null,
        difficulty: classifySelectedDifficulty,
        notes: document.getElementById("cl-notes").value.trim() || null,
        tags,
        // saving from Reclassify resolves the flag
        ...(classifyMode === "reclassify" ? { needs_review: false } : {}),
      }),
    });
    classifyRemaining = Math.max(0, classifyRemaining - 1);
    await advanceClassifyQueue();
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
    statusEl.className = "status-msg err";
  }
}

// Reviewed and it's fine as it is: clear the flag and leave the
// classification exactly as it was.
async function unflagClassifyCurrent() {
  const q = classifyQueue[0];
  const statusEl = document.getElementById("classify-status");
  try {
    await fetchJSON(`/api/questions/${q.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ needs_review: false }),
    });
    classifyRemaining = Math.max(0, classifyRemaining - 1);
    await advanceClassifyQueue();
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
    statusEl.className = "status-msg err";
  }
}

// Not a save -- just cycles this one to the back of the local queue so
// you can come back to it after the easier ones, without it vanishing
// from the backlog.
function skipClassifyCurrent() {
  if (classifyQueue.length > 1) {
    classifyQueue.push(classifyQueue.shift());
  }
  renderClassifyCurrent();
}

async function deleteClassifyCurrent() {
  const q = classifyQueue[0];
  if (!confirm("Delete this question?")) return;
  await fetchJSON(`/api/questions/${q.id}`, { method: "DELETE" });
  classifyRemaining = Math.max(0, classifyRemaining - 1);
  await advanceClassifyQueue();
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

// ---- Flag for review (viewer) ----
function flagBannerHtml(q, withUnflag = false) {
  return `<div class="flag-banner" id="flag-banner">
      <span>⚑ Flagged for review${q.review_note ? " — " + escapeHtml(q.review_note) : ""}</span>
      ${withUnflag ? `<button type="button" id="modal-edit-unflag" class="secondary small">Unflag</button>` : ""}
    </div>`;
}

// Label follows the current question. Disabled while editing: flagging is
// done from the viewer, and the Edit form has its own Unflag button.
function updateModalFlagButton() {
  const q = browseResultsCache[modalIndex];
  if (!q) return;
  const btn = document.getElementById("modal-flag");
  btn.textContent = q.needs_review ? "⚑ Unflag" : "⚑ Flag";
  btn.classList.toggle("flagged", !!q.needs_review);
  btn.disabled = modalEditing;
}

async function patchModalFlag(fields) {
  const q = browseResultsCache[modalIndex];
  const updated = await fetchJSON(`/api/questions/${q.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  browseResultsCache[modalIndex] = updated;
  // refresh just this card behind the modal, and the tab counts
  const card = document.getElementById(`q-card-${updated.id}`);
  if (card) card.outerHTML = renderQuestionCard(updated);
  refreshClassifyBadges();
  return updated;
}

function showFlagPanel() {
  if (document.getElementById("flag-panel")) return;
  const panel = document.createElement("div");
  panel.id = "flag-panel";
  panel.className = "flag-panel";
  panel.innerHTML = `
    <input type="text" id="flag-note" maxlength="300" placeholder="Why? (optional) e.g. difficulty looks wrong">
    <button type="button" id="flag-confirm">Flag for review</button>
    <button type="button" id="flag-cancel" class="secondary">Cancel</button>
    <div id="flag-status" class="status-msg err" style="width:100%;"></div>
  `;
  document.getElementById("modal-body").prepend(panel);
  const note = document.getElementById("flag-note");
  note.focus();

  async function submit() {
    try {
      await patchModalFlag({ needs_review: true, review_note: note.value.trim() || null });
      renderModalQuestion();
    } catch (err) {
      document.getElementById("flag-status").textContent = "Error: " + err.message;
    }
  }
  document.getElementById("flag-confirm").addEventListener("click", submit);
  document.getElementById("flag-cancel").addEventListener("click", () => panel.remove());
  note.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
    if (e.key === "Escape") { e.stopPropagation(); panel.remove(); } // cancel the panel, not the whole viewer
  });
}

document.getElementById("modal-flag").addEventListener("click", async () => {
  const q = browseResultsCache[modalIndex];
  if (!q || modalEditing) return;
  if (!q.needs_review) { showFlagPanel(); return; }
  try {
    await patchModalFlag({ needs_review: false });
    renderModalQuestion();
  } catch (err) {
    alert("Couldn't unflag: " + err.message);
  }
});

// Unflag from inside the Edit form. Deliberately does NOT re-render the form,
// which would throw away whatever has been typed but not saved yet.
async function unflagFromEditForm() {
  try {
    await patchModalFlag({ needs_review: false });
    const banner = document.getElementById("flag-banner");
    if (banner) banner.remove();
    updateModalFlagButton();
  } catch (err) {
    const statusEl = document.getElementById("modal-edit-status");
    statusEl.textContent = "Error: " + err.message;
    statusEl.className = "status-msg err";
  }
}

function renderModalQuestion() {
  const q = browseResultsCache[modalIndex];
  if (!q) return;

  document.getElementById("modal-position").textContent = `${modalIndex + 1} / ${browseResultsCache.length}`;
  document.getElementById("modal-meta").textContent =
    `${q.school} · ${q.subject}${q.unit ? " · Unit " + q.unit : ""}${q.topics.length ? " · " + q.topics.join(", ") : ""}${q.subtopics.length ? " · " + q.subtopics.join(", ") : ""}`;
  document.getElementById("modal-prev").disabled = modalIndex === 0;
  document.getElementById("modal-next").disabled = modalIndex === browseResultsCache.length - 1;
  updateModalFlagButton();

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
    ${q.needs_review ? flagBannerHtml(q) : ""}
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
      ${q.needs_review ? flagBannerHtml(q, true) : ""}
      <label>Unit
        <select id="modal-edit-unit">
          <option value="">Choose a unit</option>
          <option value="1">Unit 1</option>
          <option value="2">Unit 2</option>
          <option value="3">Unit 3</option>
          <option value="4">Unit 4</option>
        </select>
      </label>

      <label>Topic (comma separated)
        <input type="text" id="modal-edit-topic" data-suggest-from="modal-edit-topic-list">
        <datalist id="modal-edit-topic-list"></datalist>
      </label>

      <label>Subtopic (optional, comma separated)
        <input type="text" id="modal-edit-subtopic" data-suggest-from="modal-edit-subtopic-list">
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
      ${quickTagButtonsHtml("modal-edit-tags")}

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
  document.getElementById("modal-edit-topic").value = q.topics.join(", ");
  document.getElementById("modal-edit-subtopic").value = q.subtopics.join(", ");
  document.getElementById("modal-edit-number").value = q.question_number || "";
  document.getElementById("modal-edit-tags").value = q.tags.join(", ");
  document.getElementById("modal-edit-notes").value = q.notes || "";

  const form = document.getElementById("modal-edit-form");
  wireQuickTagButtons(form);
  attachMultiSuggest(document.getElementById("modal-edit-topic"));
  attachMultiSuggest(document.getElementById("modal-edit-subtopic"));
  const unflagBtn = document.getElementById("modal-edit-unflag");
  if (unflagBtn) unflagBtn.addEventListener("click", unflagFromEditForm);
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
    const topics = topicParams(document.getElementById("modal-edit-topic"), q.topics);
    if (!unit || !topics) { populateDatalist("modal-edit-subtopic-list", []); return; }
    const subtopics = await fetchJSON(`/api/subtopics?subject=${encodeURIComponent(q.subject)}&unit=${encodeURIComponent(unit)}${topics}`);
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
  // `q.topics` is passed as "known" so a name that contains a comma on this
  // very question always parses back to itself, never split in two.
  const topics = parseMulti(document.getElementById("modal-edit-topic").value,
    [...datalistValues("modal-edit-topic-list"), ...q.topics]);
  const subtopics = parseMulti(document.getElementById("modal-edit-subtopic").value,
    [...datalistValues("modal-edit-subtopic-list"), ...q.subtopics]);
  const unit = document.getElementById("modal-edit-unit").value;

  if (!topics.length) {
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
        // Only send topics/subtopics that actually changed, so saving an
        // unrelated edit (say, difficulty) can never touch how an existing
        // question is classified.
        ...(sameList(topics, q.topics.map(t => t.trim())) ? {} : { topics }),
        ...(sameList(subtopics, q.subtopics.map(t => t.trim())) ? {} : { subtopics }),
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
  refreshClassifyBadges(); // it may have been unclassified or flagged
}

async function deleteQuestion(id) {
  if (!confirm("Delete this question?")) return;
  await fetchJSON(`/api/questions/${id}`, { method: "DELETE" });
  refreshBrowse();
  refreshClassifyBadges(); // it may have been unclassified or flagged
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
  // ← / → move the text cursor inside a field (or change a dropdown): they must
  // not also flip to another question and throw away an in-progress edit.
  const typing = e.target.matches && e.target.matches("input, textarea, select");
  if (e.key === "ArrowLeft" && !typing) modalNav(-1);
  if (e.key === "ArrowRight" && !typing) modalNav(1);
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
refreshClassifyBadges();

document.getElementById("q-quick-tags").innerHTML = quickTagButtonsHtml("q-tags");
wireQuickTagButtons(document.getElementById("q-quick-tags"));
attachMultiSuggest(document.getElementById("q-topic"));
attachMultiSuggest(document.getElementById("q-subtopic"));
