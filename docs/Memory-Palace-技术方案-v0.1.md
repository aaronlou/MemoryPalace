# Memory Palace（记忆宫殿）
## AI Agent 长期记忆系统技术方案

> 状态：Architecture Draft  
> 版本：v0.1  
> 日期：2026-09-21

---

## 1. 文档目标

Memory Palace 的核心目标不是构建一个“带向量搜索的聊天历史库”，而是构建一个：

> **面向人类自然写入、面向 Agent 智能读取的个人长期记忆基础设施。**

核心设计原则：

1. **Write for Human**：用户写入应尽可能自然、低负担。
2. **Read for Agent**：Agent 读取时获得与当前任务真正相关的记忆，而不是大量历史记录。
3. **Memory First**：先设计 Memory Model，再决定数据库、Embedding、Graph 等底层技术。
4. **Memory ≠ Chat History**：聊天记录是原始经验，Memory 是经过提取、整理、验证后的长期信息。
5. **Temporal Awareness**：记忆必须能够表达“现在有效”“过去有效”“已经失效”等时间语义。
6. **Conflict Aware**：新旧记忆发生冲突时不能简单覆盖，应保留变化过程。
7. **Agent Agnostic**：记忆系统不应绑定某一个 Agent、模型或厂商。
8. **Retrieval over Storage**：系统真正的价值不在“存了多少”，而在“Agent 能否在正确的时候取到正确的信息”。

---

# 2. 产品定位

## 2.1 不是第二个聊天记录库

最简单的实现通常是：

```text
用户输入
   ↓
Embedding
   ↓
Vector DB
   ↓
Agent Retrieval
```

这本质上是一个 RAG 系统。

Memory Palace 希望解决的问题更进一步：

```text
                 Human Input
                      │
                      ▼
             Memory Formation
                      │
                      ▼
              ┌───────────────┐
              │  Memory Model │
              └───────┬───────┘
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
      Semantic      Temporal    Entity
       Index         Index      Index
          │           │           │
          └───────────┼───────────┘
                      ▼
                 Agent Recall
                      │
                      ▼
              Context Assembly
                      │
                      ▼
                    Agent
```

因此，Vector DB 只是 Retrieval Infrastructure 的一部分，而不是 Memory Palace 的核心。

---

# 3. 核心概念

## 3.1 Experience

Experience 是系统接收到的原始信息。

例如：

> “最近开始学习 Effect-TS，以后如果讨论 Agent Harness，希望从 Agent 工程角度解释。”

Experience 可以来自：

- 用户主动输入
- Chat
- Agent 对话
- 用户导入的文档
- 第三方应用
- Agent 行为
- 外部事件

Experience 不等于 Memory。

---

## 3.2 Memory

Memory 是系统认为未来可能对用户或 Agent 有持续价值的信息。

例如：

```text
用户正在学习 Effect-TS。
```

或者：

```text
用户在学习新技术时，希望先理解结构、框架和思想，再进入具体实现。
```

Memory 应具有明确的语义、来源、时间和置信度。

---

## 3.3 Memory Candidate

系统不能把所有 Experience 都直接写成长期 Memory。

因此引入：

```text
Experience
    ↓
Memory Candidate
    ↓
Validation
    ↓
Memory
```

Candidate 是“可能值得长期保存”的信息。

例如：

> “这个 Effect-TS 项目挺有意思。”

可能只是一时评价，不一定值得成为长期 Memory。

而：

> “以后学习技术时，希望先从整体架构和思想入手。”

明显具有更强的长期价值。

---

# 4. Memory Model

建议第一版至少支持以下 Memory 类型。

| Type | 含义 | 示例 |
|---|---|---|
| Fact | 客观事实 | 用户正在使用 Node.js |
| Preference | 用户偏好 | 喜欢先理解架构再看细节 |
| Experience | 经历 | 曾经开发过某 Agent |
| Decision | 已做决定 | Agent Harness 使用 TypeScript |
| Relationship | 关系 | 项目 A 使用技术 B |
| Goal | 目标 | 希望系统学习 Effect-TS |
| Event | 事件 | 2026-09-20 开始研究 Memory Palace |

