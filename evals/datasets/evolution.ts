import type { EvolutionCase } from "./types.js"

/**
 * Evolution cases.
 *
 * These encode the distinction the design doc calls out in §8: a change over
 * time is a SUPERSEDE, never a silent overwrite and never a CONTRADICT. Getting
 * this wrong either destroys history or floods the confirmation queue.
 */
export const evolutionCases: EvolutionCase[] = [
  {
    id: "evo-001",
    note: "Design doc Case 2: the situation changed, so the old memory is superseded.",
    existing: [{ type: "fact", content: "用户使用 Vue", validFrom: "2025-01-01T00:00:00.000Z" }],
    observation: "我现在不用 Vue 了，改用 React。",
    candidate: { type: "fact", content: "用户改用 React" },
    expectDecision: "SUPERSEDE",
    expectSupersededContentContains: "Vue",
    expectActiveContentContains: "React",
  },
  {
    id: "evo-002",
    note: "Design doc Case 1: the same fact restated with different wording is a duplicate.",
    existing: [
      { type: "goal", content: "用户正在学习 Effect-TS", validFrom: "2026-01-01T00:00:00.000Z" },
    ],
    observation: "我最近在系统学习 Effect-TS。",
    candidate: { type: "goal", content: "用户正在系统学习 Effect-TS" },
    expectDecision: "DUPLICATE",
    // "系统学习" adds a detail over "学习"; either verdict is defensible.
    acceptDecisions: ["REFINE"],
    expectActiveContentContains: "Effect-TS",
  },
  {
    id: "evo-003",
    note: "Same fact, materially more detail: refine rather than duplicate or replace.",
    existing: [
      { type: "preference", content: "用户喜欢先理解架构", validFrom: "2026-01-01T00:00:00.000Z" },
    ],
    observation: "对，我喜欢先理解整体架构和设计思想，再去看具体的 API 实现。",
    candidate: {
      type: "preference",
      content: "用户喜欢先理解整体架构和设计思想，再看具体 API 实现",
    },
    expectDecision: "REFINE",
    expectActiveContentContains: "架构",
  },
  {
    id: "evo-004",
    note: "A genuinely new fact about an unfamiliar subject must not be forced into an existing memory.",
    existing: [{ type: "fact", content: "用户使用 React", validFrom: "2026-01-01T00:00:00.000Z" }],
    observation: "我养了一只叫豆豆的猫。",
    candidate: { type: "fact", content: "用户养了一只叫豆豆的猫" },
    expectDecision: "NEW",
    expectActiveContentContains: "豆豆",
  },
  {
    id: "evo-005",
    note: "New detail about an existing preference refines it; it does not invalidate it.",
    existing: [
      { type: "preference", content: "用户喜欢 Rust", validFrom: "2026-01-01T00:00:00.000Z" },
    ],
    observation: "我现在主要写 TypeScript，Rust 只是业余看看。",
    candidate: {
      type: "preference",
      content: "用户喜欢 Rust，但主要写 TypeScript，Rust 只是业余看看",
    },
    expectDecision: "REFINE",
  },
  {
    id: "evo-006",
    note: "An explicit negation of a previously stated preference.",
    existing: [
      {
        type: "preference",
        content: "用户喜欢在回答里看到大段代码示例",
        validFrom: "2026-01-01T00:00:00.000Z",
      },
    ],
    observation: "我其实不太喜欢大段代码了，更想看思路。",
    candidate: { type: "preference", content: "用户不喜欢在回答里看到大段代码示例" },
    expectDecision: "SUPERSEDE",
    expectSupersededContentContains: "大段代码",
  },
  {
    id: "evo-007",
    note: "Not mentioning something again is not a supersede.",
    existing: [
      { type: "fact", content: "用户使用 PostgreSQL", validFrom: "2026-01-01T00:00:00.000Z" },
    ],
    observation: "今天研究了一下 HNSW 索引的参数。",
    candidate: { type: "fact", content: "用户研究了 HNSW 索引的参数" },
    expectDecision: "NEW",
    // Storing nothing also satisfies the intent: this case proves a passing mention does
    acceptDecisions: ["UNKNOWN"],
  },
  {
    id: "evo-008",
    note: "A restatement with a stronger commitment reinforces rather than creating a version.",
    existing: [
      {
        type: "decision",
        content: "Agent Harness 的后端选 TypeScript",
        validFrom: "2026-01-01T00:00:00.000Z",
      },
    ],
    observation: "确认一下，后端就是 TypeScript，不改了。",
    candidate: { type: "decision", content: "Agent Harness 的后端选 TypeScript" },
    expectDecision: "DUPLICATE",
    // The added commitment ("不改了") is a detail, so REFINE is equally valid.
    acceptDecisions: ["REFINE"],
  },
  {
    id: "evo-009",
    note: "Two incompatible claims about the same period: neither may win silently.",
    existing: [
      { type: "fact", content: "用户目前在北京工作", validFrom: "2026-06-01T00:00:00.000Z" },
    ],
    observation: "我一直在上海啊，没去过北京工作。",
    candidate: { type: "fact", content: "用户目前在上海工作" },
    expectDecision: "CONTRADICT",
  },
  {
    id: "evo-010",
    note: "Returning to a previous state creates a THIRD version, not a revival of the first.",
    existing: [
      { type: "fact", content: "用户使用 React", validFrom: "2025-01-01T00:00:00.000Z" },
      { type: "fact", content: "用户使用 Vue", validFrom: "2026-01-01T00:00:00.000Z" },
    ],
    observation: "我又用回 React 了。",
    candidate: { type: "fact", content: "用户使用 React" },
    expectDecision: "SUPERSEDE",
    expectActiveContentContains: "React",
  },
]
