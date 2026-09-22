/**
 * Memory Palace web UI.
 *
 * Vanilla ES modules, no build step and no dependencies — the same reasoning as
 * the rest of the project: this is a local admin surface for one person, and a
 * bundler would add a toolchain to maintain for no benefit.
 *
 * Security note: everything rendered here is user data. Every interpolation
 * goes through `esc()`; there is no `innerHTML` on an unescaped value anywhere.
 */

const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

/** Escape for both element content and quoted attribute values. */
function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

const STATE = {
  view: "memories",
  memories: [],
  pending: [],
  stats: null,
  priorArt: [],
  loading: false,
  selected: null,
  lastFocus: null,
}

// ---------------------------------------------------------------- transport --

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: options.body ? { "content-type": "application/json" } : undefined,
    ...options,
  })
  const text = await response.text()
  let payload
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = { error: { message: text } }
  }
  if (!response.ok) {
    const message = payload?.error?.message ?? `request failed (${response.status})`
    throw new Error(message)
  }
  return payload
}

// ------------------------------------------------------------------ toasts --

function toast(message, tone = "info") {
  const el = document.createElement("div")
  el.className = "toast"
  el.dataset.tone = tone
  el.textContent = message
  $("#toasts").append(el)
  // Long enough to read a sentence, short enough not to linger.
  setTimeout(() => el.remove(), tone === "error" ? 6000 : 3500)
}

function reportError(error) {
  toast(error instanceof Error ? error.message : String(error), "error")
}

// ------------------------------------------------------------------ format --

const TYPE_LABEL = {
  goal: "Goal",
  preference: "Preference",
  fact: "Fact",
  decision: "Decision",
  relationship: "Relationship",
  experience: "Experience",
  event: "Event",
}

const STATUS_LABEL = {
  active: "current",
  pending: "needs review",
  superseded: "no longer true",
  archived: "archived",
}

const month = (iso) => (iso ? String(iso).slice(0, 7) : null)

/** Render a validity window. An open end is "now", not today's date. */
function validity(memory) {
  const from = month(memory.validFrom)
  const until = month(memory.validUntil)
  if (from && until) return `${from} → ${until}`
  if (from) return `${from} → now`
  if (until) return `until ${until}`
  return ""
}

const isHistorical = (memory) => memory.status !== "active" && memory.status !== "pending"

function setBusy(el, busy) {
  el.setAttribute("aria-busy", String(busy))
  if (busy) {
    el.innerHTML = Array.from({ length: 3 }, () => '<div class="skeleton"></div>').join("")
  }
}

function emptyState(title, body, action = "") {
  return `<div class="empty"><h3>${esc(title)}</h3><p>${esc(body)}</p>${action}</div>`
}

// ------------------------------------------------------------------ render --

function memoryCard(memory, { actions = "" } = {}) {
  const historical = isHistorical(memory)
  return `
    <article class="item ${historical ? "item--historical" : ""}" data-id="${esc(memory.id)}" data-status="${esc(memory.status)}">
      <div class="item__main">
        <p class="item__content">${esc(memory.content)}</p>
        <div class="item__meta">
          <span class="chip chip--type">${esc(TYPE_LABEL[memory.type] ?? memory.type)}</span>
          ${
            memory.status !== "active"
              ? `<span class="chip ${memory.status === "pending" ? "chip--warn" : ""}">${esc(STATUS_LABEL[memory.status] ?? memory.status)}</span>`
              : ""
          }
          ${validity(memory) ? `<span>${esc(validity(memory))}</span>` : ""}
          <span title="How sure the system is that this is true">confidence ${memory.confidence.toFixed(2)}</span>
          ${memory.reinforcedCount > 0 ? `<span>observed ${memory.reinforcedCount}×</span>` : ""}
        </div>
      </div>
      <div class="item__actions">${actions}</div>
    </article>
  `
}

function renderMemories() {
  const el = $("#memories-list")
  if (STATE.memories.length === 0) {
    el.innerHTML = emptyState(
      "Nothing here yet",
      "Use the box above to write something worth remembering. Memories appear once the system has decided what is durable; transient remarks are deliberately dropped.",
    )
    return
  }
  el.innerHTML = STATE.memories
    .map((m) =>
      memoryCard(m, `<button type="button" class="btn btn--sm" data-action="detail" data-id="${esc(m.id)}">Details</button>`),
    )
    .join("")
}

