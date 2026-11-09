import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, onSnapshot, addDoc, updateDoc, deleteDoc, setDoc, getDoc, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { ALLOWED_DOMAIN, ADMIN_EMAILS, FIREBASE_CONFIG } from "./config.js";

/* ---------- Constants ---------- */
const STATUSES = [
  { k: "todo", l: "To Do", c: "var(--todo)" },
  { k: "progress", l: "In Progress", c: "var(--progress)" },
  { k: "review", l: "In Review", c: "var(--review)" },
  { k: "done", l: "Done", c: "var(--done)" },
];
const PRIS = [
  { k: "P1", l: "P1 · Urgent" }, { k: "P2", l: "P2 · High" },
  { k: "P3", l: "P3 · Normal" }, { k: "P4", l: "P4 · Low" },
];
const TYPES = ["QA Test", "Bug Verification", "Release Testing", "General To-do"];
const ROLES = [{ k: "member", l: "Member" }, { k: "admin", l: "Admin" }, { k: "disabled", l: "Disabled" }];
const VIEWS = ["board", "week", "calendar", "all", "team"];
const S = Object.fromEntries(STATUSES.map(s => [s.k, s]));
const $ = id => document.getElementById(id);

/* ---------- State ---------- */
let fs, auth, me = null, meRole = "member";
let tasks = [], users = {}, loaded = false;
let unsubs = [];
let view = "board", filters = { q: "", type: "", owner: "", mine: false }, sort = { k: "due", dir: 1 };
let calMonth = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })();
let editing = null;

const isAdmin = () => meRole === "admin" || ADMIN_EMAILS.map(e => e.toLowerCase()).includes((me?.email || "").toLowerCase());
const canDelete = t => isAdmin() || t.createdBy === me?.uid;

/* ---------- DOM helper (textContent only — no innerHTML with user data) ---------- */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) { if (c == null || c === false) continue; el.append(c.nodeType ? c : document.createTextNode(String(c))); }
  return el;
}

/* ---------- Dates (local, YYYY-MM-DD) ---------- */
const pad = n => String(n).padStart(2, "0");
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayIso = () => iso(new Date());
function weekRange() {
  const d = new Date(), off = (d.getDay() + 6) % 7;
  const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - off);
  const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
  return [iso(mon), iso(sun)];
}
const fmtDate = s => new Date(s + "T00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" });
const fmtDay = s => new Date(s + "T00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
const fmtTs = ts => ts?.toDate ? ts.toDate().toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
const isOpen = t => t.status !== "done";
const isOver = t => t.due && isOpen(t) && t.due < todayIso();

/* ---------- Small UI bits ---------- */
const userName = uid => users[uid]?.name || users[uid]?.email || (uid === me?.uid ? "You" : "Former member");
function avatar(uid, size = 20) {
  const u = users[uid];
  if (u?.photoURL) return h("img", { src: u.photoURL, alt: "", width: size, height: size, referrerpolicy: "no-referrer" });
  const initials = (u?.name || u?.email || "?").split(/[\s.@]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("");
  return h("span", { class: "ini", style: `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px`, "aria-hidden": "true" }, initials);
}
function dueEl(t) {
  if (!t.due) return null;
  const td = todayIso();
  const cls = isOver(t) ? "due over" : (t.due === td && isOpen(t)) ? "due today" : "due";
  return h("span", { class: cls, title: "Due date" }, isOver(t) ? "Overdue · " + fmtDate(t.due) : t.due === td ? "Today" : fmtDate(t.due));
}
const priEl = t => { const p = t.priority || "P3"; return h("span", { class: "pill pri " + p, title: (PRIS.find(x => x.k === p) || {}).l }, p); };
function ownerEl(uid, showName = true) {
  if (!uid) return h("span", { class: "owner", style: "color:var(--muted)" }, "Unassigned");
  const nm = userName(uid);
  return h("span", { class: "owner", title: nm }, avatar(uid), showName ? h("span", {}, nm) : null);
}
const statusEl = k => { const s = S[k] || S.todo; return h("span", { class: "status" }, h("span", { class: "dot", style: "background:" + s.c }), s.l); };
function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("on"), 2000); }
function note(msg) { const n = $("note"); n.textContent = msg || ""; n.hidden = !msg; }
function fillSelect(el, opts) { el.replaceChildren(...opts.map(o => h("option", { value: o.k ?? o }, o.l ?? o))); }
function showScreen(id) { for (const s of ["bootScreen", "loginScreen", "blockedScreen", "appScreen"]) $(s).hidden = s !== id; }

