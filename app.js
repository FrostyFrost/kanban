/* Канбан — приложение (локальный файл + синхронизация через GitHub Contents API) */
"use strict";

/* ---------- Константы ---------- */
const STATUS_ORDER = ["todo", "doing", "waiting", "done"];
const STATUS_LABELS = { todo: "Надо сделать", doing: "В работе", waiting: "Ожидание", done: "Выполнено" };
const TAG_LABELS = { work: "работа", family: "семья", school: "институт", other: "прочее" };
const TAG_CLASSES = { work: "tag", family: "tag tag-family", school: "tag tag-school", other: "tag tag-other" };
const TAG_COLORS = { work: "#5b8def", family: "#f5a623", school: "#2fbf71", other: "#94a1b7" };
function tagColor(tag) {
  return TAG_COLORS[tag] || "#b18cff";
}

const DEFAULT_SETTINGS = {
  token: "",
  repo: "FrostyFrost/kanban-data",
  file: "tasks.jsonl",
  branch: "main",
};
const TOKEN_NOTICE_KEY = "kanban.token-notice-seen";
const SETTINGS_KEY = "kanban.settings";
const TASK_SELECT_FILE_ACTIVE_KEY = "kanban.fileHandle";

/* ---------- Состояние ---------- */
let tasks = [];           // текущий список задач
let calCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let selectedDate = null;
let editingId = null;
let dragCard = null;
let fileHandle = null;    // FileSystemFileHandle из IndexedDB

/* ---------- DOM ---------- */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const els = {
  board: $("#board"),
  calendarView: $("#calendar-view"),
  stats: {
    todo: document.querySelector('[data-stat="todo"]'),
    doing: document.querySelector('[data-stat="doing"]'),
    waiting: document.querySelector('[data-stat="waiting"]'),
    done: document.querySelector('[data-stat="done"]'),
  },
  syncStatus: $("#sync-status"),
  modal: $("#modal"),
  modalTitle: $("#modal-title"),
  taskForm: $("#task-form"),
  taskId: $("#task-id"),
  taskText: $("#task-text"),
  taskStatus: $("#task-status"),
  taskDue: $("#task-due"),
  taskTags: $("#task-tags"),
  knownTags: $("#known-tags"),
  taskNotes: $("#task-notes"),
  taskRecurEnabled: $("#task-recur-enabled"),
  taskRecurFields: $("#recur-fields"),
  taskRecurEvery: $("#task-recur-every"),
  taskRecurUnit: $("#task-recur-unit"),
  taskRecurUntil: $("#task-recur-until"),
  taskDelete: $("#task-delete"),
  btnShowHidden: $("#btn-show-hidden"),
  settingsModal: $("#settings-modal"),
  settingsForm: $("#settings-form"),
  calGrid: $("#calendar-grid"),
  calTitle: $("#cal-title"),
  calDetail: $("#calendar-detail"),
};

/* ---------- Утилиты ---------- */
function genId() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  const months = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "нояб", "дек"];
  return `${d.getDate()} ${months[d.getMonth()]}`;
}
function normalizeRecur(raw) {
  if (!raw || typeof raw !== "object") return null;
  const every = Math.max(1, parseInt(raw.every, 10) || 1);
  const unit = ["day", "week", "month", "year"].includes(raw.unit) ? raw.unit : null;
  if (!unit) return null;
  const until = typeof raw.until === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.until) ? raw.until : "";
  return { every, unit, until };
}
function advanceDateObj(d, every, unit) {
  const next = new Date(d.getTime());
  if (unit === "day") next.setDate(next.getDate() + every);
  else if (unit === "week") next.setDate(next.getDate() + every * 7);
  else if (unit === "month") {
    const day = next.getDate();
    next.setDate(1);
    next.setMonth(next.getMonth() + every);
    const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(day, lastDay));
  } else if (unit === "year") {
    const day = next.getDate();
    next.setDate(1);
    next.setFullYear(next.getFullYear() + every);
    const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(day, lastDay));
  }
  return next;
}

function isoLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// is the task's occurrence on this date?
function taskOccurrencesOnDate(task, iso) {
  if (!task.due) return false;
  const target = new Date(iso + "T00:00:00");
  if (task.due === iso) return true;
  if (!task.recur) return false;
  const { every, unit } = task.recur;
  const untilDate = task.recur.until ? new Date(task.recur.until + "T00:00:00") : null;
  if (untilDate && target > untilDate) return false;
  let d = new Date(task.due + "T00:00:00");
  let guard = 0;
  while (d < target && guard < 20000) {
    d = advanceDateObj(d, every, unit);
    guard++;
  }
  return isoLocal(d) === iso;
}