---

# 5. Memory 数据结构

建议第一版使用关系型数据库作为 Source of Truth。

示意：

```typescript
type MemoryType =
  | "fact"
  | "preference"
  | "experience"
  | "decision"
  | "relationship"
  | "goal"
  | "event";

interface Memory {
  id: string;

  userId: string;

  type: MemoryType;

  content: string;

  summary?: string;

  entities?: EntityRef[];

  source: MemorySource;

  confidence: number;

  importance: number;

  createdAt: Date;

  validFrom?: Date;

  validUntil?: Date;

  supersededBy?: string;

  status: "active" | "superseded" | "archived";

  metadata?: Record<string, unknown>;
}
```

其中：

### confidence

表示系统对“这条 Memory 是否正确”的信心。

例如：

```text
0.95
```

可能来自用户明确声明。

而：

```text
0.62
```

可能只是模型从上下文中推断出来。

---

### importance

表示 Memory 对未来 Agent 的潜在价值。

例如：

```text
用户喜欢咖啡
```

可能 importance 较低。

而：

```text
用户希望学习技术时先理解整体架构
```

可能 importance 较高。

---

# 6. 时间模型

长期记忆最大的难点之一是：

> **Memory 会变化。**

例如：

```text
2025：
用户使用 React

2026：
用户开始使用 Vue

2027：
用户重新使用 React
```

因此不能简单：

```sql
UPDATE memory
SET content = ...
```

否则历史变化会消失。

建议使用 Temporal Memory：

```text
Memory A
valid_from = 2025
valid_until = 2026

Memory B
valid_from = 2026
valid_until = NULL
```

或者采用版本关系：

```text
Memory A
    │
    └── superseded_by
            ↓
        Memory B
```

这样 Agent 可以回答：

> “你现在使用什么技术？”

也可以回答：

> “你之前为什么从 React 转到 Vue？”

---

# 7. Memory Formation

Memory Formation 是整个系统最核心的 AI Pipeline。

```text
Raw Experience
      ↓
Candidate Extraction
      ↓
Classification
      ↓
Deduplication
      ↓
Entity Resolution
      ↓
Conflict Detection
      ↓
Importance / Confidence
      ↓
Memory Persistence
```

---

## 7.1 Candidate Extraction

LLM 从用户输入中提取潜在 Memory。

例如：

输入：

> “我最近开始学习 Effect-TS，以后你讲 TypeScript 的时候，可以多结合 Agent Harness。”

候选：

```json
[
  {
    "type": "goal",
    "content": "用户正在学习 Effect-TS"
  },
  {
    "type": "preference",
    "content": "讨论 TypeScript 时，希望结合 Agent Harness"
  }
]
```

---

## 7.2 Classification

判断 Memory 属于哪一类：

```text
Fact
Preference
Experience
Decision
Relationship
Goal
Event
```

---

## 7.3 Deduplication

例如已有：

```text
用户正在学习 Effect-TS
```

新输入：

```text
我最近在系统研究 Effect-TS。
```

不应该产生两条完全独立的 Memory。

应该：

```text
New Candidate
      ↓
Similarity Search
      ↓
Existing Memory
      ↓
Merge / Reinforce
```

---

# 8. Conflict Resolution

这是 Memory 系统与普通 RAG 系统的重要区别。

例如：

已有：

```text
用户喜欢 Java
```

后来：

```text
我现在已经不太写 Java 了。
```

系统不能简单：

```text
DELETE Java preference
```

应该形成：

```text
Old Memory
    ↓
Superseded
    ↓
New Memory
```

并保留：

```text
old.valid_until
new.valid_from
```

对于冲突严重的情况，可以让 Agent 或用户确认。

---

# 9. Recall Architecture

Memory Palace 的第二个核心能力是 Recall。

输入不是：

```text
memory_id
```

而是：

```text
context
```

例如：

```json
{
  "query": "帮我设计一个 Agent Harness",
  "agent": "coding-agent",
  "task_type": "architecture"
}
```

系统根据 context 选择相关 Memory。

---