function visible() {
  const q = filters.q.trim().toLowerCase();
  return tasks.filter(t =>
    (!filters.type || t.type === filters.type) &&
    (!filters.mine || t.ownerId === me?.uid) &&
    (!filters.owner || (filters.owner === "_none" ? !t.ownerId : t.ownerId === filters.owner)) &&
    (!q || (t.title || "").toLowerCase().includes(q) || (t.notes || "").toLowerCase().includes(q)));
}
const activeUsers = () => Object.values(users).filter(u => u.role !== "disabled").sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));

/* ---------- Render ---------- */
function paint() {
  document.querySelectorAll("nav.tabs a").forEach(a => {
    if (a.getAttribute("href") === "#" + view) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  $("teamTab").hidden = !isAdmin();
  $("filters").hidden = view === "team";
  $("newBtnM").hidden = view === "team" || view === "calendar"; // mobile-only button; calendar adds tasks from the day popup
  if ($("dayDlg").open) renderDay(); // keep the day popup in sync with live updates
  const [ws, we] = weekRange(), open = tasks.filter(isOpen);
  const stats = [
    ["Open", open.length],
    ["In review", tasks.filter(t => t.status === "review").length],
    ["Due this week", open.filter(t => t.due && t.due >= ws && t.due <= we).length],
    ["Overdue", open.filter(isOver).length, true],
  ];
  $("stats").replaceChildren(...stats.map(([l, n, w]) => h("span", { class: "stat" + (w && n ? " warn" : "") }, h("b", {}, n), l)));

  // owner filter options (keep selection)
  const cur = filters.owner;
  fillSelect($("ownerF"), [{ k: "", l: "All owners" }, { k: "_none", l: "Unassigned" }, ...activeUsers().map(u => ({ k: u.uid, l: u.name || u.email }))]);
  $("ownerF").value = cur;

  const v = $("view");
  if (view === "team") { v.replaceChildren(isAdmin() ? renderTeam() : h("p", {}, "Only admins can manage the team.")); return; }
  if (!loaded) { v.replaceChildren(h("div", { class: "empty" }, h("p", {}, "Loading tasks…"))); return; }
  if (!tasks.length) {
    v.replaceChildren(h("div", { class: "empty" }, h("h2", {}, "No tasks yet"),
      h("p", {}, "Add the first one: a sanity test, a bug to verify, a release check or a general to-do. Everyone on the team sees the same board."),
      h("button", { class: "btn primary", type: "button", onclick: () => openEditor() }, "+ New task")));
    return;
  }
  v.replaceChildren(({ board: renderBoard, week: renderWeek, calendar: renderCal, all: renderTable })[view]());
}

function renderBoard() {
  const list = visible();
  const prOrder = t => ({ P1: 1, P2: 2, P3: 3, P4: 4 })[t.priority || "P3"];
  const cols = STATUSES.map(s => {
    const items = list.filter(t => (t.status || "todo") === s.k)
      .sort((a, b) => prOrder(a) - prOrder(b) || (a.due || "9999").localeCompare(b.due || "9999"));
    const col = h("section", { class: "col", "aria-label": s.l },
      h("div", { class: "col-h" }, h("span", { class: "dot", style: "background:" + s.c }), s.l, h("span", { class: "n" }, items.length),
        h("button", { class: "add", type: "button", title: "Add to " + s.l, "aria-label": "Add task to " + s.l, onclick: () => openEditor(null, s.k) }, "+")),
      items.length ? items.map(card) : h("div", { class: "empty-col" }, "Drop a card here"));
    col.addEventListener("dragover", e => { e.preventDefault(); col.classList.add("over"); });
    col.addEventListener("dragleave", () => col.classList.remove("over"));
    col.addEventListener("drop", e => { e.preventDefault(); col.classList.remove("over"); moveTask(e.dataTransfer.getData("text/plain"), s.k); });
    return col;
  });
  return h("div", { class: "board-scroll" }, h("div", { class: "board" }, cols));
}
function card(t) {
  const c = h("button", { type: "button", class: "card" + (t.status === "done" ? " is-done" : ""), draggable: "true", onclick: () => openEditor(t) },
    h("div", { class: "t" }, t.title || "Untitled"),
    h("div", { class: "meta" }, priEl(t), h("span", { class: "pill" }, t.type || "General To-do"), dueEl(t), ownerEl(t.ownerId, false)));
  c.addEventListener("dragstart", e => { e.dataTransfer.setData("text/plain", t.id); c.classList.add("dragging"); });
  c.addEventListener("dragend", () => c.classList.remove("dragging"));
  return c;
}

function renderWeek() {
  const list = visible().filter(isOpen), td = todayIso(), [, we] = weekRange();
  const groups = [
    ["Overdue", list.filter(isOver)],
    ["Today", list.filter(t => t.due === td)],
    ["Later this week", list.filter(t => t.due > td && t.due <= we)],
    ["No due date", list.filter(t => !t.due)],
  ];
  return h("div", { class: "week" }, groups.map(([title, items]) => h("section", {},
    h("h2", {}, title, h("span", { class: "n" }, items.length)),
    h("div", { class: "list" }, items.length ? items.sort((a, b) => (a.due || "").localeCompare(b.due || "")).map(t =>
      h("button", { type: "button", class: "li", onclick: () => openEditor(t) },
        h("span", { class: "dot", style: "background:" + (S[t.status] || S.todo).c, title: (S[t.status] || S.todo).l }),
        h("div", { style: "min-width:0" }, h("div", { class: "t" }, t.title || "Untitled"),
          h("div", { class: "sub" }, statusEl(t.status), "·", t.type || "General To-do", t.due ? "· " + fmtDay(t.due) : null)),
        h("div", { class: "li-right" }, priEl(t), ownerEl(t.ownerId)))) : h("div", { class: "none" }, "Nothing here.")))));
}

function renderCal() {
  const list = visible().filter(t => t.due), y = calMonth.getFullYear(), m = calMonth.getMonth();
  const first = new Date(y, m, 1), start = new Date(y, m, 1 - ((first.getDay() + 6) % 7)), td = todayIso();
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i), k = iso(d);
    if (i === 35 && d.getMonth() !== m) break;
    const items = list.filter(t => t.due === k);
    // On phones the whole date cell is tappable and opens the day popup.
    const tap = isMobile() ? {
      role: "button", tabindex: "0", "aria-label": fmtLong(k) + (items.length ? ` · ${items.length} task${items.length > 1 ? "s" : ""}` : " · no tasks"),
      onclick: () => openDay(k), onkeydown: e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDay(k); } },
    } : {};
    cells.push(h("div", { class: "cell" + (d.getMonth() !== m ? " out" : "") + (k === td ? " today" : ""), ...tap }, h("span", { class: "d" }, d.getDate()),
      items.map(t => h("button", { type: "button", class: "ev" + (t.status === "done" ? " is-done" : ""), title: t.title, onclick: () => openEditor(t) },
        h("span", { class: "dot", style: "background:" + (S[t.status] || S.todo).c }), h("span", {}, t.title || "Untitled")))));
  }
  const shift = n => { calMonth = new Date(y, m + n, 1); paint(); };
  return h("div", {}, h("div", { class: "cal-head" },
    h("button", { class: "btn", type: "button", "aria-label": "Previous month", onclick: () => shift(-1) }, "←"),
    h("h2", {}, first.toLocaleDateString("en-IN", { month: "long", year: "numeric" })),
    h("button", { class: "btn", type: "button", "aria-label": "Next month", onclick: () => shift(1) }, "→"),
    h("button", { class: "btn", type: "button", onclick: () => { const d = new Date(); calMonth = new Date(d.getFullYear(), d.getMonth(), 1); paint(); } }, "Today")),
    h("div", { class: "cal-scroll" }, h("div", { class: "cal" }, ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(d => h("div", { class: "dow" }, d)), cells)));
}