function occurrenceIsoDates(task, monthStart, monthEnd) {
  // convenience: dates in [monthStart, monthEnd]
  if (!task.due) return [];
  const due = new Date(task.due + "T00:00:00");
  if (isNaN(due.getTime())) return [];
  const result = [];
  if (!task.recur) {
    if (due >= monthStart && due <= monthEnd) result.push(isoLocal(due));
    return result;
  }
  const { every, unit } = task.recur;
  const untilDate = task.recur.until ? new Date(task.recur.until + "T00:00:00") : null;
  if (untilDate && due > untilDate) return [];
  let d = new Date(due);
  let guard = 0;
  while (d <= monthEnd && guard < 20000) {
    if ((!untilDate || d <= untilDate) && d >= monthStart) result.push(isoLocal(d));
    if (untilDate && d >= untilDate) break;
    d = advanceDateObj(d, every, unit);
    guard++;
  }
  return result;
}

function readRecurFromForm() {
  const enabled = !!els.taskRecurEnabled.checked;
  if (!enabled) return null;
  const every = Math.max(1, parseInt(els.taskRecurEvery.value, 10) || 1);
  const unit = ["day", "week", "month", "year"].includes(els.taskRecurUnit.value) ? els.taskRecurUnit.value : "day";
  const until = els.taskRecurUntil.value || "";
  return { every, unit, until };
}

function syncRecurFieldsVisibility() {
  const show = els.taskRecurEnabled.checked;
  els.taskRecurFields.classList.toggle("hidden", !show);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function toast(msg, type = "ok", durationMs = 3500) {
  const el = document.createElement("div");
  el.className = "toast" + (type === "err" ? " err" : type === "ok" ? " ok" : "");
  el.textContent = msg;
  $("#toast-container").appendChild(el);
  setTimeout(() => el.remove(), durationMs);
}
function normalizeTags(str) {
  if (Array.isArray(str)) str = str.join(",");
  const seen = new Set();
  return str
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => {
      if (!t) return false;
      if (seen.has(t)) return false;
      seen.add(t);
      return true;
    });
}
function taskTagsClass(tag) {
  return TAG_CLASSES[tag] || "tag";
}
function normalizeStatus(s) {
  return STATUS_ORDER.includes(s) ? s : "todo";
}

/* ---------- Повторяющаяся карточка: завершение ---------- */
function nextOccurrenceDate(dueISO, recur) {
  // следующая дата цикла после dueISO; null — если цикл исчерпан (next > until)
  if (!dueISO || !recur) return null;
  const base = new Date(dueISO + "T00:00:00");
  if (isNaN(base.getTime())) return null;
  const untilDate = recur.until ? new Date(recur.until + "T00:00:00") : null;
  const next = advanceDateObj(base, recur.every, recur.unit);
  if (untilDate && next > untilDate) return null;
  return isoLocal(next);
}

function askRecurringDone(task) {
  // возвращает Promise<"all" | "one" | null> — null = отмена
  return new Promise((resolve) => {
    const modal = document.getElementById("recur-done-modal");
    const text = document.getElementById("recur-done-text");
    const next = nextOccurrenceDate(task.due, task.recur);
    if (!next) {
      // цикл исчерпан — сразу "весь цикл"
      resolve("all");
      return;
    }
    text.textContent = `«${task.text}» — выполнить весь цикл, или только это одно событие? (следующее: ${next})`;
    modal.classList.remove("hidden");
    const cleanup = () => modal.classList.add("hidden");
    document.getElementById("recur-done-all").onclick = () => { cleanup(); resolve("all"); };
    document.getElementById("recur-done-one").onclick = () => { cleanup(); resolve("one"); };
    document.getElementById("recur-done-cancel").onclick = () => { cleanup(); resolve(null); };
    document.getElementById("recur-done-cancel-x").onclick = () => { cleanup(); resolve(null); };
  });
}

// статус перехода карточки. Если переход в done и карточка повторяется — спрашиваем.
// Возвращает Promise, который resolve-ит результатом применения; "cancel" — отмена.
async function applyStatusChange(task, newStatus) {
  if (task.status === newStatus) return "noop";
  if (newStatus === "done" && task.recur) {
    const choice = await askRecurringDone(task);
    if (choice === null) return "cancel";
    if (choice === "all") {
      task.status = "done";
      task.recur = null;
      task.updated = new Date().toISOString();
      renderAll();
      autoSaveFile();
      toast("Весь цикл выполнен — карточка в «Выполнено»");
      return "done";
    }
    // one event
    const next = nextOccurrenceDate(task.due, task.recur);
    if (!next) {
      task.status = "done";
      task.recur = null;
      task.updated = new Date().toISOString();
      renderAll(); autoSaveFile();
      toast("Весь цикл выполнен — карточка в «Выполнено»");
      return "done";
    }
    task.status = "todo";
    task.due = next;
    task.updated = new Date().toISOString();
    renderAll();
    autoSaveFile();
    toast(`Одно событие выполнено — следующее: ${next}`);
    return "one";
  }
  task.status = newStatus;
  task.updated = new Date().toISOString();
  renderAll();
  autoSaveFile();
  return "done";
}
function normalizeTask(raw) {
  if (!raw || typeof raw !== "object") return null;
  const text = String(raw.text ?? "").trim();
  if (!text) return null;
  const tags = normalizeTags(raw.tags ?? []);
  const due = typeof raw.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.due) ? raw.due : "";
  return {
    id: String(raw.id || genId()),
    text,
    status: normalizeStatus(raw.status),
    due,
    tags,
    notes: String(raw.notes ?? "").trim(),
    recur: normalizeRecur(raw.recur),
    hidden: Boolean(raw.hidden),
    created: typeof raw.created === "string" && raw.created ? raw.created : todayISO(),
    updated: new Date().toISOString(),
  };
}