function renderPending() {
  const el = $("#pending-list")
  if (STATE.pending.length === 0) {
    el.innerHTML = emptyState(
      "Nothing needs review",
      "Memories land here when they conflict with something already known, or when the writing agent is not trusted for that kind of memory.",
    )
    return
  }
  el.innerHTML = STATE.pending
    .map((m) =>
      memoryCard(m, `
        <button type="button" class="btn btn--sm btn--primary" data-action="confirm" data-id="${esc(m.id)}">Confirm</button>
        <button type="button" class="btn btn--sm btn--danger" data-action="reject" data-id="${esc(m.id)}">Reject</button>
        <button type="button" class="btn btn--sm" data-action="detail" data-id="${esc(m.id)}">Details</button>
      `),
    )
    .join("")
}

async function renderTimeline() {
  const el = $("#timeline-list")
  setBusy(el, true)
  const { memories } = await api("/api/timeline")
  if (memories.length === 0) {
    el.innerHTML = emptyState("No history yet", "Once memories are recorded, this shows when each was true — not when it was learned.")
    return
  }
  el.innerHTML = memories
    .map((m) =>
      memoryCard(m, `<button type="button" class="btn btn--sm" data-action="detail" data-id="${esc(m.id)}">Details</button>`),
    )
    .join("")
}

function renderStats() {
  const s = STATE.stats
  if (!s) return
  $("#stat-strip").innerHTML = `
    <span><b>${s.active}</b> current</span>
    <span><b>${s.superseded}</b> no longer true</span>
    <span><b>${s.observations}</b> notes</span>
    <span><b>${s.entities}</b> entities</span>
  `
  $("#count-memories").textContent = String(s.active)
  const pendingCount = $("#count-pending")
  pendingCount.textContent = s.pending > 0 ? String(s.pending) : ""
  if (s.pending > 0) pendingCount.dataset.tone = "warn"
  else delete pendingCount.dataset.tone
}

async function loadStats() {
  STATE.stats = await api("/api/stats")
  renderStats()
}

async function loadMemories() {
  const el = $("#memories-list")
  setBusy(el, true)
  const params = new URLSearchParams()
  const q = $("#search-q").value.trim()
  const types = $("#filter-type").value
  const statuses = $("#filter-status").value
  if (q) params.set("q", q)
  if (types) params.set("types", types)
  if (statuses) params.set("statuses", statuses)
  params.set("limit", "100")

  const { memories } = await api(`/api/memories?${params}`)
  STATE.memories = memories
  renderMemories()
}

async function loadPending() {
  const el = $("#pending-list")
  setBusy(el, true)
  const { pending } = await api("/api/pending")
  STATE.pending = pending
  renderPending()
}

// ------------------------------------------------------------------ drawer --

async function openDetail(id) {
  STATE.lastFocus = document.activeElement
  const memory = await api(`/api/memories/${id}`)
  const { history } = await api(`/api/memories/${id}/history`)

  $("#drawer-title").textContent = TYPE_LABEL[memory.type] ?? memory.type
  $("#drawer-body").innerHTML = `
    <div class="field">
      <label for="detail-content">Statement</label>
      <textarea id="detail-content" rows="3">${esc(memory.content)}</textarea>
      <p class="hint">Editing keeps the previous wording in history rather than overwriting it.</p>
    </div>

    <div class="button-row" style="margin-bottom:var(--space-5)">
      <button type="button" class="btn btn--primary btn--sm" data-action="save" data-id="${esc(memory.id)}">Save correction</button>
      <button type="button" class="btn btn--sm" data-action="archive" data-id="${esc(memory.id)}">Archive</button>
      <button type="button" class="btn btn--danger btn--sm" data-action="delete" data-id="${esc(memory.id)}">Delete permanently</button>
    </div>

    <h3>Provenance</h3>
    <table class="data">
      <tbody>
        <tr><th>Status</th><td>${esc(STATUS_LABEL[memory.status] ?? memory.status)}</td></tr>
        <tr><th>True from</th><td>${esc(month(memory.validFrom) ?? "unknown")}</td></tr>
        <tr><th>True until</th><td>${esc(month(memory.validUntil) ?? "still true")}</td></tr>
        <tr><th>Recorded</th><td>${esc(month(memory.recordedAt) ?? "")}</td></tr>
        <tr><th>Confidence</th><td class="num">${memory.confidence.toFixed(2)}</td></tr>
        <tr><th>Importance</th><td class="num">${memory.importance.toFixed(2)}</td></tr>
        <tr><th>Re-observed</th><td class="num">${memory.reinforcedCount}</td></tr>
        ${memory.agentId ? `<tr><th>Written by</th><td>${esc(memory.agentId)}</td></tr>` : ""}
        <tr><th>Id</th><td><code>${esc(memory.id)}</code></td></tr>
      </tbody>
    </table>

    <h3 style="margin-top:var(--space-5)">How this changed</h3>
    ${
      history.length <= 1
        ? '<p class="lede">No earlier versions — this is the only statement of this fact.</p>'
        : `<ol class="chain">${history
            .map(
              (h) => `
          <li data-current="${h.id === memory.id}">
            <div>${esc(h.content)}</div>
            <div class="item__meta">
              <span>${esc(validity(h) || "unknown period")}</span>
              <span class="chip">${esc(STATUS_LABEL[h.status] ?? h.status)}</span>
            </div>
          </li>`,
            )
            .join("")}</ol>`
    }
  `

  $("#drawer").hidden = false
  $("#drawer-scrim").hidden = false
  $("#detail-content")?.focus()
}