# 10. Recall Pipeline

```text
Agent Context
      ↓
Query Understanding
      ↓
Candidate Retrieval
      │
      ├── Semantic Search
      ├── Keyword Search
      ├── Entity Search
      ├── Temporal Search
      └── Relationship Search
      ↓
Candidate Ranking
      ↓
Conflict Filtering
      ↓
Context Assembly
      ↓
Recall Result
```

---

# 11. 为什么不能只使用 Vector Search

假设 Memory：

```text
用户正在学习 Effect-TS
```

Query：

```text
设计 TypeScript Agent Harness
```

Embedding Search 很可能可以找到。

但下面这种问题就不一定：

```text
用户目前正在做什么项目？
```

这更依赖：

- 时间
- Entity
- Relationship
- Goal
- Status

因此 Recall 应该是 Hybrid Retrieval：

```text
Semantic
+
Lexical
+
Temporal
+
Entity
+
Relational
+
Importance
+
Recency
```

---

# 12. Memory Ranking

候选 Memory 可以使用一个综合评分：

```text
Score =
    α × SemanticSimilarity
  + β × Importance
  + γ × Recency
  + δ × EntityMatch
  + ε × TaskMatch
  - ζ × ConflictRisk
```

第一版不需要追求复杂数学模型。

重点是建立可解释的 Ranking Pipeline。

例如：

```text
Memory:
用户正在学习 Effect-TS

Semantic Similarity   0.92
Task Match            0.88
Importance             0.80
Recency                0.75

Final Score            0.87
```

---

# 13. Context Assembly

Recall 不是简单返回 Memory 列表。

应该输出适合 Agent 消费的 Context。

例如：

```json
{
  "memories": [
    {
      "type": "goal",
      "content": "用户正在学习 Effect-TS",
      "confidence": 0.95
    },
    {
      "type": "preference",
      "content": "用户喜欢先理解结构、框架和思想，再深入实现",
      "confidence": 0.98
    }
  ]
}
```

未来可以进一步形成：

```text
Memory Context
├── Relevant Facts
├── User Preferences
├── Current Goals
├── Relevant Past Decisions
└── Relevant Experiences
```

Agent 不需要理解 Memory Palace 内部数据库结构。

---

# 14. Agent API

建议提供非常简单的抽象。

## remember

```typescript
await memory.remember({
  userId,
  experience
});
```

Agent 不需要决定：

- 是否 embedding
- 写哪张表
- 是否建立关系
- 如何去重

这些由 Memory Palace 完成。

---

## recall

```typescript
const memories = await memory.recall({
  userId,
  context: {
    query,
    taskType,
    entities
  }
});
```

---

# 15. MCP Interface

Memory Palace 非常适合通过 MCP 暴露给 Agent。

第一版可以设计：

```text
memory_remember
memory_recall
memory_search
memory_update
memory_forget
```

其中 Agent 最常使用：

```text
memory_recall
```

和：

```text
memory_remember
```

例如：

```text
Agent
 ↓
MCP
 ↓
Memory Palace
 ↓
Recall
 ↓
Relevant Memories
```

这样 Memory Palace 可以服务：

- ChatGPT-like Agent
- Claude-like Agent
- Coding Agent
- Personal Assistant
- 企业 Agent
- 用户自己的 Agent Harness

---

# 16. Read / Write 权限模型

长期记忆涉及高度个人化的数据，因此必须区分：

```text
Human
Agent
Memory System
```

建议：

### Human

可以：

```text
Create
Read
Update
Delete
```

### Agent

默认：

```text
Recall
Create Candidate
```

对于高风险 Memory：

```text
Update / Delete
```

需要用户确认。

---

# 17. 数据库架构

第一阶段不建议一开始就引入复杂的 Graph DB。

推荐：

```text
PostgreSQL
├── memories
├── memory_versions
├── entities
├── memory_entities
├── experiences
└── memory_sources
```

Embedding 可以放在：

```text
PostgreSQL + pgvector
```

这样第一阶段：

```text
PostgreSQL
    +
pgvector
```

就可以覆盖绝大多数需求。

---