/* ---------- Парсинг / сериализация JSONL ---------- */
function parseJSONL(text) {
  const out = [];
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      const t = normalizeTask(obj);
      if (t) out.push(t);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  if (skipped > 0) {
    console.warn(`Пропущено невалидных строк: ${skipped}`);
  }
  return out;
}
function serializeJSONL(list) {
  return list.map((t) => JSON.stringify(t)).join("\n") + (list.length ? "\n" : "");
}

/* ---------- localStorage ---------- */
const LS_KEY = "kanban.tasks";
function saveLocalStorage() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(tasks));
  } catch (e) {
    console.warn("Не удалось сохранить в localStorage", e);
  }
}
function loadLocalStorage() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    return arr.map(normalizeTask).filter(Boolean);
  } catch {
    return null;
  }
}

/* ---------- IndexedDB (для file handle) ---------- */
const IDB_NAME = "kanban";
const IDB_STORE = "handles";
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}
async function idbPut(key, value) {
  const db = await idbOpen();
  return new Promise((resolve) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}
async function idbDel(key) {
  const db = await idbOpen();
  return new Promise((resolve) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/* ---------- Файл (File System Access API; fallback локально) ---------- */
async function loadFileHandle() {
  try {
    const h = await idbGet(TASK_SELECT_FILE_ACTIVE_KEY);
    if (h) {
      // проверим, что handle всё ещё валидный
      const perm = await h.queryPermission({ mode: "readwrite" });
      if (perm === "granted") return h;
      // если не granted — спросим
      const p = await h.requestPermission({ mode: "readwrite" });
      if (p === "granted") return h;
    }
  } catch (e) {
    console.warn("Ошибка при загрузке file handle", e);
  }
  return null;
}

async function pickFile() {
  if (!window.showOpenFilePicker) {
    toast("Выберите файл вручную (ваш браузер не поддерживает File System Access API)", "err");
    downloadAll();
    return null;
  }
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: "JSONL", accept: { "application/jsonl": [".jsonl"], "text/plain": [".jsonl"], "application/json": [".json"] } }],
      multiple: false,
    });
    return handle;
  } catch (e) {
    // пользователь отменил
    return null;
  }
}

async function readFileHandle(handle) {
  const file = await handle.getFile();
  return await file.text();
}

async function writeFileHandle(handle, content) {
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
}

let fileBoundToastShown = false;

async function autoSaveFile({ silent = false } = {}) {
  saveLocalStorage();
  if (!fileHandle) {
    if (!silent && !fileBoundToastShown) {
      fileBoundToastShown = true;
      setSyncStatus("⚠ Файл не привязан — нажмите 📁", "warn");
      toast("Файл задач не привязан — нажмите 📁 слева сверху. Изменения сохраняются только локально", "err");
    }
    return;
  }
  try {
    await writeFileHandle(fileHandle, serializeJSONL(tasks));
    fileBoundToastShown = false;
    setSyncStatus("Файл сохранён", "ok");
  } catch (e) {
    console.warn("Не удалось сохранить файл", e);
    setSyncStatus("Ошибка сохранения файла", "err");
  }
}

function downloadAll() {
  const blob = new Blob([serializeJSONL(tasks)], { type: "application/jsonl" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "tasks.jsonl";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- Настройки ---------- */
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

/* ---------- GitHub (Contents API) ---------- */
function setSyncStatus(text, type = "") {
  els.syncStatus.textContent = text;
  els.syncStatus.className = "sync-status" + (type ? " " + type : "");
}

async function githubGetJson(url, token) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "kanban-app" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ? `GitHub API вернул ${res.status}: ${err.message}` : `GitHub API вернул ${res.status}`);
  }
  return await res.json();
}

