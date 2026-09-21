import type { ExtractionCase } from "./types.js"

/**
 * Extraction cases.
 *
 * Each case pairs an observation with the memories that SHOULD come out and,
 * just as importantly, the statements that must NOT be stored. Over-extraction
 * is the failure mode that quietly ruins a memory system: a hundred plausible
 * but useless memories drown the ten that matter.
 */
export const extractionCases: ExtractionCase[] = [
  {
    id: "ext-001",
    note: "The design doc's own example: one sentence, two distinct memories of different types.",
    observation:
      "我最近开始系统学习 Effect-TS。以后你给我讲 TypeScript 的时候，先从整体结构和设计思想讲，再深入 API。",
    occurredAt: "2026-09-01T00:00:00.000Z",
    expect: [
      // "started learning X" is genuinely ambiguous between a goal and an
      // experience; asserting one measures the author, not the system.
      { types: ["goal", "experience"], contentContains: ["Effect-TS"], mustHave: true },
      { type: "preference", contentContains: ["整体结构", "设计思想"], mustHave: true },
    ],
    mustNotExtract: [
      // The trap: generalising "learning Effect-TS" into a durable liking.
      { contentContains: ["喜欢 Effect-TS"] },
      // The trap: storing the current question as a memory.
      { contentContains: ["怎么理解", "Context.Service"] },
    ],
  },
  {
    id: "ext-002",
    note: "An explicit, durable preference about how help should be given.",
    observation: "我希望你先给结论，再讲推导过程，不要一上来就贴大段代码。",
    occurredAt: "2026-09-02T00:00:00.000Z",
    expect: [{ type: "preference", contentContains: ["结论"], mustHave: true }],
    mustNotExtract: [{ contentContains: ["大段代码"] }],
  },
  {
    id: "ext-003",
    note: "Two independent facts in one sentence. The prompt says to split compound statements, so both are expected.",
    observation: "我的主力机器是 M3 Max 的 MacBook Pro，本地跑 Postgres 18。",
    occurredAt: "2026-09-03T00:00:00.000Z",
    expect: [
      { type: "fact", contentContains: ["M3 Max"], mustHave: true },
      { type: "fact", contentContains: ["Postgres"], mustHave: true },
    ],
  },
  {
    id: "ext-004",
    note: "A decision, including the reasoning behind it.",
    observation: "我们决定后端用 TypeScript 而不是 Python，主要是为了避免双语言维护成本。",
    occurredAt: "2026-09-04T00:00:00.000Z",
    expect: [
      { type: "decision", contentContains: ["TypeScript"], mustHave: true },
      // The rationale is durable in its own right: it is what makes the
      // decision revisitable later rather than an arbitrary preference.
      { contentContains: ["维护成本"], mustHave: true },
    ],
  },
  {
    id: "ext-005",
    note: "A change of state must be captured as a change, not as a new independent fact.",
    observation: "我现在已经不太写 Java 了，主要精力都放在 TypeScript 上。",
    occurredAt: "2026-09-05T00:00:00.000Z",
    expect: [{ contentContains: ["Java"], mustHave: true }],
  },
  {
    id: "ext-006",
    note: "A relationship between two entities rather than a property of the user.",
    observation: "Memory Palace 这个项目用 PostgreSQL 加 pgvector 做存储。",
    occurredAt: "2026-09-06T00:00:00.000Z",
    expect: [{ contentContains: ["pgvector"], mustHave: true }],
  },
  {
    id: "ext-007",
    note: "A negative case: nothing durable here. A correct system stores nothing.",
    observation: "帮我看看这个报错是什么意思？",
    occurredAt: "2026-09-07T00:00:00.000Z",
    expect: [],
    mustNotExtract: [{ contentContains: ["报错"] }],
  },
  {
    id: "ext-008",
    note: "A negative case: a transient state that will not matter next month.",
    observation: "我今天有点累，状态不太好。",
    occurredAt: "2026-09-08T00:00:00.000Z",
    expect: [],
    mustNotExtract: [{ contentContains: ["累"] }],
  },
  {
    id: "ext-009",
    note: "A durable experience with lasting relevance.",
    observation: "我以前在一家做支付的公司待过三年，负责风控系统。",
    occurredAt: "2026-09-09T00:00:00.000Z",
    expect: [
      { types: ["experience", "fact"], contentContains: ["支付"], mustHave: true },
      { contentContains: ["风控"], mustHave: true },
    ],
  },
  {
    id: "ext-010",
    note: "A long-term goal with a concrete subject.",
    observation: "我今年的目标是把手上的 Agent Harness 做成能每天用的东西。",
    occurredAt: "2026-09-10T00:00:00.000Z",
    expect: [{ types: ["goal", "decision"], contentContains: ["Agent Harness"], mustHave: true }],
  },
  {
    id: "ext-011",
    note: "An event anchored in time.",
    observation: "2026 年 9 月 20 日我开始研究 Memory Palace 这个方向。",
    occurredAt: "2026-09-20T00:00:00.000Z",
    expect: [{ contentContains: ["Memory Palace"], mustHave: true }],
  },
  {
    id: "ext-012",
    note: "Mixed input: one durable preference plus conversational filler.",
    observation:
      "这个方案挺有意思的。不过我更希望文档先用图讲清楚数据流，再补细节。另外明天记得提醒我开会。",
    occurredAt: "2026-09-12T00:00:00.000Z",
    expect: [
      { type: "preference", contentContains: ["数据流"], mustHave: true },
      // The reminder is a distinct statement; splitting it off is correct.
      { contentContains: ["开会"], mustHave: false },
    ],
    mustNotExtract: [{ contentContains: ["有意思"] }],
  },
]