# 18. 为什么暂时不需要 Graph DB

Memory Palace 确实存在天然的 Graph 结构：

```text
User
 │
 ├── works_on → Project
 │                  │
 │                  └── uses → Technology
 │
 ├── likes → Topic
 │
 └── wants_to_learn → Skill
```

但第一阶段直接上 Graph DB 会增加：

- 部署复杂度
- 数据同步
- 查询复杂度
- 运维成本

因此建议：

> **关系模型作为 Source of Truth，Graph 关系作为 Memory 的一种结构，而不是第一阶段的独立数据库。**

未来如果关系检索成为主要瓶颈，再考虑 Graph Projection。

---

# 19. Storage Architecture

建议第一版：

```text
                    Memory Palace
                         │
          ┌──────────────┴──────────────┐
          │                             │
     PostgreSQL                      Object Storage
          │
     ┌────┼────────┐
     │    │        │
 Memories Entities  Experiences
     │
  pgvector
```

职责：

### PostgreSQL

负责：

- Memory
- Version
- Entity
- Relation
- Metadata
- Temporal state

### pgvector

负责：

- Semantic retrieval

### Object Storage

负责：

- 原始文档
- 大型 Experience
- 附件

---

# 20. Memory 生命周期

完整生命周期：

```text
Experience
    ↓
Candidate
    ↓
Validated
    ↓
Active Memory
    ↓
Reinforced
    ↓
Updated
    ↓
Superseded
    ↓
Archived
```

---

# 21. 一个完整案例

用户输入：

> “我最近开始系统学习 Effect-TS。以后你给我讲 TypeScript 的时候，先从整体结构和设计思想讲，再深入 API。”

系统提取：

```text
Memory #1
Type: Goal
Content:
用户正在系统学习 Effect-TS

Memory #2
Type: Preference
Content:
用户学习技术时，希望先理解整体结构和设计思想，再深入 API
```

之后用户问：

> “Effect-TS 的 Context.Service 怎么理解？”

Agent：

```text
Query
 ↓
Recall
 ↓
Memory #1
Memory #2
 ↓
Context Assembly
 ↓
LLM
```

最终 Agent 会自然采用：

```text
整体概念
 ↓
Context.Service 在架构中的位置
 ↓
为什么需要它
 ↓
核心设计思想
 ↓
API
 ↓
代码
```

这就是 Memory Palace 真正产生价值的地方。

---

# 22. 与普通 RAG 的区别

| 维度 | 普通 RAG | Memory Palace |
|---|---|---|
| 数据 | 文档 | 用户长期信息 |
| 核心对象 | Chunk | Memory |
| 时间 | 通常弱 | 核心维度 |
| 冲突 | 较少处理 | 核心问题 |
| 用户偏好 | 非核心 | 核心 |
| Entity | 可选 | 重要 |
| 更新 | 文档更新 | Memory evolution |
| Recall | Similarity | Context-aware retrieval |
| 数据来源 | 外部知识 | 用户自身经历/状态 |
| 目标 | 回答问题 | 理解用户 |

---

# 23. 第一阶段 MVP

不要一次实现全部能力。

建议 MVP 只做：

```text
1. 用户写入
2. Memory Extraction
3. Memory Classification
4. PostgreSQL Storage
5. pgvector Retrieval
6. recall API
7. MCP
```

暂时不做：

```text
Graph DB
复杂 Memory Reasoning
自动删除
复杂多 Agent 权限
跨用户 Memory
复杂知识图谱
```

---

# 24. MVP 技术栈建议

如果按照当前项目方向：

```text
Language
TypeScript

Runtime
Node.js

Backend
Fastify / Hono

Database
PostgreSQL

Vector
pgvector

ORM
Drizzle / Prisma

AI
LLM API

Agent Integration
MCP

Deployment
Docker
```

其中不需要为了“AI Agent”而强行引入过多框架。

Memory Palace 本身应该保持足够轻。

---

# 25. 推荐的项目结构

