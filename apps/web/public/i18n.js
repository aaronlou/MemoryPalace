/**
 * Interface translations.
 *
 * The UI ships in English and Chinese, and the choice is the user's: an explicit
 * toggle, remembered in `localStorage`, defaulting to the browser's language. It
 * also sets `<html lang>`, which matters for more than tidiness — screen readers
 * pick pronunciation from it, and it was previously hard-coded to `zh-CN` while
 * every string on the page was English.
 *
 * Two rules keep this honest, both enforced by `apps/api/src/web-ui.test.ts`:
 *
 *  1. Every key exists in EVERY language, and no value is empty. A missing string
 *     should fail the build, not render as `nav.memories` in front of a user.
 *  2. The English text hard-coded in `index.html` must equal the `en` dictionary
 *     value for the same key. It is kept in the markup so the page shows real
 *     words before the module runs and if it never does — but that duplication is
 *     only safe because a test compares the two.
 *
 * Deliberately not translated: values the server produces (recall route names,
 * filter reasons, memory ids) and the product name. Those are identifiers, and
 * pretending otherwise would mean shipping a second vocabulary that no longer
 * matches the API.
 */

export const LANGS = ["en", "zh"]

const MESSAGES = {
  en: {
    "app.title": "Memory Palace",
    "meta.description":
      "Inspect, correct and export the long-term memory this system holds about you.",
    "a11y.skipToContent": "Skip to content",
    "nav.label": "Sections",
    "nav.memories": "Memories",
    "nav.pending": "Needs review",
    "nav.timeline": "Timeline",
    "nav.recall": "Recall test",
    "nav.priorart": "Prior art",
    "nav.settings": "Settings",
    "theme.toggle": "Switch colour theme",
    "lang.toggle": "Switch language",
    /** Shown on the button: the language you would switch TO. */
    "lang.other": "中文",

    "common.details": "Details",
    "common.confirm": "Confirm",
    "common.reject": "Reject",
    "common.remove": "Remove",
    "common.now": "now",
    "common.unknown": "unknown",
    "common.stillTrue": "still true",
    "common.unknownPeriod": "unknown period",
    "common.yes": "yes",
    "common.no": "no",

    "type.goal": "Goal",
    "type.preference": "Preference",
    "type.fact": "Fact",
    "type.decision": "Decision",
    "type.relationship": "Relationship",
    "type.experience": "Experience",
    "type.event": "Event",

    "status.active": "current",
    "status.pending": "needs review",
    "status.superseded": "no longer true",
    "status.archived": "archived",

    "memories.heading": "Stored memories",
    "memories.search.label": "Search",
    "memories.search.placeholder": "Search wording, e.g. Effect-TS",
    "memories.filter.type": "Type",
    "memories.filter.allTypes": "All types",
    "memories.filter.status": "Status",
    "memories.filter.everything": "Everything",
    "memories.filter.active": "Active",
    "memories.filter.superseded": "Superseded",
    "memories.filter.archived": "Archived",
    "memories.filter.pending": "Awaiting review",
    "memories.empty.title": "Nothing here yet",
    "memories.empty.body":
      "Use the box above to write something worth remembering. Memories appear once the system has decided what is durable; transient remarks are deliberately dropped.",

    "composer.label": "Tell it something worth remembering",
    "composer.placeholder":
      "Write it however you would say it — the system decides what is worth keeping.",
    "composer.hint":
      "Stored verbatim first, then turned into memories. A model outage cannot lose this.",
    "composer.submit": "Remember",
    "composer.working": "Working…",

    "pending.heading": "Needs review",
    "pending.lede":
      "These were not stored automatically — either they conflict with something already known, or the agent that wrote them is not trusted for that kind of memory. Confirm only what you agree with.",
    "pending.empty.title": "Nothing needs review",
    "pending.empty.body":
      "Memories land here when they conflict with something already known, or when the writing agent is not trusted for that kind of memory.",

    "timeline.heading": "Timeline",
    "timeline.lede":
      "When each memory was true, not when it was learned. Struck-through entries are no longer current but are kept so changes stay traceable.",
    "timeline.empty.title": "No history yet",
    "timeline.empty.body":
      "Once memories are recorded, this shows when each was true — not when it was learned.",

    "recall.heading": "Recall test",
    "recall.lede":
      "Ask what an agent would ask, and see exactly what would be handed to it — including why each memory was chosen and what was filtered out.",
    "recall.question.label": "Question an agent would ask",
    "recall.question.placeholder": "e.g. Effect-TS 的 Context.Service 怎么理解？",
    "recall.mode.label": "Path",
    "recall.mode.auto": "auto",
    "recall.mode.fast": "fast (no model call)",
    "recall.mode.smart": "smart (understands + reranks)",
    "recall.history": "Include no-longer-true memories",
    "recall.run": "Run recall",
    "recall.empty.title": "Nothing relevant was found",
    "recall.empty.body":
      "This is a correct answer, not a failure. The agent is told to proceed without personal context rather than given a weak match.",
    "recall.empty.diagnostics":
      "{candidates} candidate(s) were examined across {routes} route(s).",
    "recall.received": "What the agent would receive",
    "recall.escalated": " (escalated)",
    "recall.metric.path": "path",
    "recall.metric.latency": "latency",
    "recall.metric.tokens": "tokens",
    "recall.metric.candidates": "candidates",
    "recall.metric.filtered": "filtered",
    "recall.why.title": "Why each memory was chosen",
    "recall.table.memory": "Memory",
    "recall.table.type": "Type",
    "recall.table.score": "Score",
    "recall.table.fusion": "Fusion",
    "recall.table.recency": "Recency",
    "recall.table.importance": "Importance",
    "recall.table.matchedBy": "Matched by",
    "recall.filtered.title": "What was filtered out",
    "recall.filtered.reason": "Reason",
    "recall.filtered.count": "Count",

    "settings.heading": "Settings and data",
    "settings.data.title": "Your data is yours",
    "settings.data.lede":
      "Export in a format you can read, or in one you can restore. Deleting is real deletion, not a flag.",
    "settings.export.markdown": "Download readable (Markdown)",
    "settings.export.json": "Download full backup (JSON)",
    "settings.import.title": "Restore from a backup",
    "settings.import.lede":
      "Replaces everything currently stored. The file must be a Memory Palace JSON export.",
    "settings.import.file": "Backup file",
    "settings.import.submit": "Replace all data from this file",
    "settings.policies.title": "Agent write permissions",
    "settings.policies.lede":
      "Agents may record what you tell them, but a memory awaiting review is never presented as fact.",
    "settings.erase.title": "Erase everything",
    "settings.erase.lede":
      "Permanently deletes every memory, observation and entity. This cannot be undone.",
    "settings.erase.submit": "Erase all data",

    "policies.agent": "Agent",
    "policies.autoAccepted": "Auto-accepted",
    "policies.needsReview": "Needs review",
    "policies.canWrite": "Can write",
    "policies.empty":
      "No agent has written yet. Defaults apply: facts, preferences and goals are accepted; decisions need your confirmation.",

    "priorart.heading": "Prior art",
    "priorart.lede":
      "The projects we read, and what we took from them — including what we deliberately did not. An entry marked adopted or partial has to point at something in this repository. Every reference is checked against the checkout when it is saved and again when this page loads, so a claim whose file, case or commit has since moved is shown as broken rather than left looking authoritative.",
    "priorart.add.title": "Add a project",
    "priorart.add.lede":
      "Paste a GitHub link. Reading the project and writing the assessment are done for you — you only decide whether to keep it.",
    "priorart.assess": "Assess usefulness",
    "priorart.queued": "Queued…",
    "priorart.evaluating": "Reading the repository and assessing it…",
    "priorart.failed": "Assessment failed",
    "priorart.retry": "Assess again",
    "priorart.review.title": "Assessment draft",
    "priorart.review.lede":
      "Written by the model after reading the repository. Edit anything before you decide — nothing enters the list until you accept it.",
    "priorart.review.confidence": "the model's own confidence: {value}",
    "priorart.review.suggested": "Suggested status",
    "priorart.review.dropped":
      "{count} citation(s) point at nothing in this repository and were dropped",
    "priorart.review.revision": "read at {revision}",
    "priorart.adopt": "Accept",
    "priorart.dismiss": "Discard",
    "priorart.unassessed": "not assessed",
    "priorart.field.repo": "GitHub repository or link",
    "priorart.field.status": "Status",
    "priorart.field.title": "Title",
    "priorart.field.claim": "What it claims",
    "priorart.field.rationale": "Assessment",
    "priorart.field.notTaken": "What we did not take",
    "priorart.field.notTakenHint": "(optional, and the most useful field)",
    "priorart.field.kill": "Kill criterion",
    "priorart.field.killHint": "(required for watched)",
    "priorart.field.evidence": "Evidence",
    "priorart.field.evidenceHint": "(one reference per line)",
    "priorart.placeholder.title": "Trigger-augmented graph memory",
    "priorart.placeholder.claim":
      "Recall is reachability-bounded by query/memory similarity, so systems miss associative recall.",
    "priorart.placeholder.rationale":
      "Why it is or is not combinable with this product.",
    "priorart.placeholder.kill": "What result would make us build it.",
    "priorart.placeholder.evidence":
      "docs/adr/0006-confirmed-rescue-below-the-semantic-floor.md\npackages/core/src/recall/pipeline.ts:317\ncase:rec-017",
    "priorart.evidence.help":
      "A path, optionally with a line anchor (<code>file.ts:317</code> or <code>file.ts#L317</code>); <code>case:rec-017</code> for a golden-dataset case; <code>commit:abc1234</code> for the commit that adopted the idea.",
    "priorart.add.submit": "Add project",
    "priorart.empty":
      "No projects recorded yet. Add one above — including the ones you decided against, which are the most useful entries here.",
    "priorart.notTaken": "Not taken:",
    "priorart.kill": "Kill criterion:",
    "priorart.unbacked":
      "Marked {status} but no reference resolves — this claim is unbacked.",
    "priorart.noEvidence":
      "No evidence recorded. A claim of this kind has nothing behind it.",
    "priorart.added": "added {date}",
    "priorart.reviewed": "reviewed {date}",

    "priorStatus.unevaluated": "not assessed",
    "priorStatus.adopted": "adopted",
    "priorStatus.partial": "partial",
    "priorStatus.rejected": "rejected",
    "priorStatus.watched": "watched",

    "evidence.path": "file",
    "evidence.case": "case",
    "evidence.commit": "commit",

    "drawer.close": "Close details",
    "drawer.statement": "Statement",
    "drawer.editHint":
      "Editing keeps the previous wording in history rather than overwriting it.",
    "drawer.save": "Save correction",
    "drawer.archive": "Archive",
    "drawer.delete": "Delete permanently",
    "drawer.provenance": "Provenance",
    "drawer.status": "Status",
    "drawer.trueFrom": "True from",
    "drawer.trueUntil": "True until",
    "drawer.recorded": "Recorded",
    "drawer.confidence": "Confidence",
    "drawer.importance": "Importance",
    "drawer.reobserved": "Re-observed",
    "drawer.writtenBy": "Written by",
    "drawer.id": "Id",
    "drawer.howChanged": "How this changed",
    "drawer.noEarlier": "No earlier versions — this is the only statement of this fact.",

    "card.confidenceTitle": "How sure the system is that this is true",
    "card.confidence": "confidence {value}",
    "card.observed": "observed {count}×",
    "validity.range": "{from} → {until}",
    "validity.open": "{from} → now",
    "validity.until": "until {until}",

    "stats.current": "current",
    "stats.superseded": "no longer true",
    "stats.notes": "notes",
    "stats.entities": "entities",

    "toast.remembered": "Remembered {count} item(s)",
    "toast.reviewed": "Reviewed — nothing here looked worth keeping long term",
    "toast.extractionFailed":
      "Saved, but extraction failed — nothing was lost, it can be reprocessed",
    "toast.correctionSaved": "Correction saved; the previous wording is in history",
    "toast.archived": "Archived — still in history, no longer used for recall",
    "toast.deleted": "Deleted permanently",
    "toast.confirmed": "Confirmed — it can now be recalled",
    "toast.rejected": "Rejected — archived, not deleted",
    "toast.erased": "All data erased",
    "toast.restored": "Restored {memories} memories and {observations} notes",
    "toast.priorArtAdded": "Project added",
    "toast.priorArtRemoved": "Removed",
    "error.emptyMemory": "A memory cannot be empty",

    "confirm.delete":
      "Permanently delete this memory?\n\nIt will be removed from the database and cannot be recovered. Archive instead if you only want it ignored.",
    "confirm.import":
      "Replace ALL stored data with this backup?\n\nEverything currently in the database will be deleted first. This cannot be undone.",
    "confirm.erase":
      "Permanently erase everything?\n\nEvery memory, note and entity will be deleted. Export first if you might want any of it.",
    "confirm.removePriorArt":
      "Remove {repo} from the reference list?\n\nThis only removes the entry — nothing in the repository changes.",
    "confirm.dismissPriorArt":
      "Discard the assessment of {repo}?\n\nThe entry is removed. The repository is not touched, and you can assess it again.",
  },

  zh: {
    "app.title": "Memory Palace",
    "meta.description": "查看、修正并导出这个系统持有的关于你的长期记忆。",
    "a11y.skipToContent": "跳到正文",
    "nav.label": "分区",
    "nav.memories": "记忆",
    "nav.pending": "待确认",
    "nav.timeline": "时间线",
    "nav.recall": "召回测试",
    "nav.priorart": "参考资料",
    "nav.settings": "设置",
    "theme.toggle": "切换配色主题",
    "lang.toggle": "切换语言",
    "lang.other": "EN",

    "common.details": "详情",
    "common.confirm": "确认",
    "common.reject": "拒绝",
    "common.remove": "移除",
    "common.now": "现在",
    "common.unknown": "未知",
    "common.stillTrue": "仍然成立",
    "common.unknownPeriod": "时段未知",
    "common.yes": "是",
    "common.no": "否",

    "type.goal": "目标",
    "type.preference": "偏好",
    "type.fact": "事实",
    "type.decision": "决策",
    "type.relationship": "关系",
    "type.experience": "经历",
    "type.event": "事件",

    "status.active": "当前",
    "status.pending": "待确认",
    "status.superseded": "已不再成立",
    "status.archived": "已归档",

    "memories.heading": "已存记忆",
    "memories.search.label": "搜索",
    "memories.search.placeholder": "按措辞搜索，例如 Effect-TS",
    "memories.filter.type": "类型",
    "memories.filter.allTypes": "全部类型",
    "memories.filter.status": "状态",
    "memories.filter.everything": "全部",
    "memories.filter.active": "当前",
    "memories.filter.superseded": "已被取代",
    "memories.filter.archived": "已归档",
    "memories.filter.pending": "待确认",
    "memories.empty.title": "这里还是空的",
    "memories.empty.body":
      "用上面的输入框写点值得记住的东西。系统判断出哪些是长期有效之后，记忆才会出现；临时性的内容会被有意丢弃。",

    "composer.label": "告诉它一件值得记住的事",
    "composer.placeholder": "用你平常的说法写就行 —— 由系统判断什么值得保留。",
    "composer.hint": "先原样存下，再转成记忆。模型故障也不会丢掉它。",
    "composer.submit": "记住",
    "composer.working": "处理中…",

    "pending.heading": "待确认",
    "pending.lede":
      "这些没有被自动存下 —— 要么它们与已知内容冲突，要么写下它们的 Agent 对这类记忆没有权限。只确认你认可的部分。",
    "pending.empty.title": "没有待确认的内容",
    "pending.empty.body":
      "当一条记忆与已知内容冲突，或写入它的 Agent 对这类记忆不受信任时，它会落到这里。",

    "timeline.heading": "时间线",
    "timeline.lede":
      "每条记忆何时成立，而不是何时被得知。带删除线的条目已不再当前有效，但被保留下来，好让变化可追溯。",
    "timeline.empty.title": "还没有历史",
    "timeline.empty.body": "一旦有记忆被记录，这里会显示每条何时成立 —— 而不是何时被得知。",

    "recall.heading": "召回测试",
    "recall.lede":
      "问一个 Agent 会问的问题，看看究竟会交给它什么 —— 包括每条记忆为什么被选中、哪些被过滤掉了。",
    "recall.question.label": "一个 Agent 会问的问题",
    "recall.question.placeholder": "例如：Effect-TS 的 Context.Service 怎么理解？",
    "recall.mode.label": "路径",
    "recall.mode.auto": "auto（自动）",
    "recall.mode.fast": "fast（不调用模型）",
    "recall.mode.smart": "smart（理解 + 重排序）",
    "recall.history": "包含已不再成立的记忆",
    "recall.run": "运行召回",
    "recall.empty.title": "没有找到相关内容",
    "recall.empty.body":
      "这是一个正确答案，不是失败。Agent 被告知在没有个人上下文的情况下作答，而不是拿到一个勉强相关的匹配。",
    "recall.empty.diagnostics": "在 {routes} 条路由上检查了 {candidates} 个候选。",
    "recall.received": "Agent 将会收到的内容",
    "recall.escalated": "（已升级）",
    "recall.metric.path": "路径",
    "recall.metric.latency": "耗时",
    "recall.metric.tokens": "tokens",
    "recall.metric.candidates": "候选",
    "recall.metric.filtered": "已过滤",
    "recall.why.title": "每条记忆为什么被选中",
    "recall.table.memory": "记忆",
    "recall.table.type": "类型",
    "recall.table.score": "得分",
    "recall.table.fusion": "融合",
    "recall.table.recency": "新近度",
    "recall.table.importance": "重要度",
    "recall.table.matchedBy": "命中路由",
    "recall.filtered.title": "被过滤掉的内容",
    "recall.filtered.reason": "原因",
    "recall.filtered.count": "数量",

    "settings.heading": "设置与数据",
    "settings.data.title": "你的数据是你的",
    "settings.data.lede":
      "导出成你能读的格式，或者能恢复的格式。删除是真正的删除，不是一个标记。",
    "settings.export.markdown": "下载可读版本（Markdown）",
    "settings.export.json": "下载完整备份（JSON）",
    "settings.import.title": "从备份恢复",
    "settings.import.lede":
      "会替换当前已存的全部内容。文件必须是 Memory Palace 的 JSON 导出。",
    "settings.import.file": "备份文件",
    "settings.import.submit": "用此文件替换全部数据",
    "settings.policies.title": "Agent 写入权限",
    "settings.policies.lede":
      "Agent 可以记录你告诉它的事，但等待确认的记忆绝不会被当作事实呈现。",
    "settings.erase.title": "全部擦除",
    "settings.erase.lede": "永久删除每一条记忆、笔记和实体。此操作无法撤销。",
    "settings.erase.submit": "擦除全部数据",

    "policies.agent": "Agent",
    "policies.autoAccepted": "自动接受",
    "policies.needsReview": "需要确认",
    "policies.canWrite": "可写入",
    "policies.empty":
      "还没有 Agent 写入过。适用默认值：事实、偏好与目标自动接受；决策需要你确认。",

    "priorart.heading": "参考资料",
    "priorart.lede":
      "我们读过的项目，以及从中取用了什么 —— 包括刻意没有取用的部分。标为「已采纳」或「部分采纳」的条目必须指向本仓库里的某样东西。每条引用在保存时和本页加载时都会对着检出目录检查一次，所以文件、用例或提交已经移动的主张会被标成失效，而不会继续显得权威。",
    "priorart.add.title": "添加一个项目",
    "priorart.add.lede":
      "粘贴一个 GitHub 链接即可。读项目、写评估都由系统完成 —— 你只需要决定要不要留下它。",
    "priorart.assess": "评估有用性",
    "priorart.queued": "排队中…",
    "priorart.evaluating": "正在阅读仓库并评估…",
    "priorart.failed": "评估失败",
    "priorart.retry": "重新评估",
    "priorart.review.title": "评估草稿",
    "priorart.review.lede":
      "以下是模型读完后写的草稿。先改再决定 —— 在你采纳之前，它不会进入上面的清单。",
    "priorart.review.confidence": "模型自评置信度：{value}",
    "priorart.review.suggested": "建议状态",
    "priorart.review.dropped": "{count} 条引用在本仓库里找不到，已丢弃",
    "priorart.review.revision": "基于 {revision} 阅读",
    "priorart.adopt": "采纳",
    "priorart.dismiss": "忽略",
    "priorart.unassessed": "待评估",
    "priorart.field.repo": "GitHub 仓库或链接",
    "priorart.field.status": "状态",
    "priorart.field.title": "标题",
    "priorart.field.claim": "它主张什么",
    "priorart.field.rationale": "评估",
    "priorart.field.notTaken": "没有取用的部分",
    "priorart.field.notTakenHint": "（可选，也是最有用的字段）",
    "priorart.field.kill": "终止条件",
    "priorart.field.killHint": "（watched 必填）",
    "priorart.field.evidence": "证据",
    "priorart.field.evidenceHint": "（每行一条引用）",
    "priorart.placeholder.title": "触发增强的图记忆",
    "priorart.placeholder.claim":
      "召回受限于查询与记忆之间的相似度，因此系统会漏掉联想式召回。",
    "priorart.placeholder.rationale": "它为什么能与本产品结合，或者为什么不能。",
    "priorart.placeholder.kill": "什么样的结果会让我们动手去做。",
    "priorart.placeholder.evidence":
      "docs/adr/0006-confirmed-rescue-below-the-semantic-floor.md\npackages/core/src/recall/pipeline.ts:317\ncase:rec-017",
    "priorart.evidence.help":
      "一个路径，可以带行号锚点（<code>file.ts:317</code> 或 <code>file.ts#L317</code>）；<code>case:rec-017</code> 表示黄金用例；<code>commit:abc1234</code> 表示采纳该想法的提交。",
    "priorart.add.submit": "添加项目",
    "priorart.empty":
      "还没有记录任何项目。在上面添加一个 —— 包括你决定不采纳的那些，它们通常是这里最有用的条目。",
    "priorart.notTaken": "没有取用：",
    "priorart.kill": "终止条件：",
    "priorart.unbacked": "标为 {status}，但没有任何引用能解析 —— 这条主张没有依据。",
    "priorart.noEvidence": "没有记录证据。这类主张背后什么都没有。",
    "priorart.added": "添加于 {date}",
    "priorart.reviewed": "复看过 {date}",

    "priorStatus.unevaluated": "待评估",
    "priorStatus.adopted": "已采纳",
    "priorStatus.partial": "部分采纳",
    "priorStatus.rejected": "已否决",
    "priorStatus.watched": "关注中",

    "evidence.path": "文件",
    "evidence.case": "用例",
    "evidence.commit": "提交",

    "drawer.close": "关闭详情",
    "drawer.statement": "陈述",
    "drawer.editHint": "编辑会把先前的措辞保留在历史里，而不是覆盖它。",
    "drawer.save": "保存修正",
    "drawer.archive": "归档",
    "drawer.delete": "永久删除",
    "drawer.provenance": "来源",
    "drawer.status": "状态",
    "drawer.trueFrom": "起始",
    "drawer.trueUntil": "结束",
    "drawer.recorded": "记录于",
    "drawer.confidence": "置信度",
    "drawer.importance": "重要度",
    "drawer.reobserved": "重复观察",
    "drawer.writtenBy": "写入者",
    "drawer.id": "Id",
    "drawer.howChanged": "它如何变化",
    "drawer.noEarlier": "没有更早的版本 —— 这是该事实唯一的陈述。",

    "card.confidenceTitle": "系统有多确定这是真的",
    "card.confidence": "置信度 {value}",
    "card.observed": "已观察 {count} 次",
    "validity.range": "{from} → {until}",
    "validity.open": "{from} → 现在",
    "validity.until": "到 {until}",

    "stats.current": "当前",
    "stats.superseded": "已不再成立",
    "stats.notes": "笔记",
    "stats.entities": "实体",

    "toast.remembered": "已记住 {count} 条",
    "toast.reviewed": "已审阅 —— 这里没有值得长期保留的内容",
    "toast.extractionFailed": "已保存，但抽取失败 —— 没有丢失任何东西，可以重新处理",
    "toast.correctionSaved": "修正已保存；先前的措辞在历史里",
    "toast.archived": "已归档 —— 仍在历史中，不再用于召回",
    "toast.deleted": "已永久删除",
    "toast.confirmed": "已确认 —— 现在可以被召回了",
    "toast.rejected": "已拒绝 —— 归档而非删除",
    "toast.erased": "全部数据已擦除",
    "toast.restored": "已恢复 {memories} 条记忆和 {observations} 条笔记",
    "toast.priorArtAdded": "项目已添加",
    "toast.priorArtRemoved": "已移除",
    "error.emptyMemory": "记忆内容不能为空",

    "confirm.delete":
      "永久删除这条记忆？\n\n它会从数据库中移除，无法恢复。如果只是想让它不再被使用，请改用归档。",
    "confirm.import":
      "用这个备份替换全部已存数据？\n\n当前数据库里的所有内容会先被删除。此操作无法撤销。",
    "confirm.erase":
      "永久擦除全部内容？\n\n每一条记忆、笔记和实体都会被删除。如果你可能还想留着，请先导出。",
    "confirm.removePriorArt":
      "把 {repo} 从参考资料清单里移除？\n\n这只移除该条目 —— 仓库里什么都没有改变。",
    "confirm.dismissPriorArt":
      "丢弃对 {repo} 的评估？\n\n该条目会被移除。仓库本身不受影响，你也可以重新评估。",
  },
}