/* ---------- Day popup (mobile calendar) ---------- */
const mobileMq = matchMedia("(max-width:640px)");
const isMobile = () => mobileMq.matches;
mobileMq.addEventListener("change", () => { if (me) paint(); });
const fmtLong = s => new Date(s + "T00:00").toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
let dayKey = null;
function openDay(k) { dayKey = k; renderDay(); $("dayDlg").showModal(); }
function renderDay() {
  const k = dayKey, items = visible().filter(t => t.due === k)
    .sort((a, b) => ({ P1: 1, P2: 2, P3: 3, P4: 4 })[a.priority || "P3"] - ({ P1: 1, P2: 2, P3: 3, P4: 4 })[b.priority || "P3"]);
  const wd = new Date(k + "T00:00").toLocaleDateString("en-IN", { weekday: "long" });
  $("dayTitle").textContent = fmtLong(k);
  $("daySub").textContent = wd + (k === todayIso() ? " · Today" : "") + " · " + (items.length ? `${items.length} task${items.length > 1 ? "s" : ""}` : "No tasks");
  $("dayList").replaceChildren(items.length
    ? h("div", { class: "list" }, items.map(t => h("button", { type: "button", class: "li", onclick: () => { $("dayDlg").close(); openEditor(t); } },
        h("span", { class: "dot", style: "background:" + (S[t.status] || S.todo).c, title: (S[t.status] || S.todo).l }),
        h("div", { style: "min-width:0" }, h("div", { class: "t" + (t.status === "done" ? " is-done" : "") }, t.title || "Untitled"),
          h("div", { class: "sub" }, statusEl(t.status), "·", t.type || "General To-do")),
        h("div", { class: "li-right" }, priEl(t), ownerEl(t.ownerId)))))
    : h("p", { class: "day-empty" }, "No tasks available"));
  $("dayAdd").textContent = items.length ? "+ Add another task" : "+ Create new task";
}
$("dayAdd").onclick = () => { $("dayDlg").close(); openEditor(null, null, dayKey); };
$("dayClose").onclick = () => $("dayDlg").close();
$("dayDlg").addEventListener("click", e => { if (e.target === $("dayDlg")) $("dayDlg").close(); }); // tap outside closes