function closeDrawer() {
  $("#drawer").hidden = true
  $("#drawer-scrim").hidden = true
  STATE.lastFocus?.focus?.()
}

// ------------------------------------------------------------------ recall --

function renderRecall(audit) {
  const { result, considered } = audit
  const el = $("#recall-result")

  if (result.memories.length === 0) {
    el.innerHTML = `
      <div class="empty">
        <h3>Nothing relevant was found</h3>
        <p>This is a correct answer, not a failure. The agent is told to proceed without personal context rather than given a weak match.</p>
        <p class="hint">${result.diagnostics.candidatesConsidered} candidate(s) were examined across ${result.diagnostics.routesUsed.length || 0} route(s).</p>
      </div>`
    return
  }

  const rows = result.memories
    .map(
      (m) => `
      <tr>
        <td>${esc(m.memory.content)}</td>
        <td>${esc(TYPE_LABEL[m.memory.type] ?? m.memory.type)}</td>
        <td class="num">${m.score.toFixed(3)}</td>
        <td class="num">${(m.breakdown.rrf ?? 0).toFixed(3)}</td>
        <td class="num">${(m.breakdown.recency ?? 0).toFixed(2)}</td>
        <td class="num">${(m.breakdown.importance ?? 0).toFixed(2)}</td>
        <td>${esc(m.routes.map((r) => r.route).join(", "))}</td>
      </tr>`,
    )
    .join("")

  const dropped = considered.filter((c) => !c.kept)

  el.innerHTML = `
    <div class="card">
      <h3>What the agent would receive</h3>
      <pre class="context">${esc(result.context)}</pre>
      <div class="breakdown" style="margin-top:var(--space-3)">
        <div><dt>path</dt><dd>${esc(result.mode)}${result.escalated ? " (escalated)" : ""}</dd></div>
        <div><dt>latency</dt><dd>${result.diagnostics.latencyMs} ms</dd></div>
        <div><dt>tokens</dt><dd>≈${result.diagnostics.estimatedTokens}</dd></div>
        <div><dt>candidates</dt><dd>${result.diagnostics.candidatesConsidered}</dd></div>
        <div><dt>filtered</dt><dd>${result.diagnostics.conflictsFiltered}</dd></div>
      </div>
    </div>

    <div class="card">
      <h3>Why each memory was chosen</h3>
      <table class="data">
        <thead>
          <tr><th>Memory</th><th>Type</th><th>Score</th><th>Fusion</th><th>Recency</th><th>Importance</th><th>Matched by</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    ${
      dropped.length > 0
        ? `<div class="card">
             <h3>What was filtered out</h3>
             <table class="data">
               <thead><tr><th>Reason</th><th class="num">Count</th></tr></thead>
               <tbody>${Object.entries(
                 dropped.reduce((acc, d) => ({ ...acc, [d.reason]: (acc[d.reason] ?? 0) + 1 }), {}),
               )
                 .map(([reason, n]) => `<tr><td>${esc(reason)}</td><td class="num">${n}</td></tr>`)
                 .join("")}</tbody>
             </table>
           </div>`
        : ""
    }
  `
}