/** Keys present in every language. Throws at import time if the tables diverge. */
export function keys(lang) {
  return Object.keys(MESSAGES[lang] ?? {})
}

export function languages() {
  return LANGS.slice()
}

function normaliseLang(value) {
  if (!value) return null
  const lower = String(value).toLowerCase()
  if (lower.startsWith("zh")) return "zh"
  if (lower.startsWith("en")) return "en"
  return null
}

/**
 * Interpolate `{name}` placeholders.
 *
 * A missing parameter is left visible as `{name}` rather than replaced with
 * "undefined": a half-rendered sentence is easier to diagnose than a plausible one.
 */
export function t(key, params) {
  const lang = currentLang()
  const value = MESSAGES[lang]?.[key] ?? MESSAGES.en[key] ?? key
  if (!params) return value
  return value.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  )
}

let active = null

export function currentLang() {
  return active ?? "en"
}

/** Where the choice comes from: the user's, then the browser's, then English. */
export function initialLang(storage) {
  const saved = normaliseLang(storage?.getItem("mp-lang"))
  if (saved) return saved
  const fromNavigator =
    normaliseLang(typeof navigator === "undefined" ? null : navigator.language) ??
    normaliseLang(
      typeof navigator === "undefined" ? null : (navigator.languages ?? []).find(Boolean),
    )
  return fromNavigator ?? "en"
}