```text
memory-palace/
│
├── apps/
│   ├── api/
│   └── web/
│
├── packages/
│   ├── core/
│   │   ├── memory/
│   │   ├── recall/
│   │   ├── formation/
│   │   └── entity/
│   │
│   ├── storage/
│   │   └── postgres/
│   │
│   ├── retrieval/
│   │   ├── semantic/
│   │   ├── lexical/
│   │   └── ranking/
│   │
│   ├── mcp/
│   │
│   └── llm/
│
└── migrations/
```

核心 Domain 应与数据库、LLM、MCP 解耦。

---

# 26. 第一阶段最重要的实验

Memory Palace 最值得验证的不是：

> “能不能存 Memory？”

而是：

> **Agent 是否真的因为 Memory Palace 而变得更了解用户？**

建议建立 Evaluation Dataset。

例如：

```text
Query
Expected Memories
Retrieved Memories
Recall Precision
Recall Recall
Final Answer Quality
```

测试：

```text
Case 1
用户偏好是否正确召回？

Case 2
旧 Memory 是否被新 Memory 覆盖？

Case 3
冲突 Memory 是否正确处理？

Case 4
无关 Memory 是否被过滤？

Case 5
时间相关 Memory 是否正确？

Case 6
多个项目之间的 Entity 是否正确区分？
```

最终核心指标可以逐步建立为：

```text
Memory Precision
Memory Recall
Conflict Accuracy
Temporal Accuracy
Context Utility
```

---

# 27. 最重要的架构判断

Memory Palace 的核心技术难点不是：

```text
Vector DB
```

也不是：

```text
Embedding
```

而是：

```text
                    Memory Intelligence
                           │
             ┌─────────────┼─────────────┐
             ↓             ↓             ↓
       Formation       Evolution       Recall
             │             │             │
        什么值得记？    什么发生变化？   什么值得取？
```

因此整个系统可以抽象成三个核心模块：

```text
┌───────────────────────────────────────┐
│            Memory Palace              │
│                                       │
│  ┌──────────┐ ┌──────────┐ ┌────────┐ │
│  │ Formation│ │ Evolution│ │ Recall │ │
│  └──────────┘ └──────────┘ └────────┘ │
│                                       │
└───────────────────────────────────────┘
```

其中：

> **Formation 决定记什么。**  
> **Evolution 决定记忆如何变化。**  
> **Recall 决定什么时候取什么。**

这三个问题，比“使用哪一种 Vector DB”重要得多。

---

# 28. 后续技术设计路线

建议按照以下顺序继续：

```text
Phase 1
Memory Model
        ↓
Phase 2
Memory Formation
        ↓
Phase 3
Memory Evolution / Conflict
        ↓
Phase 4
Recall / Ranking
        ↓
Phase 5
PostgreSQL + pgvector
        ↓
Phase 6
MCP Interface
        ↓
Phase 7
Agent Harness Integration
        ↓
Phase 8
Evaluation System
        ↓
Phase 9
Graph / Advanced Retrieval
```

不要反过来从：

```text
Vector DB
→ Embedding
→ RAG
→ 再想 Memory 是什么
```

开始。

---

# 29. 最终愿景

Memory Palace 最终可以成为 Agent 世界中的一个独立基础设施层：

```text
                 ┌─────────────────┐
                 │      Agent      │
                 └────────┬────────┘
                          │
                     MCP / API
                          │
                 ┌────────▼────────┐
                 │  Memory Palace  │
                 │                 │
                 │ Formation       │
                 │ Evolution       │
                 │ Recall          │
                 └────────┬────────┘
                          │
                 ┌────────▼────────┐
                 │ Personal Memory │
                 └─────────────────┘
```

未来不同 Agent 不需要分别建立自己的 Memory：

```text
Chat Agent ─────┐
Coding Agent ───┤
Research Agent ─┼──→ Memory Palace
Life Assistant ─┤
Local Agent ────┘
```

它们共享的是：

> **同一个人的长期状态、经历、偏好、目标和知识。**

因此，Memory Palace 的长期定位可以不是：

> “一个更好的 Memory Plugin”

而是：

> **Personal Memory Infrastructure for AI Agents**

即：

> **AI Agent 时代的个人长期记忆基础设施。**