function renderTable() {
  const cols = [["title", "Task"], ["status", "Status"], ["priority", "Priority"], ["type", "Type"], ["owner", "Owner"], ["due", "Due"]];
  const sIdx = k => STATUSES.findIndex(s => s.k === k);
  const key = (t, k) => k === "status" ? sIdx(t.status) : k === "owner" ? (t.ownerId ? userName(t.ownerId).toLowerCase() : "~")
    : k === "due" ? (t.due || "9999") : k === "priority" ? (t.priority || "P3") : (t[k] || "").toLowerCase();
  const rows = visible().sort((a, b) => { const x = key(a, sort.k), y = key(b, sort.k); return (x > y ? 1 : x < y ? -1 : 0) * sort.dir; });
  return h("div", { class: "tbl-scroll" }, h("table", {},
    h("thead", {}, h("tr", {}, cols.map(([k, l]) => h("th", {}, h("button", {
      type: "button", "aria-sort": sort.k === k ? (sort.dir > 0 ? "ascending" : "descending") : null,
      onclick: () => { sort = sort.k === k ? { k, dir: -sort.dir } : { k, dir: 1 }; paint(); },
    }, l))))),
    h("tbody", {}, rows.length ? rows.map(t => h("tr", { onclick: () => openEditor(t) },
      h("td", { class: "t" }, t.title || "Untitled"), h("td", {}, statusEl(t.status)), h("td", {}, priEl(t)), h("td", {}, t.type || "General To-do"),
      h("td", {}, ownerEl(t.ownerId)), h("td", {}, t.due ? h("span", { class: isOver(t) ? "due over" : "due" }, fmtDate(t.due)) : "—")))
      : h("tr", {}, h("td", { colspan: 6, style: "color:var(--muted)" }, "No tasks match these filters.")))));
}