async function githubRawFetch(repoPath, branch, path, token) {
  // raw URL для публичного репозитория — без токена (raw не поддерживает auth)
  const url = `https://raw.githubusercontent.com/${repoPath}/${branch}/${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`raw fetch ${res.status}`);
  return await res.text();
}

async function githubPull() {
  const s = loadSettings();
  const filePath = s.file;
  let content = null;
  // сначала попробуем raw (без токена) — работает для публичных репозиториев
  try {
    content = await githubRawFetch(s.repo, s.branch, filePath, s.token);
    setSyncStatus("Загружаю из GitHub", "ok");
    return content;
  } catch (rawErr) {
    console.warn("raw fetch не удался:", rawErr);
  }
  // fallback: Contents API (для приватных с токеном)
  if (!s.token) {
    throw new Error("Не удалось загрузить из GitHub (репозиторий приватный? нужен PAT в ⚙)");
  }
  const apiUrl = `https://api.github.com/repos/${s.repo}/contents/${filePath}?ref=${encodeURIComponent(s.branch)}`;
  const data = await githubGetJson(apiUrl, s.token);
  if (!data) throw new Error("Файл не найден на GitHub");
  const bin = atob(data.content.replace(/\s/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

async function githubPush() {
  const s = loadSettings();
  if (!s.token) {
    throw new Error("Нет токена — откройте ⚙ и введите PAT");
  }
  const api = `https://api.github.com/repos/${s.repo}/contents/${s.file}`;
  const headers = {
    Authorization: `Bearer ${s.token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "kanban-app",
    "Content-Type": "application/json",
  };

  // сначала тянем sha, если файл существует (404 — файла нет, создаём новое)
  let sha = null;
  const getUrl = `${api}?ref=${encodeURIComponent(s.branch)}`;
  const existing = await githubGetJson(getUrl, s.token);
  if (existing && existing.sha) sha = existing.sha;
  else if (existing) {
    // файл существует, но не распаковывается — проверим текст-детали
    console.warn("Не удалось извлечь sha из ответа:", existing);
  }

  const contentStr = serializeJSONL(tasks);
  const bytes = new TextEncoder().encode(contentStr);
  const contentB64 = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
  const body = {
    message: "sync: обновление задач",
    content: contentB64,
    branch: s.branch,
  };
  if (sha) body.sha = sha;

  const res = await fetch(api, { method: "PUT", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `GitHub API вернул ${res.status}`);
  }
  const data = await res.json();
  return data;
}

/* ---------- Рендер ---------- */
function renderStats() {
  const counts = { todo: 0, doing: 0, waiting: 0, done: 0 };
  for (const t of tasks) if (!t.hidden && counts[t.status] !== undefined) counts[t.status]++;
  for (const k of STATUS_ORDER) els.stats[k].textContent = counts[k];
}

function tagPill(tag) {
  const label = TAG_LABELS[tag] ? TAG_LABELS[tag] : tag;
  const cls = taskTagsClass(tag);
  return `<span class="${cls}">${escapeHtml(label)}</span>`;
}

function taskCardHtml(task) {
  const dueDate = task.due ? fmtDate(task.due) : "";
  const overdue = task.due && task.due < todayISO() && task.status !== "done";
  const dueHtml = task.due ? `<span class="due ${overdue ? "overdue" : ""}">📅 ${dueDate}</span>` : "";
  const recurHtml = task.recur ? `<span class="recur-badge" title="Повторяется каждые ${task.recur.every} ${task.recur.unit === "day" ? "дни" : task.recur.unit === "week" ? "недели" : task.recur.unit === "month" ? "месяца" : "года"}">↻</span>` : "";
  const tags = task.tags.map(tagPill).join("");
  const notes = task.notes ? `<div class="task-notes">${escapeHtml(task.notes)}</div>` : "";
  const hideBtn = task.status === "done" ? `<button type="button" class="task-hide" data-hide="${task.id}" title="Скрыть карточку">Скрыть</button>` : "";
  return `
    ${hideBtn}
    <div class="task-text">${escapeHtml(task.text)}</div>
    ${notes}
    <div class="task-meta">${tags}${recurHtml}${dueHtml}</div>
  `;
}

function renderBoard() {
  els.board.innerHTML = "";
  for (const status of STATUS_ORDER) {
    const col = document.createElement("div");
    col.className = "column";
    col.dataset.status = status;
    const items = tasks.filter((t) => t.status === status && !t.hidden);
    col.innerHTML = `
      <div class="column-header">
        <span class="column-title">${STATUS_LABELS[status]}</span>
        <span class="column-count">${items.length}</span>
      </div>
      <div class="column-body" data-status="${status}"></div>
    `;
    els.board.appendChild(col);
    const body = col.querySelector(".column-body");
    for (const t of items) {
      const card = document.createElement("div");
      card.className = "task-card";
      card.dataset.id = t.id;
      card.draggable = true;
      card.innerHTML = taskCardHtml(t);
      card.addEventListener("click", () => {
        if (card._justDragged) { card._justDragged = false; return; }
        openModal(t.id);
      });
      card.addEventListener("dragstart", (e) => {
        dragCard = t.id;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", t.id);
        setTimeout(() => card.classList.add("dragging"), 0);
      });
      card.addEventListener("dragend", () => {
        card.classList.remove("dragging");
        $$(".column.drag-over").forEach((c) => c.classList.remove("drag-over"));
        dragCard = null;
        card._justDragged = true;
        setTimeout(() => { card._justDragged = false; }, 250);
      });
      const hideBtn = card.querySelector(".task-hide");
      if (hideBtn) {
        hideBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          hideTask(t.id);
        });
      }
      body.appendChild(card);
    }
    // drag&drop
    const body2 = body;
    body2.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      col.classList.add("drag-over");
    });
    body2.addEventListener("dragleave", () => col.classList.remove("drag-over"));
    body2.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      col.classList.remove("drag-over");
      const id = e.dataTransfer.getData("text/plain") || dragCard;
      const t = tasks.find((x) => x.id === id);
      if (t && t.status !== status) {
        applyStatusChange(t, status);
      }
    });
    // пустая колонка принимает drop тоже
    col.addEventListener("dragover", (e) => e.preventDefault());
    col.addEventListener("drop", (e) => {
      e.preventDefault();
      // если дропнули на колонку, а не на body
      const id = e.dataTransfer.getData("text/plain") || dragCard;
      const t = tasks.find((x) => x.id === id);
      if (t && t.status !== status) {
        applyStatusChange(t, status);
      }
    });
  }
}

/* ---------- Календарь ---------- */
const MONTHS_RU = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const DAYS_RU = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

function isoOf(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function renderCalendar() {
  const year = calCursor.getFullYear();
  const month = calCursor.getMonth();
  els.calTitle.textContent = `${MONTHS_RU[month]} ${year}`;

  const firstDay = new Date(year, month, 1);
  // пн=0 .. вс=6
  let startOffset = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const tasksByDate = new Map();
  const monthStart = new Date(year, month, 1);
  const monthEnd = new Date(year, month + 1, 0, 23, 59, 59);
  for (const t of tasks) {
    if (t.hidden || !t.due || t.status === "done") continue;
    const dates = occurrenceIsoDates(t, monthStart, monthEnd);
    for (const iso of dates) {
      const arr = tasksByDate.get(iso) || [];
      arr.push(t);
      tasksByDate.set(iso, arr);
    }
  }

  let html = "";
  for (const d of DAYS_RU) html += `<div class="cal-day-head">${d}</div>`;
  for (let i = 0; i < startOffset; i++) html += `<div class="cal-day empty"></div>`;
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = isoOf(year, month, day);
    const list = tasksByDate.get(iso) || [];
    const isToday = iso === todayISO();
    const chipCls = (t) => (iso < todayISO() && t.status !== "done" ? " cal-chip-overdue" : "");
    const chips = list.slice(0, 4)
      .map((t) => `<div class="cal-chip${chipCls(t)}" data-id="${t.id}" style="--chip:${iso < todayISO() && t.status !== "done" ? "var(--danger)" : tagColor(t.tags[0] || "other")}" title="${escapeHtml(t.text)}">${escapeHtml(t.text)}</div>`)
      .join("");
    const extra = list.length > 4 ? `<div class="cal-chip cal-chip-more">+${list.length - 4}</div>` : "";
    html += `
      <div class="cal-day ${isToday ? "today" : ""} ${selectedDate === iso ? "selected" : ""}" data-date="${iso}">
        <div class="cal-num">${day}</div>
        ${list.length ? `<div class="cal-count">${list.length}</div>` : ""}
        <div class="cal-chips">${chips}${extra}</div>
      </div>
    `;
  }
  els.calGrid.innerHTML = html;

  els.calGrid.querySelectorAll(".cal-day[data-date]").forEach((el) => {
    el.addEventListener("click", () => {
      selectedDate = selectedDate === el.dataset.date ? null : el.dataset.date;
      renderCalendar();
    });
    el.querySelectorAll(".cal-chip[data-id]").forEach((chip) => {
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        openModal(chip.dataset.id);
      });
    });
  });
  renderCalendarDetail();
}

function renderCalendarDetail() {
  if (!selectedDate) {
    els.calDetail.innerHTML = `<h3>Выберите день</h3>`;
    return;
  }
  const list = tasks.filter((t) => !t.hidden && t.status !== "done" && taskOccurrencesOnDate(t, selectedDate));
  const d = new Date(selectedDate + "T00:00:00");
  const title = `${DAYS_RU[(d.getDay() + 6) % 7]}, ${d.getDate()} ${MONTHS_RU[d.getMonth()].toLowerCase()} ${d.getFullYear()}`;
  const rows = list.length
    ? list.map((t) => `
        <div class="cal-task" data-id="${t.id}">
          <div>
            <div>${escapeHtml(t.text)}${t.recur ? " <span class='recur-badge' title='Повторяющаяся задача'>↻</span>" : ""}</div>
            <div class="task-meta">${t.tags.map(tagPill).join("")}</div>
          </div>
          <span class="tag tag-other">${STATUS_LABELS[t.status]}</span>
        </div>
      `).join("")
    : `<div class="muted">Задач на этот день нет</div>`;
  els.calDetail.innerHTML = `<h3>${escapeHtml(title)}</h3>${rows}`;
  els.calDetail.querySelectorAll(".cal-task").forEach((el) => {
    el.addEventListener("click", () => openModal(el.dataset.id));
    el.style.cursor = "pointer";
  });
}

function hideTask(id) {
  const t = tasks.find((x) => x.id === id);
  if (!t) return;
  t.hidden = true;
  t.updated = new Date().toISOString();
  renderAll();
  autoSaveFile();
  toast("Карточка скрыта");
}

function unhideAllTasks() {
  let count = 0;
  for (const t of tasks) {
    if (t.hidden) { t.hidden = false; count++; }
  }
  if (count === 0) {
    toast("Скрытых задач нет");
    return;
  }
  renderAll();
  autoSaveFile();
  toast(`Показано скрытых: ${count}`);
}

function updateHiddenIndicator() {
  const hiddenCount = tasks.filter((t) => t.hidden).length;
  const el = document.getElementById("header-hidden-count");
  if (el) el.textContent = hiddenCount ? ` (${hiddenCount})` : "";
  if (els.btnShowHidden) {
    els.btnShowHidden.disabled = hiddenCount === 0;
    els.btnShowHidden.title = hiddenCount
      ? `Показать скрытые (${hiddenCount})`
      : "Скрытых карточек нет";
  }
}

function renderAll() {
  renderStats();
  renderBoard();
  renderCalendar();
  updateHiddenIndicator();
}

/* ---------- Модалка ---------- */
function fillKnownTags() {
  const tags = new Set(["work", "family", "school", "other"]);
  for (const t of tasks) for (const tag of t.tags) tags.add(tag);
  els.knownTags.innerHTML = [...tags].map((t) => `<option value="${escapeHtml(t)}"></option>`).join("");
}

function openModal(id = null) {
  if (id) {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    editingId = t.id;
    els.modalTitle.textContent = "Редактировать задачу";
    els.taskId.value = t.id;
    els.taskText.value = t.text;
    els.taskStatus.value = t.status;
    els.taskDue.value = t.due || "";
    els.taskTags.value = t.tags.join(", ");
    els.taskNotes.value = t.notes;
    if (t.recur) {
      els.taskRecurEnabled.checked = true;
      els.taskRecurEvery.value = String(t.recur.every || 1);
      els.taskRecurUnit.value = t.recur.unit || "day";
      els.taskRecurUntil.value = t.recur.until || "";
    } else {
      els.taskRecurEnabled.checked = false;
      els.taskRecurEvery.value = "1";
      els.taskRecurUnit.value = "week";
      els.taskRecurUntil.value = "";
    }
    syncRecurFieldsVisibility();
    els.taskDelete.classList.remove("hidden");
  } else {
    editingId = null;
    els.modalTitle.textContent = "Новая задача";
    els.taskId.value = "";
    els.taskText.value = "";
    els.taskStatus.value = "todo";
    els.taskDue.value = "";
    els.taskTags.value = "";
    els.taskNotes.value = "";
    els.taskRecurEnabled.checked = false;
    els.taskRecurEvery.value = "1";
    els.taskRecurUnit.value = "week";
    els.taskRecurUntil.value = "";
    syncRecurFieldsVisibility();
    els.taskDelete.classList.add("hidden");
  }
  fillKnownTags();
  els.modal.classList.remove("hidden");
  setTimeout(() => els.taskText.focus(), 30);
}

function closeModal() {
  els.modal.classList.add("hidden");
  editingId = null;
}

async function saveTaskFromForm() {
  const text = els.taskText.value.trim();
  if (!text) {
    toast("Введите название задачи", "err");
    return;
  }
  const due = els.taskDue.value || "";
  const tags = normalizeTags(els.taskTags.value);
  const notes = els.taskNotes.value.trim();
  const recur = readRecurFromForm();
  if (recur && !due) {
    toast("При повторении укажите срок (дедлайн)", "err");
    return;
  }
  const status = normalizeStatus(els.taskStatus.value);
  const existing = editingId ? tasks.find((x) => x.id === editingId) : null;
  const prevStatus = existing ? existing.status : null;

  // переход в done + повторение — спрашиваем про весь цикл или одно событие
  let finalStatus = status;
  let finalRecur = recur;
  let finalDue = due;
  if (status === "done" && recur && prevStatus !== "done") {
    const choice = await askRecurringDone({ text, due, recur });
    if (choice === null) return;  // отмена — ничего не сохраняем
    if (choice === "all") {
      finalRecur = null;
    } else {
      const next = nextOccurrenceDate(due, recur);
      if (!next) {
        finalRecur = null;
      } else {
        finalStatus = "todo";
        finalDue = next;
      }
    }
  }

  if (existing) {
    existing.text = text;
    existing.status = finalStatus;
    existing.due = finalDue;
    existing.tags = tags;
    existing.notes = notes;
    existing.recur = finalRecur;
    existing.updated = new Date().toISOString();
  } else {
    tasks.push({
      id: genId(),
      text,
      status: finalStatus,
      due: finalDue,
      tags,
      notes,
      recur: finalRecur,
      created: todayISO(),
      updated: new Date().toISOString(),
    });
  }
  closeModal();
  renderAll();
  autoSaveFile();
  toast(existing ? "Задача обновлена" : "Задача добавлена");
}

function deleteTask(id) {
  if (!confirm("Удалить задачу?")) return;
  tasks = tasks.filter((t) => t.id !== id);
  closeModal();
  renderAll();
  autoSaveFile();
  toast("Задача удалена");
}

/* ---------- Инициализация / загрузка ---------- */
async function loadTasks() {
  // 1) попробовать файл с File System Access API
  const handle = await loadFileHandle();
  if (handle) {
    try {
      const text = await readFileHandle(handle);
      const parsed = parseJSONL(text);
      tasks = parsed;
      fileHandle = handle;   // ← важно: запомнили handle, чтобы автосохранение было
      setSyncStatus(parsed.length ? "Файл загружен" : "Файл пуст", "ok");
      return;
    } catch (e) {
      console.warn("Ошибка чтения файла:", e);
    }
  }
  // 2) локальное сохранение (localStorage)
  const fromLs = loadLocalStorage();
  if (fromLs && fromLs.length) {
    tasks = fromLs;
    setSyncStatus("Загружено из localStorage", "ok");
    return;
  }
  // 3) пустой начальный
  tasks = [];
  setSyncStatus("Новый список", "");
}

function pickNewest(a, b) {
  // «updated» — ISO-строка; если нет — используем created; при равных/пустых — локальная версия побеждает
  const ta = Date.parse(a.updated || a.created || "") || 0;
  const tb = Date.parse(b.updated || b.created || "") || 0;
  if (ta === tb) return a;               // равный updated → локальная версия
  return ta > tb ? a : b;
}

function mergeTasks(localTasks, remoteTasks) {
  const byId = new Map();
  for (const t of localTasks) byId.set(t.id, t);
  const stats = { added: 0, updated: 0, kept: 0 };
  for (const t of remoteTasks) {
    const local = byId.get(t.id);
    if (!local) { byId.set(t.id, t); stats.added++; continue; }
    const winner = pickNewest(local, t);
    if (winner === t) { byId.set(t.id, t); stats.updated++; }
    else { byId.set(t.id, local); stats.kept++; }
  }
  return { tasks: [...byId.values()], stats };
}


async function autoCheckRemote() {
  // на открытии: только проверяем, есть ли обновления на GitHub — не перезаписываем без спроса
  try {
    const text = await githubPull();
    if (!text) return;
    const remoteTasks = parseJSONL(text);
    const localNorm = JSON.stringify(serializeJSONL(tasks).trim());
    const remoteNorm = JSON.stringify(text.trim());
    if (localNorm === remoteNorm) {
      setSyncStatus("Синхронизировано ✓", "ok");
    } else {
      setSyncStatus("Есть обновления на GitHub 🔄", "warn");
    }
  } catch (e) {
    // отказ в доступе — тихо; локальные данные остаются
  }
}

// единая синхронизация: pull из GitHub (мердж по последнему updated), затем push объединённой версии
async function syncAll() {
  const s = loadSettings();
  setSyncStatus("Синхронизация…", "");
  // 1) pull + merge
  let remoteText;
  try {
    remoteText = await githubPull();
  } catch (e) {
    // pull не удался — НЕ пушим, чтобы не перезаписать чужие изменения молча
    setSyncStatus("Ошибка загрузки", "err");
    toast("Не удалось загрузить из GitHub: " + e.message, "err");
    return;
  }
  if (!remoteText) {
    setSyncStatus("Ошибка загрузки", "err");
    toast("Не удалось загрузить из GitHub", "err");
    return;
  }
  const remoteTasks = parseJSONL(remoteText);
  const { tasks: merged, stats } = mergeTasks(tasks, remoteTasks);
  tasks = merged;
  renderAll();
  autoSaveFile({ silent: true });
  console.log(`merge: added=${stats.added}, updated=${stats.updated}, kept=${stats.kept}`);

  // 2) push
  if (!s.token) {
    // нет токена — скачиваем объединённый файл, пусть пользователь push'нет вручную
    downloadAll();
    setSyncStatus("Загружено — токен не задан", "warn");
    toast(`Загружено — новых: ${stats.added}, обновлено: ${stats.updated}. Токен не задан — файл скачан, сделайте коммит/push вручную`, "err");
    return;
  }
  setSyncStatus("Загрузка на GitHub…", "");
  try {
    await githubPush();
    setSyncStatus("Синхронизировано ✓", "ok");
    toast(`Синхронизировано — новых: ${stats.added}, обновлено из облака: ${stats.updated}, локальные актуальнее: ${stats.kept}`);
  } catch (e) {
    setSyncStatus("Ошибка отправки", "err");
    const hint = /401/.test(e.message)
      ? " — токен невалиден или истёк (⚙ → введите свежий PAT)"
      : /403/.test(e.message)
        ? " — нет прав на репозиторий (проверьте repo и scope PAT в ⚙)"
        : /404/.test(e.message)
          ? " — репозиторий или файл не найден (проверьте repo, branch и file в ⚙)"
          : /422/.test(e.message)
            ? " — проверьте ветку и путь к файлу (⚙)"
            : "";
    toast("Не удалось отправить на GitHub: " + e.message + hint + " (данные уже загружены локально)", "err", 9000);
  }
}

/* ---------- Инициализация UI ---------- */
function setupEvents() {
  // создание задачи
  $("#btn-new").addEventListener("click", () => openModal(null));
  els.taskRecurEnabled.addEventListener("change", syncRecurFieldsVisibility);

  $("#btn-settings").addEventListener("click", () => openSettings());
  $("#btn-file").addEventListener("click", async () => {
    const h = await pickFile();
    if (!h) return;
    fileHandle = h;
    try {
      const text = await readFileHandle(h);
      const parsed = parseJSONL(text);
      tasks = parsed;
      fileHandle = h;
      idbPut(TASK_SELECT_FILE_ACTIVE_KEY, h);
      renderAll();
      autoSaveFile();
      setSyncStatus("Файл загружен", "ok");
      toast("Файл загружен");
    } catch (e) {
      toast("Ошибка чтения файла: " + e.message, "err");
    }
  });
  els.btnShowHidden.addEventListener("click", unhideAllTasks);
  $("#btn-sync").addEventListener("click", () => syncAll());

  // календарь
  $("#cal-prev").addEventListener("click", () => {
    calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() - 1, 1);
    renderCalendar();
  });
  $("#cal-next").addEventListener("click", () => {
    calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 1);
    renderCalendar();
  });

  // форма
  els.taskForm.addEventListener("submit", (e) => {
    e.preventDefault();
    saveTaskFromForm();
  });
  $("#task-cancel").addEventListener("click", closeModal);
  $("#modal-close").addEventListener("click", closeModal);
  {
    const rd = document.getElementById("recur-done-modal");
    if (rd) {
      rd.addEventListener("click", (e) => {
        if (e.target === rd) {
          const cx = document.getElementById("recur-done-cancel-x");
          if (cx) cx.click();
        }
      });
    }
  }
  els.taskDelete.addEventListener("click", () => {
    if (editingId) deleteTask(editingId);
  });
  els.modal.addEventListener("click", (e) => {
    if (e.target === els.modal) closeModal();
  });

  // настройки
  $("#settings-cancel").addEventListener("click", () => els.settingsModal.classList.add("hidden"));
  $("#settings-close").addEventListener("click", () => els.settingsModal.classList.add("hidden"));
  $("#settings-clear-token").addEventListener("click", () => {
    $("#gh-token").value = "";
  });
  els.settingsForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const s = {
      token: $("#gh-token").value.trim(),
      repo: $("#gh-repo").value.trim() || DEFAULT_SETTINGS.repo,
      file: $("#gh-file").value.trim() || "tasks.jsonl",
      branch: $("#gh-branch").value.trim() || "main",
    };
    saveSettings(s);
    els.settingsModal.classList.add("hidden");
    if (s.token && !localStorage.getItem(TOKEN_NOTICE_KEY)) {
      localStorage.setItem(TOKEN_NOTICE_KEY, "1");
      toast("⚠ Токен сохранён в localStorage браузера — он виден через DevTools → Application → Local Storage. Не вставляйте токен в чаты и не коммитьте его в git.", "err", 9000);
    } else {
      toast("Настройки сохранены");
    }
  });
  els.settingsModal.addEventListener("click", (e) => {
    if (e.target === els.settingsModal) els.settingsModal.classList.add("hidden");
  });

  // клавиатура
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const rd = document.getElementById("recur-done-modal");
      if (rd && !rd.classList.contains("hidden")) {
        const cx = document.getElementById("recur-done-cancel-x");
        if (cx) cx.click();
      }
      closeModal();
      els.settingsModal.classList.add("hidden");
    }
    if (e.key === "n" && !isTyping()) openModal(null);
    if (e.key === "s" && !isTyping()) syncAll();
  });
}

function isTyping() {
  const tag = document.activeElement && document.activeElement.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function openSettings() {
  const s = loadSettings();
  $("#gh-token").value = s.token;
  $("#gh-repo").value = s.repo;
  $("#gh-file").value = s.file;
  $("#gh-branch").value = s.branch;
  els.settingsModal.classList.remove("hidden");
}

async function init() {
  setupEvents();
  await loadTasks();
  renderAll();
  // при открытии страницы — тихо проверяем наличие обновлений на GitHub (без перезаписи)
  autoCheckRemote().catch(() => {});
}

document.addEventListener("DOMContentLoaded", init);