// ---------------------------------------------------------------- actions ---

const ACTIONS = {
  async detail(id) {
    await openDetail(id)
  },

  async save(id) {
    const content = $("#detail-content").value.trim()
    if (!content) return toast("A memory cannot be empty", "error")
    await api(`/api/memories/${id}`, { method: "PATCH", body: JSON.stringify({ content }) })
    toast("Correction saved; the previous wording is in history")
    closeDrawer()
    await refresh()
  },

  async archive(id) {
    await api(`/api/memories/${id}`, { method: "DELETE" })
    toast("Archived — still in history, no longer used for recall")
    closeDrawer()
    await refresh()
  },

  async delete(id) {
    // Destructive and irreversible: confirm, and say exactly what will happen.
    const ok = window.confirm(
      "Permanently delete this memory?\n\nIt will be removed from the database and cannot be recovered. Archive instead if you only want it ignored.",
    )
    if (!ok) return
    await api(`/api/memories/${id}?hard=true`, { method: "DELETE" })
    toast("Deleted permanently")
    closeDrawer()
    await refresh()
  },

  async confirm(id) {
    await api(`/api/pending/${id}/confirm`, { method: "POST" })
    toast("Confirmed — it can now be recalled")
    await refresh()
  },

  async reject(id) {
    await api(`/api/pending/${id}/reject`, { method: "POST", body: JSON.stringify({}) })
    toast("Rejected — archived, not deleted")
    await refresh()
  },
}

// ------------------------------------------------------------------- wiring --

async function refresh() {
  try {
    await Promise.all([loadStats(), loadMemories(), loadPending()])
    if (STATE.view === "timeline") await renderTimeline()
  } catch (error) {
    reportError(error)
  }
}

function switchView(view) {
  STATE.view = view
  for (const tab of $$(".tab")) {
    if (tab.dataset.view === view) tab.setAttribute("aria-current", "page")
    else tab.removeAttribute("aria-current")
  }
  for (const section of $$(".view")) section.hidden = section.id !== `view-${view}`
  if (view === "timeline") renderTimeline().catch(reportError)
  if (view === "priorart") loadPriorArt().catch(reportError)
  if (view === "settings") loadPolicies().catch(reportError)
}

async function loadPolicies() {
  const { policies } = await api("/api/policies")
  const el = $("#policies-list")
  if (policies.length === 0) {
    el.innerHTML = '<p class="lede">No agent has written yet. Defaults apply: facts, preferences and goals are accepted; decisions need your confirmation.</p>'
    return
  }
  el.innerHTML = `<table class="data">
    <thead><tr><th>Agent</th><th>Auto-accepted</th><th>Needs review</th><th class="num">Can write</th></tr></thead>
    <tbody>${policies
      .map(
        (p) => `<tr>
          <td><code>${esc(p.agentId)}</code></td>
          <td>${esc((p.allowedTypes ?? []).map((t) => TYPE_LABEL[t] ?? t).join(", ") || "—")}</td>
          <td>${esc((p.requireConfirmationFor ?? []).map((t) => TYPE_LABEL[t] ?? t).join(", ") || "—")}</td>
          <td class="num">${p.canWrite ? "yes" : "no"}</td>
        </tr>`,
      )
      .join("")}</tbody>
  </table>`
}

// ---------------------------------------------------------------- prior art --

const PRIOR_ART_CHIP = {
  adopted: "chip--ok",
  partial: "chip--warn",
  watched: "chip--type",
  rejected: "",
}

const EVIDENCE_LABEL = { path: "file", case: "case", commit: "commit" }

/**
 * Parse the evidence box: one reference per line.
 *
 * `case:` and `commit:` are spelled out because a bare `rec-017` and a bare sha
 * are each indistinguishable from a filename. Anything unprefixed is a path.
 */
function parseEvidence(text) {
  const out = []
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith("case:")) out.push({ kind: "case", ref: line.slice(5).trim() })
    else if (line.startsWith("commit:")) out.push({ kind: "commit", ref: line.slice(7).trim() })
    else if (line.startsWith("path:")) out.push({ kind: "path", ref: line.slice(5).trim() })
    else out.push({ kind: "path", ref: line })
  }
  return out
}