function renderTeam() {
  const list = Object.values(users).sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
  const openCount = uid => tasks.filter(t => t.ownerId === uid && isOpen(t)).length;
  return h("div", {},
    h("div", { class: "team-head" }, h("h2", {}, "Team"),
      h("p", {}, `${list.length} people have signed in. New people join as Members the first time they sign in with a @${ALLOWED_DOMAIN} account.`)),
    h("div", { class: "tbl-scroll" }, h("table", { class: "team" },
      h("thead", {}, h("tr", {}, ["Person", "Role", "Open tasks", "Last sign-in"].map(l => h("th", {}, l)))),
      h("tbody", {}, list.map(u => {
        const self = u.uid === me.uid;
        const pinned = ADMIN_EMAILS.map(e => e.toLowerCase()).includes((u.email || "").toLowerCase());
        const sel = h("select", { "aria-label": "Role for " + (u.name || u.email), disabled: self || pinned ? true : null });
        fillSelect(sel, ROLES); sel.value = pinned ? "admin" : (u.role || "member");
        sel.addEventListener("change", async () => {
          try { await updateDoc(doc(fs, "users", u.uid), { role: sel.value }); toast(`${u.name || u.email} is now ${sel.value}`); }
          catch (e) { sel.value = u.role || "member"; toast(errMsg(e)); }
        });
        return h("tr", { class: u.role === "disabled" ? "is-disabled" : null },
          h("td", {}, h("div", { class: "person" }, avatar(u.uid, 26),
            h("div", { style: "min-width:0" }, h("div", {}, u.name || "—", self ? " (you)" : ""), h("div", { class: "em" }, u.email)))),
          h("td", {}, sel, pinned ? h("div", { class: "fine" }, "Built-in admin") : null),
          h("td", {}, openCount(u.uid)),
          h("td", {}, fmtTs(u.lastLogin)));
      })))));
}

/* ---------- Writes ---------- */
function errMsg(e) {
  const c = e?.code || "";
  if (c.includes("permission-denied")) return "You don't have permission to do that.";
  if (c.includes("unavailable")) return "You're offline. Changes will sync when you reconnect.";
  return "Couldn't save. Try again in a moment.";
}
async function moveTask(id, status) {
  const t = tasks.find(x => x.id === id);
  if (!t || t.status === status) return;
  const patch = { status, updatedAt: serverTimestamp(), updatedBy: me.uid };
  if (status === "done") patch.doneAt = serverTimestamp();
  try { await updateDoc(doc(fs, "tasks", id), patch); toast("Moved to " + S[status].l); } catch (e) { toast(errMsg(e)); }
}

/* ---------- Editor ---------- */
fillSelect($("fStatus"), STATUSES); fillSelect($("fPri"), PRIS); fillSelect($("fType"), TYPES);
fillSelect($("typeF"), [{ k: "", l: "All types" }, ...TYPES]);