export function setLang(lang) {
  active = normaliseLang(lang) ?? "en"
  if (typeof document !== "undefined") {
    // Screen readers take pronunciation from this, so it has to follow the text.
    document.documentElement.lang = active === "zh" ? "zh-CN" : "en"
    document.documentElement.dataset.lang = active
    applyStatic(document)
  }
  return active
}

const ATTR_TARGETS = [
  ["i18nPlaceholder", "placeholder"],
  ["i18nAriaLabel", "aria-label"],
  ["i18nTitle", "title"],
  ["i18nContent", "content"],
  ["i18nValue", "value"],
]

/**
 * Fill in the static markup.
 *
 * `data-i18n` sets text, and `data-i18n-html` sets markup for the handful of
 * strings that carry a `<code>` or `<em>`. That is safe because the dictionary is
 * ours and static — never user input — and `esc()` is still applied to anything
 * interpolated into a template.
 */
export function applyStatic(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n)
  }
  for (const el of root.querySelectorAll("[data-i18n-html]")) {
    el.innerHTML = t(el.dataset.i18nHtml)
  }
  for (const [datasetKey, attribute] of ATTR_TARGETS) {
    const selector = `[data-${datasetKey.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}]`
    for (const el of root.querySelectorAll(selector)) {
      el.setAttribute(attribute, t(el.dataset[datasetKey]))
    }
  }
  if (typeof document !== "undefined" && root === document) {
    document.title = t("app.title")
  }
}

/** Type filter and chip labels. Falls back to the raw value for an unknown type. */
export function typeLabel(type) {
  const key = `type.${type}`
  const value = t(key)
  return value === key ? type : value
}

export function statusLabel(status) {
  const key = `status.${status}`
  const value = t(key)
  return value === key ? status : value
}

export function priorStatusLabel(status) {
  const key = `priorStatus.${status}`
  const value = t(key)
  return value === key ? status : value
}

export function evidenceLabel(kind) {
  const key = `evidence.${kind}`
  const value = t(key)
  return value === key ? kind : value
}

export const MESSAGES_BY_LANG = MESSAGES