function renderPriorArt(entries) {
  const el = $("#priorart-list")
  if (entries.length === 0) {
    el.innerHTML =
      '<p class="empty">No projects recorded yet. Add one above — including the ones you decided against, which are the most useful entries here.</p>'
    return
  }
  el.innerHTML = `<div class="list">${entries.map(renderPriorArtEntry).join("")}</div>`
}

function renderPriorArtEntry(entry) {
  const evidence = entry.evidence.length
    ? `<ul class="evidence">${entry.evidence
        .map(
          (e) => `<li>
            <span class="chip ${e.resolved ? "chip--ok" : "chip--danger"}">${esc(
              EVIDENCE_LABEL[e.kind] ?? e.kind,
            )}</span>
            <code>${esc(e.detail ?? e.ref)}</code>
            ${e.problem ? `<span class="hint"> — ${esc(e.problem)}</span>` : ""}
          </li>`,
        )
        .join("")}</ul>`
    : '<p class="hint">No evidence recorded. A claim of this kind has nothing behind it.</p>'

  return `<article class="item">
    <div class="item__main">
      <div class="item__meta">
        <span class="chip ${PRIOR_ART_CHIP[entry.status] ?? ""}">${esc(entry.status)}</span>
        <a href="${esc(entry.url)}" target="_blank" rel="noreferrer noopener">${esc(entry.repo)}</a>
        <span class="hint">added ${esc(entry.addedAt.slice(0, 10))} · reviewed ${esc(
          entry.reviewedAt.slice(0, 10),
        )}</span>
      </div>
      <div class="item__content">
        <strong>${esc(entry.title)}</strong>
        <p>${esc(entry.claim)}</p>
        <p>${esc(entry.rationale)}</p>
        ${entry.notTaken ? `<p><em>Not taken:</em> ${esc(entry.notTaken)}</p>` : ""}
        ${entry.killCriterion ? `<p><em>Kill criterion:</em> ${esc(entry.killCriterion)}</p>` : ""}
        ${
          entry.unbacked
            ? `<p class="hint">Marked <em>${esc(entry.status)}</em> but no reference resolves — this claim is unbacked.</p>`
            : ""
        }
        ${evidence}
      </div>
    </div>
    <div class="item__actions">
      <button class="btn btn--sm btn--danger" data-remove-priorart="${esc(entry.id)}">Remove</button>
    </div>
  </article>`
}

async function loadPriorArt() {
  const { entries } = await api("/api/prior-art")
  STATE.priorArt = entries
  renderPriorArt(entries)
}

async function addPriorArt(form) {
  const value = (name) => form.elements[name]?.value ?? ""
  await api("/api/prior-art", {
    method: "POST",
    body: JSON.stringify({
      repo: value("repo").trim(),
      title: value("title").trim(),
      status: value("status"),
      claim: value("claim").trim(),
      rationale: value("rationale").trim(),
      notTaken: value("notTaken").trim() || undefined,
      killCriterion: value("killCriterion").trim() || undefined,
      evidence: parseEvidence(value("evidence")),
    }),
  })
  form.reset()
  toast("Project added")
  await loadPriorArt()
}

async function removePriorArt(id) {
  const entry = (STATE.priorArt ?? []).find((e) => e.id === id)
  const ok = window.confirm(
    `Remove ${entry?.repo ?? "this project"} from the reference list?\n\nThis only removes the entry — nothing in the repository changes.`,
  )
  if (!ok) return
  // Force rather than archive: a reference list has no history worth keeping, and
  // the entry is one `git` command away from being re-added.
  await api(`/api/prior-art/${id}`, { method: "DELETE" })
  toast("Removed")
  await loadPriorArt()
}

function initTheme() {
  const saved = localStorage.getItem("mp-theme")
  if (saved) document.documentElement.dataset.theme = saved
  $("#theme-toggle").addEventListener("click", () => {
    const current =
      document.documentElement.dataset.theme ??
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    const next = current === "dark" ? "light" : "dark"
    document.documentElement.dataset.theme = next
    localStorage.setItem("mp-theme", next)
  })
}