function openEditor(t, status, due) {
  editing = t || null;
  $("edTitle").textContent = t ? "Edit task" : "New task";
  $("fTitle").value = t?.title || "";
  $("fStatus").value = t?.status || status || "todo";
  $("fPri").value = t?.priority || "P3";
  $("fType").value = t?.type || "QA Test";
  $("fDue").value = t ? (t.due || "") : (due || todayIso());
  $("fNotes").value = t?.notes || "";
  const opts = [{ k: "", l: "Unassigned" }, ...activeUsers().map(u => ({ k: u.uid, l: (u.name || u.email) + (u.uid === me.uid ? " (me)" : "") }))];
  if (t?.ownerId && !opts.some(o => o.k === t.ownerId)) opts.push({ k: t.ownerId, l: userName(t.ownerId) });
  fillSelect($("fOwner"), opts);
  $("fOwner").value = t ? (t.ownerId || "") : me.uid;
  const meta = $("edMeta");
  meta.hidden = !t;
  if (t) meta.textContent = `Created by ${userName(t.createdBy)} · ${fmtTs(t.createdAt)}` + (t.updatedAt ? ` · Last updated ${fmtTs(t.updatedAt)}` : "");
  $("edErr").hidden = true;
  const del = $("delBtn");
  del.hidden = !t || !canDelete(t); del.classList.remove("armed"); del.textContent = "Delete";
  $("dlg").showModal(); $("fTitle").focus();
}
$("cancelBtn").onclick = () => $("dlg").close();
$("newBtn").onclick = () => openEditor();
$("newBtnM").onclick = () => openEditor(); // mobile-only copy, shown above the board
$("delBtn").onclick = async () => {
  const b = $("delBtn");
  if (!b.classList.contains("armed")) { b.classList.add("armed"); b.textContent = "Confirm delete"; return; }
  try { await deleteDoc(doc(fs, "tasks", editing.id)); $("dlg").close(); toast("Task deleted"); }
  catch (e) { $("edErr").textContent = errMsg(e); $("edErr").hidden = false; }
};
$("ed").addEventListener("submit", async e => {
  e.preventDefault();
  const title = $("fTitle").value.trim();
  if (!title) { $("edErr").textContent = "Give the task a name."; $("edErr").hidden = false; $("fTitle").focus(); return; }
  const status = $("fStatus").value;
  const body = {
    title, status, priority: $("fPri").value, type: $("fType").value,
    due: $("fDue").value || "", ownerId: $("fOwner").value || "", notes: $("fNotes").value.trim(),
    updatedAt: serverTimestamp(), updatedBy: me.uid,
  };
  if (status === "done" && (!editing || editing.status !== "done")) body.doneAt = serverTimestamp();
  const btn = $("saveBtn"); btn.disabled = true;
  try {
    if (editing) await updateDoc(doc(fs, "tasks", editing.id), body);
    else await addDoc(collection(fs, "tasks"), { ...body, createdBy: me.uid, createdAt: serverTimestamp() });
    $("dlg").close(); toast(editing ? "Task saved" : "Task added");
  } catch (err) { $("edErr").textContent = errMsg(err); $("edErr").hidden = false; }
  finally { btn.disabled = false; }
});

/* ---------- Filters + routing ---------- */
$("q").addEventListener("input", e => { filters.q = e.target.value; paint(); });
$("typeF").addEventListener("change", e => { filters.type = e.target.value; paint(); });
$("ownerF").addEventListener("change", e => { filters.owner = e.target.value; paint(); });
$("mineF").addEventListener("change", e => {
  filters.mine = e.target.checked; paint();
  try { localStorage.setItem("qa-board-mine", filters.mine ? "1" : ""); } catch { }
});
try { if (localStorage.getItem("qa-board-mine")) { filters.mine = true; $("mineF").checked = true; } } catch { }
function route() { const v = location.hash.slice(1); view = VIEWS.includes(v) ? v : "board"; if (me) paint(); }
window.addEventListener("hashchange", route);

/* ---------- Auth ---------- */
function stopListeners() { unsubs.forEach(u => u()); unsubs = []; tasks = []; users = {}; loaded = false; }

