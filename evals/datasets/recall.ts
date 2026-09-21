import type { RecallCase } from "./types.js"

/**
 * Recall cases, mapped onto the six cases the design doc calls out in §26.
 *
 * The negative cases matter as much as the positive ones: a system that always
 * returns something cannot be trusted, because the user can never tell "I know
 * nothing about this" from "here is something vaguely related".
 */
export const recallCases: RecallCase[] = [
  {
    id: "rec-001", // doc Case 1: are stated preferences recalled?
    note: "A preference stated in different words must still be recalled.",
    memories: [
      { type: "preference", content: "用户喜欢先理解整体结构和设计思想，再深入具体 API" },
      { type: "goal", content: "用户正在系统学习 Effect-TS" },
      { type: "fact", content: "用户使用 PostgreSQL 作为主要数据库" },
    ],
    query: "讲一下 Effect-TS 的 Context.Service 应该怎么理解",
    expected: ["Effect-TS"],
    forbidden: ["PostgreSQL"],
  },
  {
    id: "rec-002", // doc Case 1 variant: preference applies to the current task
    note: "The stated preference should surface for a request to explain something.",
    memories: [
      { type: "preference", content: "用户喜欢先理解整体结构和设计思想，再深入具体 API" },
      { type: "fact", content: "用户使用 PostgreSQL 作为主要数据库" },
    ],
    query: "帮我讲讲这个模块的设计",
    expected: ["设计思想"],
  },
  {
    id: "rec-003", // doc Case 2: is the old memory correctly replaced?
    note: "Asking about the present must not return a superseded memory.",
    memories: [
      {
        type: "fact",
        content: "用户使用 Vue",
        occurredAt: "2025-01-01T00:00:00.000Z",
        validUntil: "2026-06-01T00:00:00.000Z",
        status: "superseded",
      },
      { type: "fact", content: "用户改用 React", occurredAt: "2026-06-01T00:00:00.000Z" },
    ],
    query: "用户现在用什么前端框架？",
    expected: ["React"],
    forbidden: ["Vue"],
  },
  {
    id: "rec-004", // doc Case 5: temporal accuracy
    note: "Asking about the past must return what was true THEN.",
    memories: [
      {
        type: "fact",
        content: "用户使用 Vue",
        occurredAt: "2025-01-01T00:00:00.000Z",
        validUntil: "2026-06-01T00:00:00.000Z",
        status: "superseded",
      },
      { type: "fact", content: "用户改用 React", occurredAt: "2026-06-01T00:00:00.000Z" },
    ],
    query: "用户用 Vue 吗？",
    asOf: "2025-06-01T00:00:00.000Z",
    includeHistory: true,
    expected: ["Vue"],
  },
  {
    id: "rec-005", // doc Case 4: unrelated memories must be filtered
    note: "A question with no connection to any memory must return nothing.",
    memories: [
      { type: "fact", content: "用户使用 PostgreSQL 作为主要数据库" },
      { type: "goal", content: "用户正在系统学习 Effect-TS" },
      { type: "preference", content: "用户喜欢先理解整体结构和设计思想" },
    ],
    query: "今天东京的天气怎么样？",
    expected: [],
    forbidden: ["PostgreSQL", "Effect-TS", "设计思想"],
    expectEmpty: true,
  },
  {
    id: "rec-006", // doc Case 4 variant: a memory that exists but is irrelevant
    note: "Knowing something about the user does not make it relevant to every question.",
    memories: [
      { type: "fact", content: "用户的猫叫豆豆" },
      { type: "fact", content: "用户使用 PostgreSQL 作为主要数据库" },
    ],
    query: "用 Python 写一个快速排序",
    expected: [],
    forbidden: ["豆豆"],
    expectEmpty: true,
  },
  {
    id: "rec-007", // doc Case 6: entities must be distinguished
    note: "Two projects sharing a technology must not be conflated.",
    memories: [
      { type: "relationship", content: "Memory Palace 使用 PostgreSQL 存储" },
      { type: "relationship", content: "数据看板项目使用 MySQL 存储" },
    ],
    query: "Memory Palace 用什么数据库？",
    expected: ["Memory Palace"],
  },
  {
    id: "rec-008", // doc Case 3: conflict handling
    note: "A memory awaiting confirmation must not be presented as established fact.",
    memories: [
      // Unconfirmed: contradicts an earlier statement, so it sits in the
      // confirmation queue and must never be presented as established fact.
      { type: "fact", content: "用户目前在北京工作", status: "pending" },
      { type: "preference", content: "用户喜欢简洁的回答" },
    ],
    query: "用户在哪里工作？",
    expected: [],
    forbidden: ["北京"],
    expectEmpty: true,
  },
  {
    id: "rec-009",
    note: "A goal stated long ago must still be retrievable.",
    memories: [
      {
        type: "goal",
        content: "用户的目标是把 Agent Harness 做成每天都能用的工具",
        occurredAt: "2025-01-01T00:00:00.000Z",
      },
      { type: "preference", content: "用户喜欢简洁的回答" },
    ],
    query: "Agent Harness 下一步应该做什么？",
    expected: ["Agent Harness"],
  },
  {
    id: "rec-010",
    note: "Historical context requested explicitly must include the superseded version.",
    memories: [
      {
        type: "fact",
        content: "用户使用 Vue",
        occurredAt: "2025-01-01T00:00:00.000Z",
        validUntil: "2026-06-01T00:00:00.000Z",
        status: "superseded",
      },
      { type: "fact", content: "用户改用 React", occurredAt: "2026-06-01T00:00:00.000Z" },
    ],
    query: "用户之前用什么框架？",
    includeHistory: true,
    expected: ["Vue"],
  },
  {
    id: "rec-011",
    note: "An engineering preference must beat an unrelated event that is merely recent.",
    memories: [
      {
        type: "event",
        content: "用户 2026 年 9 月 20 日开始研究 Memory Palace",
        occurredAt: "2026-09-20T00:00:00.000Z",
      },
      {
        type: "preference",
        content: "用户希望解释技术时先讲整体架构再看细节",
        occurredAt: "2025-01-01T00:00:00.000Z",
      },
    ],
    query: "讲一个技术概念时应该怎么组织？",
    expected: ["整体架构"],
  },
  {
    id: "rec-012",
    note: "An empty store must return nothing rather than erroring.",
    memories: [],
    query: "用户喜欢什么？",
    expected: [],
    expectEmpty: true,
  },
  {
    id: "rec-013",
    // The live case from the README's floor analysis: cosine 0.432 against a
    // formula that assigns no interesting weight to "讲技术概念" once it shares
    // tokens with 整体结构/设计思想 only through meaning. Measured at 0.432 for
    // bge-m3 — true hard paraphrase.
    //
    // The offline providers CANNOT pass this: the mock embedder is a hashing
    // bag-of-tokens, so it has no notion of a paraphrase at all (the harness
    // doc says exactly this — paraphrase recall is a property of the embedder).
    // The case exists for `pnpm eval --provider real`, where it is the
    // regression guard for the smart path's confirmed rescue: a candidate this
    // far below the floor may only be recalled if the reranker vouches for it.
    note: "Hard paraphrase: the query shares almost no surface form with the memory (real-stack case).",
    memories: [
      {
        type: "preference",
        content: "用户希望在被讲解 TypeScript 时，先了解整体结构和设计思想，再深入具体 API",
      },
      { type: "fact", content: "用户使用 PostgreSQL 作为主要数据库" },
    ],
    query: "讲技术概念的时候应该怎么组织？",
    expected: ["整体结构"],
    forbidden: ["PostgreSQL"],
  },
  {
    id: "rec-014",
    // The trap the rescue could open: "记忆宫殿" (the mnemonic technique) is
    // topically adjacent to the Memory Palace project, so a real embedder can
    // put it inside the probe band. Vouching for it would be a false positive
    // dressed up as semantic recall, and the reranker has to refuse.
    //
    // The memory texts deliberately avoid the token 记忆 so the offline lexical
    // route cannot match either: this case is decidable in both stacks.
    note: "A question about the mnemonic technique must not surface memories about the project.",
    memories: [
      { type: "relationship", content: "Memory Palace 使用 PostgreSQL 存储数据" },
      { type: "goal", content: "用户希望多个 Agent 共享同一份长期上下文" },
    ],
    query: "怎么练习记忆宫殿？",
    expected: [],
    forbidden: ["Memory Palace", "PostgreSQL"],
    expectEmpty: true,
  },
]