function init() {
  initTheme()

  // Tabs
  for (const tab of $$(".tab")) {
    tab.addEventListener("click", () => switchView(tab.dataset.view))
  }

  // Filters: debounce so typing does not fire a request per keystroke.
  let filterTimer
  const runFilter = () => {
    clearTimeout(filterTimer)
    filterTimer = setTimeout(() => loadMemories().catch(reportError), 220)
  }
  $("#search-q").addEventListener("input", runFilter)
  $("#filter-type").addEventListener("change", runFilter)
  $("#filter-status").addEventListener("change", runFilter)
  $("#filter-form").addEventListener("submit", (e) => e.preventDefault())

  // Remember
  $("#remember-form").addEventListener("submit", async (event) => {
    event.preventDefault()
    const input = $("#remember-input")
    const content = input.value.trim()
    if (!content) return
    const button = $("#remember-submit")
    button.disabled = true
    button.textContent = "Working…"
    try {
      const outcome = await api("/api/remember", {
        method: "POST",
        body: JSON.stringify({ content, sourceKind: "user" }),
      })
      if (outcome.deferred) {
        toast("Saved, but extraction failed — nothing was lost, it can be reprocessed", "error")
      } else if (outcome.memories.length === 0) {
        toast("Reviewed — nothing here looked worth keeping long term")
      } else {
        toast(`Remembered ${outcome.memories.length} item(s)`)
      }
      input.value = ""
      await refresh()
      switchView("memories")
    } catch (error) {
      reportError(error)
    } finally {
      button.disabled = false
      button.textContent = "Remember"
    }
  })

  // Recall
  $("#recall-form").addEventListener("submit", async (event) => {
    event.preventDefault()
    const el = $("#recall-result")
    el.innerHTML = '<div class="skeleton" style="height:120px"></div>'
    try {
      const audit = await api("/api/recall", {
        method: "POST",
        body: JSON.stringify({
          query: $("#recall-q").value,
          mode: $("#recall-mode").value,
          includeHistory: $("#recall-history").checked,
          format: "text",
          audit: true,
        }),
      })
      renderRecall(audit)
    } catch (error) {
      el.innerHTML = `<div class="error-box">${esc(error.message)}</div>`
    }
  })

  // List interactions (event delegation; lists are re-rendered often)
  for (const listId of ["#memories-list", "#pending-list", "#timeline-list"]) {
    $(listId).addEventListener("click", (event) => {
      const button = event.target.closest("[data-action]")
      if (!button) return
      const handler = ACTIONS[button.dataset.action]
      if (!handler) return
      button.disabled = true
      Promise.resolve(handler(button.dataset.id))
        .catch(reportError)
        .finally(() => {
          button.disabled = false
        })
    })
  }

  // Drawer
  $("#drawer-close").addEventListener("click", closeDrawer)
  $("#drawer-scrim").addEventListener("click", closeDrawer)
  // Escape must dismiss, and the keydown listener is removed once the drawer is
  // gone so it cannot keep intercepting Escape for the rest of the page.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("#drawer").hidden) closeDrawer()
  })

  // Settings: import
  const fileInput = $("#import-file")
  const importBtn = $("#import-btn")
  fileInput.addEventListener("change", () => {
    importBtn.disabled = !fileInput.files?.length
  })
  importBtn.addEventListener("click", async () => {
    const file = fileInput.files?.[0]
    if (!file) return
    const ok = window.confirm(
      "Replace ALL stored data with this backup?\n\nEverything currently in the database will be deleted first. This cannot be undone.",
    )
    if (!ok) return
    try {
      const bundle = JSON.parse(await file.text())
      const result = await api("/api/import?replace=true", {
        method: "POST",
        body: JSON.stringify(bundle),
      })
      toast(`Restored ${result.memories} memories and ${result.observations} notes`)
      fileInput.value = ""
      importBtn.disabled = true
      await refresh()
    } catch (error) {
      reportError(error)
    }
  })

  // Settings: erase
  $("#erase-btn").addEventListener("click", async () => {
    const ok = window.confirm(
      "Permanently erase everything?\n\nEvery memory, note and entity will be deleted. Export first if you might want any of it.",
    )
    if (!ok) return
    try {
      await api("/api/erase?confirm=ERASE", { method: "POST" })
      toast("All data erased")
      await refresh()
    } catch (error) {
      reportError(error)
    }
  })

  // Prior art: add and remove
  $("#priorart-form").addEventListener("submit", (event) => {
    event.preventDefault()
    addPriorArt(event.currentTarget).catch(reportError)
  })
  $("#priorart-list").addEventListener("click", (event) => {
    const id = event.target.closest("[data-remove-priorart]")?.dataset.removePriorart
    if (id) removePriorArt(id).catch(reportError)
  })

  refresh()
}

init()