async function onSignedIn(u) {
  const email = (u.email || "").toLowerCase();
  const okDomain = domainOk(email);
  if (!okDomain || !u.emailVerified) {
    const msg = okDomain
      ? "Your email isn't verified yet. Try signing in again."
      : `Only @${ALLOWED_DOMAIN} accounts can use the QA Task Board. ${u.email || "That account"} isn't allowed. Sign in with your company account.`;
    pendingLoginMsg = msg; // shown by the signed-out callback too, so it isn't wiped
    // Remove the stray Firebase Auth record so outside accounts don't pile up in the user list.
    if (!okDomain) { try { await u.delete(); } catch { } }
    try { await signOut(auth); } catch { }
    showLogin(msg);
    return;
  }
  me = u;
  // Create or refresh this person's profile.
  const ref = doc(fs, "users", u.uid);
  try {
    const snap = await getDoc(ref);
    const profile = { uid: u.uid, email, name: u.displayName || email, photoURL: u.photoURL || "", lastLogin: serverTimestamp() };
    if (!snap.exists()) await setDoc(ref, { ...profile, role: "member", createdAt: serverTimestamp() });
    else await updateDoc(ref, { name: profile.name, photoURL: profile.photoURL, lastLogin: profile.lastLogin });
  } catch (e) {
    console.error(e);
    pendingLoginMsg = "Couldn't set up your account. Check that Firestore rules are deployed, then try again.";
    await signOut(auth);
    showLogin(pendingLoginMsg);
    return;
  }

  unsubs.push(onSnapshot(ref, s => {
    const d = s.data() || {};
    meRole = d.role || "member";
    if (meRole === "disabled" && !isAdmin()) { stopTaskListeners(); showScreen("blockedScreen"); return; }
    if ($("appScreen").hidden) startApp();
    $("meRole").textContent = isAdmin() ? "Admin" : "Member";
    $("meRole").className = "role" + (isAdmin() ? " admin" : "");
    paint();
  }));
}

let taskUnsubs = [];
function stopTaskListeners() { taskUnsubs.forEach(u => u()); taskUnsubs = []; }
function startApp() {
  showScreen("appScreen");
  $("meName").textContent = me.displayName || me.email;
  const av = $("meAvatar"); av.src = me.photoURL || ""; av.hidden = !me.photoURL;
  stopTaskListeners();
  const timer = setTimeout(() => { if (!loaded) note("Still connecting to the task database…"); }, 10000);
  taskUnsubs.push(onSnapshot(collection(fs, "tasks"), snap => {
    tasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (!loaded) { loaded = true; clearTimeout(timer); note(""); }
    if (editing && $("dlg").open) { const f = tasks.find(t => t.id === editing.id); if (f) editing = f; }
    paint();
  }, err => { clearTimeout(timer); loaded = true; note(errMsg(err)); paint(); }));
  taskUnsubs.push(onSnapshot(collection(fs, "users"), snap => {
    users = Object.fromEntries(snap.docs.map(d => [d.id, { uid: d.id, ...d.data() }]));
    paint();
  }, err => console.error(err)));
  route();
}

function showLogin(msg) {
  stopTaskListeners(); stopListeners(); me = null; meRole = "member";
  if ($("dlg").open) $("dlg").close();
  if ($("dayDlg").open) $("dayDlg").close();
  loginError(msg);
  setEmailMode();
  showScreen("loginScreen");
}
function loginError(msg) { $("loginErr").textContent = msg || ""; $("loginErr").hidden = !msg; }

/* ---------- Email link sign-in ---------- */
const EMAIL_KEY = "qa-signin-email";
const domainOk = e => e.endsWith("@" + ALLOWED_DOMAIN.toLowerCase());
const emailShape = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
let pendingLoginMsg = "";
let finishingLink = false; // a sign-in link was opened on a device that doesn't remember the email

function setEmailMode() {
  $("emailBtn").textContent = finishingLink ? "Finish signing in" : "Email me a sign-in link";
  $("emailHint").hidden = !finishingLink;
}
function linkErr(e) {
  const c = e?.code || "";
  if (c === "auth/invalid-action-code" || c === "auth/expired-action-code") return "This sign-in link has expired or was already used. Request a new one below.";
  if (c === "auth/invalid-email") return "That email doesn't match the one the link was sent to.";
  if (c === "auth/operation-not-allowed") return "Email sign-in isn't turned on yet. Ask your admin to enable it in Firebase, or sign in with Google.";
  if (c === "auth/quota-exceeded" || c === "auth/too-many-requests") return "Too many sign-in emails were sent. Try again later, or sign in with Google.";
  if (c === "auth/network-request-failed") return "You're offline. Check your connection and try again.";
  return "Couldn't sign in with email. Try again, or sign in with Google.";
}
const clearLinkFromUrl = () => history.replaceState(null, "", location.pathname + location.hash);

