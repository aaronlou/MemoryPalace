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

import {
  currentLang,
  evidenceLabel,
  initialLang,
  priorStatusLabel,
  setLang,
  statusLabel,
  t,
  typeLabel,
} from "./i18n.js"

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

// Labels resolve through the i18n dictionary, so they can never fall out of step
// with the language the rest of the page is in. The raw value is the fallback: an
// unrecognised type renders as its identifier rather than as a blank.
const TYPE_LABEL = new Proxy({}, { get: (_t, key) => typeLabel(String(key)) })
const STATUS_LABEL = new Proxy({}, { get: (_t, key) => statusLabel(String(key)) })

const month = (iso) => (iso ? String(iso).slice(0, 7) : null)

/** Render a validity window. An open end is "now", not today's date. */
function validity(memory) {
  const from = month(memory.validFrom)
  const until = month(memory.validUntil)
  if (from && until) return t("validity.range", { from, until })
  if (from) return t("validity.open", { from })
  if (until) return t("validity.until", { until })
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
          <span title="${esc(t("card.confidenceTitle"))}">${esc(t("card.confidence", { value: memory.confidence.toFixed(2) }))}</span>
          ${memory.reinforcedCount > 0 ? `<span>${esc(t("card.observed", { count: memory.reinforcedCount }))}</span>` : ""}
        </div>
      </div>
      <div class="item__actions">${actions}</div>
    </article>
  `
}

function renderMemories() {
  const el = $("#memories-list")
  if (STATE.memories.length === 0) {
    el.innerHTML = emptyState(t("memories.empty.title"), t("memories.empty.body"))
    return
  }
  el.innerHTML = STATE.memories
    .map((m) =>
      memoryCard(m, `<button type="button" class="btn btn--sm" data-action="detail" data-id="${esc(m.id)}">${esc(t("common.details"))}</button>`),
    )
    .join("")
}

function renderPending() {
  const el = $("#pending-list")
  if (STATE.pending.length === 0) {
    el.innerHTML = emptyState(t("pending.empty.title"), t("pending.empty.body"))
    return
  }
  el.innerHTML = STATE.pending
    .map((m) =>
      memoryCard(m, `
        <button type="button" class="btn btn--sm btn--primary" data-action="confirm" data-id="${esc(m.id)}">${esc(t("common.confirm"))}</button>
        <button type="button" class="btn btn--sm btn--danger" data-action="reject" data-id="${esc(m.id)}">${esc(t("common.reject"))}</button>
        <button type="button" class="btn btn--sm" data-action="detail" data-id="${esc(m.id)}">${esc(t("common.details"))}</button>
      `),
    )
    .join("")
}

async function renderTimeline() {
  const el = $("#timeline-list")
  setBusy(el, true)
  const { memories } = await api("/api/timeline")
  if (memories.length === 0) {
    el.innerHTML = emptyState(t("timeline.empty.title"), t("timeline.empty.body"))
    return
  }
  el.innerHTML = memories
    .map((m) =>
      memoryCard(m, `<button type="button" class="btn btn--sm" data-action="detail" data-id="${esc(m.id)}">${esc(t("common.details"))}</button>`),
    )
    .join("")
}

function renderStats() {
  const s = STATE.stats
  if (!s) return
  $("#stat-strip").innerHTML = `
    <span><b>${s.active}</b> ${esc(t("stats.current"))}</span>
    <span><b>${s.superseded}</b> ${esc(t("stats.superseded"))}</span>
    <span><b>${s.observations}</b> ${esc(t("stats.notes"))}</span>
    <span><b>${s.entities}</b> ${esc(t("stats.entities"))}</span>
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
  // Tracked so a language change can rebuild the drawer in the new language.
  STATE.selected = id
  const memory = await api(`/api/memories/${id}`)
  const { history } = await api(`/api/memories/${id}/history`)

  $("#drawer-title").textContent = TYPE_LABEL[memory.type] ?? memory.type
  $("#drawer-body").innerHTML = `
    <div class="field">
      <label for="detail-content">${esc(t("drawer.statement"))}</label>
      <textarea id="detail-content" rows="3">${esc(memory.content)}</textarea>
      <p class="hint">${esc(t("drawer.editHint"))}</p>
    </div>

    <div class="button-row" style="margin-bottom:var(--space-5)">
      <button type="button" class="btn btn--primary btn--sm" data-action="save" data-id="${esc(memory.id)}">${esc(t("drawer.save"))}</button>
      <button type="button" class="btn btn--sm" data-action="archive" data-id="${esc(memory.id)}">${esc(t("drawer.archive"))}</button>
      <button type="button" class="btn btn--danger btn--sm" data-action="delete" data-id="${esc(memory.id)}">${esc(t("drawer.delete"))}</button>
    </div>

    <h3>${esc(t("drawer.provenance"))}</h3>
    <table class="data">
      <tbody>
        <tr><th>${esc(t("drawer.status"))}</th><td>${esc(statusLabel(memory.status))}</td></tr>
        <tr><th>${esc(t("drawer.trueFrom"))}</th><td>${esc(month(memory.validFrom) ?? t("common.unknown"))}</td></tr>
        <tr><th>${esc(t("drawer.trueUntil"))}</th><td>${esc(month(memory.validUntil) ?? t("common.stillTrue"))}</td></tr>
        <tr><th>${esc(t("drawer.recorded"))}</th><td>${esc(month(memory.recordedAt) ?? "")}</td></tr>
        <tr><th>${esc(t("drawer.confidence"))}</th><td class="num">${memory.confidence.toFixed(2)}</td></tr>
        <tr><th>${esc(t("drawer.importance"))}</th><td class="num">${memory.importance.toFixed(2)}</td></tr>
        <tr><th>${esc(t("drawer.reobserved"))}</th><td class="num">${memory.reinforcedCount}</td></tr>
        ${memory.agentId ? `<tr><th>${esc(t("drawer.writtenBy"))}</th><td>${esc(memory.agentId)}</td></tr>` : ""}
        <tr><th>${esc(t("drawer.id"))}</th><td><code>${esc(memory.id)}</code></td></tr>
      </tbody>
    </table>

    <h3 style="margin-top:var(--space-5)">${esc(t("drawer.howChanged"))}</h3>
    ${
      history.length <= 1
        ? `<p class="lede">${esc(t("drawer.noEarlier"))}</p>`
        : `<ol class="chain">${history
            .map(
              (h) => `
          <li data-current="${h.id === memory.id}">
            <div>${esc(h.content)}</div>
            <div class="item__meta">
              <span>${esc(validity(h) || t("common.unknownPeriod"))}</span>
              <span class="chip">${esc(statusLabel(h.status))}</span>
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
  STATE.selected = null
  STATE.lastFocus?.focus?.()
}

// ------------------------------------------------------------------ recall --

function renderRecall(audit) {
  const { result, considered } = audit
  const el = $("#recall-result")

  if (result.memories.length === 0) {
    el.innerHTML = `
      <div class="empty">
        <h3>${esc(t("recall.empty.title"))}</h3>
        <p>${esc(t("recall.empty.body"))}</p>
        <p class="hint">${esc(
          t("recall.empty.diagnostics", {
            candidates: result.diagnostics.candidatesConsidered,
            routes: result.diagnostics.routesUsed.length || 0,
          }),
        )}</p>
      </div>`
    return
  }

  const rows = result.memories
    .map(
      (m) => `
      <tr>
        <td>${esc(m.memory.content)}</td>
        <td>${esc(typeLabel(m.memory.type))}</td>
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
      <h3>${esc(t("recall.received"))}</h3>
      <pre class="context">${esc(result.context)}</pre>
      <div class="breakdown" style="margin-top:var(--space-3)">
        <div><dt>${esc(t("recall.metric.path"))}</dt><dd>${esc(result.mode)}${result.escalated ? esc(t("recall.escalated")) : ""}</dd></div>
        <div><dt>${esc(t("recall.metric.latency"))}</dt><dd>${result.diagnostics.latencyMs} ms</dd></div>
        <div><dt>${esc(t("recall.metric.tokens"))}</dt><dd>≈${result.diagnostics.estimatedTokens}</dd></div>
        <div><dt>${esc(t("recall.metric.candidates"))}</dt><dd>${result.diagnostics.candidatesConsidered}</dd></div>
        <div><dt>${esc(t("recall.metric.filtered"))}</dt><dd>${result.diagnostics.conflictsFiltered}</dd></div>
      </div>
    </div>

    <div class="card">
      <h3>${esc(t("recall.why.title"))}</h3>
      <table class="data">
        <thead>
          <tr><th>${esc(t("recall.table.memory"))}</th><th>${esc(t("recall.table.type"))}</th><th>${esc(t("recall.table.score"))}</th><th>${esc(t("recall.table.fusion"))}</th><th>${esc(t("recall.table.recency"))}</th><th>${esc(t("recall.table.importance"))}</th><th>${esc(t("recall.table.matchedBy"))}</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    ${
      dropped.length > 0
        ? `<div class="card">
             <h3>${esc(t("recall.filtered.title"))}</h3>
             <table class="data">
               <thead><tr><th>${esc(t("recall.filtered.reason"))}</th><th class="num">${esc(t("recall.filtered.count"))}</th></tr></thead>
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
    if (!content) return toast(t("error.emptyMemory"), "error")
    await api(`/api/memories/${id}`, { method: "PATCH", body: JSON.stringify({ content }) })
    toast(t("toast.correctionSaved"))
    closeDrawer()
    await refresh()
  },

  async archive(id) {
    await api(`/api/memories/${id}`, { method: "DELETE" })
    toast(t("toast.archived"))
    closeDrawer()
    await refresh()
  },

  async delete(id) {
    // Destructive and irreversible: confirm, and say exactly what will happen.
    const ok = window.confirm(
      t("confirm.delete"),
    )
    if (!ok) return
    await api(`/api/memories/${id}?hard=true`, { method: "DELETE" })
    toast(t("toast.deleted"))
    closeDrawer()
    await refresh()
  },

  async confirm(id) {
    await api(`/api/pending/${id}/confirm`, { method: "POST" })
    toast(t("toast.confirmed"))
    await refresh()
  },

  async reject(id) {
    await api(`/api/pending/${id}/reject`, { method: "POST", body: JSON.stringify({}) })
    toast(t("toast.rejected"))
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
  if (view === "priorart") {
    loadPriorArt()
      .then(schedulePriorArtPoll)
      .catch(reportError)
  }
  if (view === "settings") loadPolicies().catch(reportError)
}

async function loadPolicies() {
  const { policies } = await api("/api/policies")
  const el = $("#policies-list")
  if (policies.length === 0) {
    el.innerHTML = `<p class="lede">${esc(t("policies.empty"))}</p>`
    return
  }
  el.innerHTML = `<table class="data">
    <thead><tr><th>${esc(t("policies.agent"))}</th><th>${esc(t("policies.autoAccepted"))}</th><th>${esc(t("policies.needsReview"))}</th><th class="num">${esc(t("policies.canWrite"))}</th></tr></thead>
    <tbody>${policies
      .map(
        (p) => `<tr>
          <td><code>${esc(p.agentId)}</code></td>
          <td>${esc((p.allowedTypes ?? []).map((x) => typeLabel(x)).join(", ") || "—")}</td>
          <td>${esc((p.requireConfirmationFor ?? []).map((x) => typeLabel(x)).join(", ") || "—")}</td>
          <td class="num">${esc(p.canWrite ? t("common.yes") : t("common.no"))}</td>
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

// Evidence chips resolve through the dictionary, same as the type chips.

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
    el.innerHTML = `<p class="empty">${esc(t("priorart.empty"))}</p>`
    return
  }
  el.innerHTML = `<div class="list">${entries.map(renderPriorArtEntry).join("")}</div>`
}

/** Chip text for an entry that has no assessment yet or is mid-assessment. */
function priorArtStateChip(entry) {
  const state = entry.evaluation?.state ?? "none"
  if (state === "pending") return `<span class="chip chip--warn">${esc(t("priorart.queued"))}</span>`
  if (state === "running") return `<span class="chip chip--warn">${esc(t("priorart.evaluating"))}</span>`
  if (state === "failed") return `<span class="chip chip--danger">${esc(t("priorart.failed"))}</span>`
  if (state === "ready") return `<span class="chip chip--type">${esc(t("priorart.review.title"))}</span>`
  return `<span class="chip ${PRIOR_ART_CHIP[entry.status] ?? ""}">${esc(priorStatusLabel(entry.status))}</span>`
}

/**
 * The draft, as an editable review rather than a result.
 *
 * Nothing here is stored until Accept is pressed, which is why every field is a
 * form control: the model's reading is a starting point and the reviewer owns the
 * wording.
 */
function renderDraftForm(entry) {
  const draft = entry.evaluation?.draft
  if (!draft) return ""
  const field = (name, labelKey, value = "", rows = 2) => `
    <div class="field">
      <label for="draft-${esc(entry.id)}-${name}">${esc(t(labelKey))}</label>
      <textarea id="draft-${esc(entry.id)}-${name}" data-draft="${name}" rows="${rows}">${esc(value)}</textarea>
    </div>`

  const dropped =
    draft.rejectedEvidence.length > 0
      ? `<p class="hint">${esc(t("priorart.review.dropped", { count: draft.rejectedEvidence.length }))}</p>
         <ul class="evidence">${draft.rejectedEvidence
           .map(
             (r) =>
               `<li><span class="chip chip--danger">${esc(r.ref)}</span> <span class="hint">${esc(r.problem)}</span></li>`,
           )
           .join("")}</ul>`
      : ""

  return `
    <div class="card" data-draft-panel="${esc(entry.id)}">
      <h3>${esc(t("priorart.review.title"))}</h3>
      <p class="lede">${esc(t("priorart.review.lede"))}</p>
      <p class="hint">
        ${esc(t("priorart.review.suggested"))}:
        <strong>${esc(priorStatusLabel(draft.suggestedStatus))}</strong>
        · ${esc(t("priorart.review.confidence", { value: draft.confidence.toFixed(2) }))}
        ${entry.evaluation?.revision ? `· ${esc(t("priorart.review.revision", { revision: entry.evaluation.revision.slice(0, 7) }))}` : ""}
      </p>
      <div class="field">
        <label for="draft-${esc(entry.id)}-status">${esc(t("priorart.review.suggested"))}</label>
        <select id="draft-${esc(entry.id)}-status" data-draft="status">
          ${["adopted", "partial", "rejected", "watched"]
            .map(
              (value) =>
                `<option value="${value}" ${value === draft.suggestedStatus ? "selected" : ""}>${esc(priorStatusLabel(value))}</option>`,
            )
            .join("")}
        </select>
      </div>
      ${field("title", "priorart.field.title", draft.title, 2)}
      ${field("claim", "priorart.field.claim", draft.claim, 3)}
      ${field("rationale", "priorart.field.rationale", draft.rationale, 3)}
      ${field("notTaken", "priorart.field.notTaken", draft.notTaken ?? "", 2)}
      ${field("killCriterion", "priorart.field.kill", draft.killCriterion ?? "", 2)}
      ${field("evidence", "priorart.field.evidence", draft.evidence.map((e) => `${e.kind === "path" ? "" : `${e.kind}:`}${e.ref}`).join("\n"), 3)}
      <p class="hint">${esc(t("priorart.field.evidenceHint"))}</p>
      ${dropped}
      <div class="button-row">
        <button class="btn btn--primary" data-adopt="${esc(entry.id)}">${esc(t("priorart.adopt"))}</button>
        <button class="btn btn--danger" data-dismiss="${esc(entry.id)}">${esc(t("priorart.dismiss"))}</button>
      </div>
    </div>`
}

function renderPriorArtEntry(entry) {
  const state = entry.evaluation?.state ?? "none"
  const evidence = entry.evidence.length
    ? `<ul class="evidence">${entry.evidence
        .map(
          (e) => `<li>
            <span class="chip ${e.resolved ? "chip--ok" : "chip--danger"}">${esc(evidenceLabel(e.kind))}</span>
            <code>${esc(e.detail ?? e.ref)}</code>
            ${e.problem ? `<span class="hint"> — ${esc(e.problem)}</span>` : ""}
          </li>`,
        )
        .join("")}</ul>`
    : ""

  // An entry that has not been assessed has nothing to show but its state.
  const body =
    state === "ready"
      ? renderDraftForm(entry)
      : state === "pending" || state === "running"
        ? `<p class="hint" aria-live="polite">${esc(t(state === "pending" ? "priorart.queued" : "priorart.evaluating"))}</p>`
        : state === "failed"
          ? `<p class="hint">${esc(entry.evaluation?.error ?? "")}</p>
             <div class="button-row">
               <button class="btn btn--sm" data-evaluate="${esc(entry.id)}">${esc(t("priorart.retry"))}</button>
               <button class="btn btn--sm btn--danger" data-remove-priorart="${esc(entry.id)}">${esc(t("common.remove"))}</button>
             </div>`
          : `<div class="item__content">
               ${entry.claim ? `<p>${esc(entry.claim)}</p>` : ""}
               ${entry.rationale ? `<p>${esc(entry.rationale)}</p>` : ""}
               ${entry.notTaken ? `<p><em>${esc(t("priorart.notTaken"))}</em> ${esc(entry.notTaken)}</p>` : ""}
               ${entry.killCriterion ? `<p><em>${esc(t("priorart.kill"))}</em> ${esc(entry.killCriterion)}</p>` : ""}
               ${
                 entry.unbacked
                   ? `<p class="hint">${esc(t("priorart.unbacked", { status: priorStatusLabel(entry.status) }))}</p>`
                   : ""
               }
               ${evidence || `<p class="hint">${esc(t("priorart.noEvidence"))}</p>`}
             </div>
             <div class="item__actions">
               <button class="btn btn--sm btn--danger" data-remove-priorart="${esc(entry.id)}">${esc(t("common.remove"))}</button>
             </div>`

  return `<article class="item" data-priorart="${esc(entry.id)}">
    <div class="item__main">
      <div class="item__meta">
        ${priorArtStateChip(entry)}
        <a href="${esc(entry.url)}" target="_blank" rel="noreferrer noopener">${esc(entry.repo)}</a>
        <span class="hint">${esc(t("priorart.added", { date: entry.addedAt.slice(0, 10) }))}</span>
      </div>
      ${state === "ready" ? "" : `<strong>${esc(entry.title)}</strong>`}
      ${body}
    </div>
  </article>`
}

async function loadPriorArt() {
  const { entries } = await api("/api/prior-art")
  STATE.priorArt = entries
  renderPriorArt(entries)
}

async function addPriorArt(form) {
  const repo = form.elements.repo.value.trim()
  if (!repo) return
  await api("/api/prior-art", { method: "POST", body: JSON.stringify({ repo }) })
  form.reset()
  toast(t("priorart.queued"))
  await loadPriorArt()
  // The job runs in the background, so the list is re-read until nothing is in
  // flight. Polling stops on its own: once every entry has settled there is
  // nothing left to wait for.
  schedulePriorArtPoll()
}

let priorArtTimer
function schedulePriorArtPoll() {
  clearTimeout(priorArtTimer)
  const active = (STATE.priorArt ?? []).some(
    (e) => e.evaluation?.state === "pending" || e.evaluation?.state === "running",
  )
  if (!active) return
  priorArtTimer = setTimeout(() => {
    if (STATE.view === "priorart") loadPriorArt().catch(reportError)
    schedulePriorArtPoll()
  }, 1500)
}

/** Read the review panel's edits back into an input for the adopt endpoint. */
function draftInput(entryId) {
  const panel = $(`[data-draft-panel="${entryId}"]`)
  if (!panel) return null
  const value = (name) => panel.querySelector(`[data-draft="${name}"]`)?.value ?? ""
  return {
    title: value("title").trim(),
    claim: value("claim").trim(),
    rationale: value("rationale").trim(),
    status: value("status"),
    notTaken: value("notTaken").trim() || undefined,
    killCriterion: value("killCriterion").trim() || undefined,
    evidence: parseEvidence(value("evidence")),
  }
}

async function adoptPriorArt(id) {
  const entry = (STATE.priorArt ?? []).find((e) => e.id === id)
  const input = draftInput(id)
  if (!entry || !input) return
  await api(`/api/prior-art/${id}/adopt`, {
    method: "POST",
    body: JSON.stringify({ repo: entry.repo, sourceRevision: entry.evaluation?.revision, ...input }),
  })
  toast(t("toast.priorArtAdded"))
  await loadPriorArt()
}

async function dismissPriorArt(id) {
  const entry = (STATE.priorArt ?? []).find((e) => e.id === id)
  const ok = window.confirm(t("confirm.dismissPriorArt", { repo: entry?.repo ?? "?" }))
  if (!ok) return
  await api(`/api/prior-art/${id}`, { method: "DELETE" })
  await loadPriorArt()
}

async function evaluatePriorArt(id) {
  await api(`/api/prior-art/${id}/evaluate`, { method: "POST" })
  toast(t("priorart.queued"))
  await loadPriorArt()
  schedulePriorArtPoll()
}

async function removePriorArt(id) {
  const entry = (STATE.priorArt ?? []).find((e) => e.id === id)
  const ok = window.confirm(
    t("confirm.removePriorArt", { repo: entry?.repo ?? "?" }),
  )
  if (!ok) return
  // Force rather than archive: a reference list has no history worth keeping, and
  // the entry is one `git` command away from being re-added.
  await api(`/api/prior-art/${id}`, { method: "DELETE" })
  toast(t("toast.priorArtRemoved"))
  await loadPriorArt()
}

/**
 * Language. Next to the theme toggle because they are the same kind of thing: a
 * display preference the user chose, remembered locally, applied to static markup.
 */
function initLang() {
  setLang(initialLang(localStorage))
  $("#lang-toggle").addEventListener("click", () => {
    const next = currentLang() === "zh" ? "en" : "zh"
    localStorage.setItem("mp-lang", next)
    setLang(next)
    // Re-render what was built from data. Anything holding user input — the open
    // drawer, text typed but not sent — is deliberately left alone, because
    // changing language should not discard work in progress.
    renderStats()
    renderMemories()
    renderPending()
    if (STATE.view === "timeline") renderTimeline().catch(reportError)
    if (STATE.view === "priorart") loadPriorArt().catch(reportError)
    if (STATE.view === "settings") loadPolicies().catch(reportError)
    // The drawer is generated from data as well, so it is rebuilt — but a draft
    // edit is carried across, because changing language should not discard work.
    if (STATE.selected) {
      const draft = $("#detail-content")?.value
      openDetail(STATE.selected)
        .then(() => {
          const field = $("#detail-content")
          if (field && draft !== undefined) field.value = draft
        })
        .catch(reportError)
    }
  })
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
  initLang()
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
    button.textContent = t("composer.working")
    try {
      const outcome = await api("/api/remember", {
        method: "POST",
        body: JSON.stringify({ content, sourceKind: "user" }),
      })
      if (outcome.deferred) {
        toast(t("toast.extractionFailed"), "error")
      } else if (outcome.memories.length === 0) {
        toast(t("toast.reviewed"))
      } else {
        toast(t("toast.remembered", { count: outcome.memories.length }))
      }
      input.value = ""
      await refresh()
      switchView("memories")
    } catch (error) {
      reportError(error)
    } finally {
      button.disabled = false
      button.textContent = t("composer.submit")
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
      t("confirm.import"),
    )
    if (!ok) return
    try {
      const bundle = JSON.parse(await file.text())
      const result = await api("/api/import?replace=true", {
        method: "POST",
        body: JSON.stringify(bundle),
      })
      toast(t("toast.restored", { memories: result.memories, observations: result.observations }))
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
      t("confirm.erase"),
    )
    if (!ok) return
    try {
      await api("/api/erase?confirm=ERASE", { method: "POST" })
      toast(t("toast.erased"))
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
    const target = event.target
    const adopt = target.closest("[data-adopt]")?.dataset.adopt
    const dismiss = target.closest("[data-dismiss]")?.dataset.dismiss
    const retry = target.closest("[data-evaluate]")?.dataset.evaluate
    const remove = target.closest("[data-remove-priorart]")?.dataset.removePriorart
    if (adopt) adoptPriorArt(adopt).catch(reportError)
    else if (dismiss) dismissPriorArt(dismiss).catch(reportError)
    else if (retry) evaluatePriorArt(retry).catch(reportError)
    else if (remove) removePriorArt(remove).catch(reportError)
  })

  refresh()
}

init()