$("emailForm").addEventListener("submit", async e => {
  e.preventDefault();
  loginError(""); pendingLoginMsg = "";
  const email = $("emailIn").value.trim().toLowerCase();
  // Check the domain here, before anything is sent.
  if (!emailShape(email)) { loginError("Enter a valid email address."); $("emailIn").focus(); return; }
  if (!domainOk(email)) { loginError(`Only @${ALLOWED_DOMAIN} emails can sign in. ${email} isn't allowed.`); $("emailIn").focus(); return; }
  const btn = $("emailBtn"); btn.disabled = true;
  try {
    if (finishingLink) {
      await signInWithEmailLink(auth, email, location.href);
      finishingLink = false; clearLinkFromUrl();
      return;
    }
    await sendSignInLinkToEmail(auth, email, { url: location.origin + location.pathname, handleCodeInApp: true });
    try { localStorage.setItem(EMAIL_KEY, email); } catch { }
    $("sentTo").textContent = email;
    $("emailForm").hidden = true; $("emailSent").hidden = false;
  } catch (err) { loginError(linkErr(err)); }
  finally { btn.disabled = false; }
});
$("emailAgain").onclick = () => { $("emailSent").hidden = true; $("emailForm").hidden = false; loginError(""); $("emailIn").focus(); };

$("googleBtn").onclick = async () => {
  $("loginErr").hidden = true; pendingLoginMsg = "";
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ hd: ALLOWED_DOMAIN, prompt: "select_account" });
  try { await signInWithPopup(auth, provider); }
  catch (e) {
    if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") return;
    $("loginErr").textContent = e.code === "auth/popup-blocked" ? "Your browser blocked the sign-in window. Allow pop-ups for this site and try again." : "Sign-in failed. Try again.";
    $("loginErr").hidden = false;
  }
};
$("signOutBtn").onclick = () => { pendingLoginMsg = ""; signOut(auth); };
$("blockedSignOut").onclick = () => { pendingLoginMsg = ""; signOut(auth); };

/* ---------- Boot ---------- */
(async () => {
  $("domainNote").textContent = `Only @${ALLOWED_DOMAIN} accounts can sign in.`;
  let cfg = FIREBASE_CONFIG;
  if (!cfg) {
    try { const r = await fetch("/__/firebase/init.json"); if (r.ok) cfg = await r.json(); } catch { }
  }
  if (!cfg) {
    showScreen("loginScreen");
    $("googleBtn").disabled = true;
    $("loginErr").textContent = "Firebase isn't configured. Deploy to Firebase Hosting, or paste your web config into config.js.";
    $("loginErr").hidden = false;
    return;
  }
  const app = initializeApp(cfg);
  auth = getAuth(app);
  fs = getFirestore(app);
  // Opened from an email sign-in link: finish signing in before showing anything.
  if (isSignInWithEmailLink(auth, location.href)) {
    let email = null;
    try { email = localStorage.getItem(EMAIL_KEY); } catch { }
    if (email) {
      try { await signInWithEmailLink(auth, email, location.href); try { localStorage.removeItem(EMAIL_KEY); } catch { } }
      catch (e) { pendingLoginMsg = linkErr(e); }
      clearLinkFromUrl();
    } else {
      finishingLink = true; // different device/browser: ask for the email on the login screen
    }
  }
  // pendingLoginMsg stays until the next sign-in attempt, so repeated signed-out events can't wipe it.
  onAuthStateChanged(auth, u => { if (u) onSignedIn(u); else showLogin(pendingLoginMsg); });
})();
