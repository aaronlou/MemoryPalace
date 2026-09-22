# Memory Palace

[English](./README.md) · **中文**

**面向 AI Agent 的长期记忆基础设施 —— 同一个人在不同 Agent 之间的偏好、目标、决策与历史，处处可用。**

这不是一个外挂向量索引的聊天记录库。价值不在于存了多少，而在于 Agent 能否在
对的时刻取到对的东西，以及它能否分清什么是*现在*成立的、什么是*过去*成立过的。

> 状态：v0.1，端到端可用。191 个测试全绿。mock provider 让整套系统 —— 包括评估
> 套件 —— 无需 API key、无需联网即可运行。从空目录冷启动约 90 秒，其中大部分是
> 装依赖。CI 在每次 push 时跑 lint、构建、整套测试，以及三遍 walkthrough —— 连着
> 两遍，因为第二遍会重新写入第一遍已存的文本；再删掉全部构建产物跑第三遍，以证明
> 文档里写的入口路径在全新克隆下可用。全部跑在 mock provider 上，所以不花钱。

---

## 快速开始

```bash
pnpm install                 # dependencies
pnpm db:start                # self-contained PostgreSQL 18 + pgvector cluster
pnpm migrate                 # create the schema
pnpm demo --reset            # end-to-end walkthrough, no credentials needed
```

然后启动两个入口：

```bash
pnpm dev:api                 # HTTP API + web UI + MCP over HTTP  → http://127.0.0.1:8787
pnpm dev:mcp                 # MCP server over stdio (what agents spawn)
```

**以上都不需要先构建。** CLI 和两个服务都通过 `tsx` 直接运行 TypeScript 源码，而
`tsconfig.tools.json` 把 workspace 各包映射到 `src/`，因此 `dist/` 不存在也能解析。
这是有意为之：此前它们经由各包的 `exports` 字段解析到 `dist/`，于是全新克隆下这些
命令全部以 `ERR_MODULE_NOT_FOUND` 失败，直到有人先跑过一次构建 —— `pnpm migrate`
在 CI 的第一个实质步骤上挂掉就是这个原因。

需要编译产物时再跑 `pnpm build`，下面的 stdio MCP 配置指向的正是它。

或者一步到位：`pnpm setup`（install → database → build → migrate）。

### 你会看到什么

`pnpm demo` 走一遍设计文档自己的例子：用户自然地写下一句话，记忆成形，Agent 召回
它们，情况随后发生变化，而**两个**问题 ——「你现在用什么？」和「你半年前用什么？」
—— 都能从同一个存储里得到回答。

它还会**校验自己打印的每一条断言**，有一条为假就以非零退出，因此它是一个冒烟测试，
而不是一屏供你略过的输出。这不是讲究体面：那段输出里曾藏着两个真实缺陷，两个都记在
下面的「Two more bugs, found by running the walkthrough twice」里。

---

## 从 Agent 使用

Memory Palace 讲 [MCP](https://modelcontextprotocol.io)（v2，规范版本
`2026-07-28`）。把任何 MCP 客户端指向 stdio 服务即可。

**Claude Desktop / Cursor / 任何 stdio 客户端：**

```json
{
  "mcpServers": {
    "memory-palace": {
      "command": "node",
      "args": ["/absolute/path/to/MemoryPalace/apps/mcp/dist/main.js"],
      "env": {
        "DATABASE_URL": "postgresql://mp@127.0.0.1:55432/memory_palace",
        "MP_LLM_PROVIDER": "deepseek",
        "DEEPSEEK_API_KEY": "sk-..."
      }
    }
  }
}
```

先跑 `pnpm build` 让 `apps/mcp/dist/main.js` 存在。开发时把 command 换成 `pnpm`，
并用 `args: ["exec", "tsx", "apps/mcp/src/main.ts"]`。

**DSH**（本项目的 dogfood 对象）的形状略有不同（对照 DSH 源码里的
`packages/mcp/mcp-client` 验证过）：

```jsonc
{
  "transport": "stdio",
  "serverName": "memory-palace",   // tools appear as mcp__memory-palace__memory_recall
  "command": "node",
  "args": ["/absolute/path/to/MemoryPalace/apps/mcp/dist/main.js"],
  "toolCallTimeoutMs": 60000
}
```

**远程 / 容器内的 Agent** 可以改用 Streamable HTTP：API 服务在 `POST /mcp` 暴露同一
套工具。

### 工具

| Tool | Agent 应该在什么时候调用 |
|---|---|
| `memory_recall` | 在回答任何「用户自身的上下文、偏好或历史会改变答案」的问题之前 |
| `memory_remember` | 用户陈述了关于自己的、值得长期保留的事情时 |
| `memory_search` | 确定性查找 ——「到底存了什么？」 |
| `memory_update` | 修正一条错误的记忆 |
| `memory_forget` | 归档或永久删除 |
| `memory_confirm` | 查看等待确认的内容 |
| `memory_stats` | 确认到底知不知道任何事 |

工具描述是当作 prompt 写的，不是 API 文档 —— 模型决定要不要调用时，看到的就是它。

---

## 工作原理

```
        remember                          recall
           │                                │
           ▼                                ▼
   ┌───────────────┐              ┌──────────────────┐
   │  Observation  │              │  Query            │
   │  (verbatim)   │              │  understanding    │
   └───────┬───────┘              └────────┬─────────┘
           ▼                               ▼
   ┌───────────────┐            semantic · lexical · entity
   │  Extraction   │            recent   · importance      ← 5 routes
   │  + classify   │                       │
   └───────┬───────┘                       ▼
           ▼                          RRF fusion
   ┌───────────────┐                       │
   │ Adjudication  │  one call:      qualifying-route filter
   │ DUPLICATE     │  dedup AND      score threshold
   │ REFINE        │  conflict              │
   │ SUPERSEDE     │                        ▼
   │ CONTRADICT    │                 Context assembly
   │ COEXIST/NEW   │                 (token-budgeted)
   └───────┬───────┘                        │
           ▼                                ▼
   ┌───────────────────────────────────────────┐
   │  memories: immutable versions,            │
   │  two time axes, append-only + relations   │
   └───────────────────────────────────────────┘
```

### 三个决定了一切的设计选择

**1. 记忆是不可变版本，不是可以就地更新的行。**
断言本身（`content`、`type`、有效期）永不改变；要改就写一行新的，外加一条关系边。
只有*评估*（`confidence`、`importance`、`status`）是可变的。这正是「它为什么变了？」
可被回答的原因，也阻止了一次修正悄悄摧毁历史。

**2. 两条独立的时间轴。**
`validFrom`/`validUntil` 是这件事在世界上何时成立；`recordedAt`/`supersededAt` 是
系统何时相信它。单一时间轴表达不了「2026 年年中时我们已经知道 2025 年的状态结束
了」—— 而这恰恰是诚实回答历史问题所需要的。

```bash
# what is true now
curl -s localhost:8787/api/recall -H 'content-type: application/json' \
  -d '{"query":"用户现在用什么前端框架？","format":"json"}' | jq '.memories[].memory.content'

# what was true six months ago
curl -s localhost:8787/api/recall -H 'content-type: application/json' \
  -d '{"query":"用户用什么前端框架？","asOf":"2026-03-01","includeHistory":true}' | jq '.memories[].memory.content'
```

**3. 返回空是正确答案。**
一条记忆只有被某条**查询相关**的路由真正命中、且高于相似度下限时才会被召回。
`recent` 和 `important` 是先验，不是证据：如果它们能引入候选，那么每个查询都会返回
点什么，Agent 也就永远分不清「什么都不知道」和「这里有个勉强相关的」。

### 值得知道的安全性质

- **任何输入都不会因为模型失败而丢失。** observation 在任何模型调用之前就已落库；
  抽取失败也留下可重放的东西。
- **Agent 无法悄悄改写历史。** 按 Agent 配置的策略决定哪些记忆类型自动提交；任何
  有后果的内容都进入确认队列，在确认之前绝不会被当作事实呈现。
- **冲突永不自动消解。** 无法消解的冲突会把*双方*都挂起待审，而不是挑一个赢家。
- **你的数据是你的。** 可读的 Markdown 导出、可恢复的 JSON 导出，以及真正删除的删除。

---

## 命令

| Command | 作用 |
|---|---|
| `pnpm setup` | install + start database + migrate + build |
| `pnpm db:start` / `db:stop` / `db:status` | 管理仓库本地的 Postgres 集群 |
| `pnpm db:psql` | 打开 psql 交互终端 |
| `pnpm db:reset` | 销毁并重建集群（**删除全部数据**） |
| `pnpm migrate` | 应用待执行的迁移 |
| `pnpm embedding:status` | 查看 schema 宽度、模型，以及多少条记忆有向量 |
| `pnpm embedding:dim <N>` | 修改向量宽度（**丢弃已有向量**） |
| `pnpm embedding:reembed` | 用当前配置的模型重算全部向量 |
| `pnpm dev:api` | HTTP API + Web UI + MCP-over-HTTP |
| `pnpm dev:mcp` | stdio 上的 MCP 服务 |
| `pnpm demo` | 会自我校验的端到端演示（`--reset` 从干净状态开始） |
| `pnpm backup [file]` | 写出完整 JSON 备份（默认 `backups/<date>.json`） |
| `pnpm restore <file>` | 用备份替换全部数据 |
| `pnpm backup check <file>` | 校验备份，**不碰数据库** |
| `pnpm test` | 完整测试套件 —— **同样会清空所配置的数据库**，见「评估」 |
| `pnpm eval` | 运行评估套件 —— **会清空所配置的数据库**，见下文 |
| `pnpm eval --repeat N` | 跑 N 次并报告 mean/min/max |
| `pnpm eval --recall-mode fast\|smart\|auto` | 测量 Agent 实际走的那条路径 |
| `pnpm eval --embedding mock\|real` | 独立于 LLM 单独变化 embedding |
| `pnpm eval --filter rec-` | 只跑一个套件，当只有它变了的时候 |
| `pnpm eval:compare A B` | 比较两次评估 —— 数据集或召回模式不同时拒绝比较 |
| `pnpm build` | 类型检查并产出 `dist/`，外加 `scripts/` 与 `evals/`（`tsconfig.tools.json`） |
| `pnpm lint` / `format` | Biome |

---

## 评估

> **`pnpm eval` 和 `pnpm test` 都是破坏性的。** 两者都会清空 `DATABASE_URL` 指向的
> 数据库里的每一张记忆表 —— `eval` 在每个用例前清一次以免互相污染，测试套件则通过
> 自己的 fixture 清。对基准来说这是正确行为，对你的数据来说是错误行为：对开发库跑
> 任何一个都会把里面删光。这不是假设。本项目已经为此付过两次代价：一次是参考表在
> 错误配置下被读成「文档写错了」，一次是真实用户最初的几条记忆（就在写这段警告的
> 时候）。把 `DATABASE_URL` 指向一个临时库，或者先备份（`pnpm backup`），不要对
> 任何你在意的东西跑它们：
>
> ```bash
> createdb -h 127.0.0.1 -p 55432 -U mp mp_scratch
> DATABASE_URL=postgresql://mp@127.0.0.1:55432/mp_scratch pnpm migrate
> DATABASE_URL=postgresql://mp@127.0.0.1:55432/mp_scratch pnpm eval
> ```

三个套件，46 条黄金用例，经过标定，所以这些数字是有意义的。

### 参考点

| Provider / embedder | Extraction F1 | Adjudication | Recall P@5 / R@5 | Negative |
|---|---|---|---|---|
| `oracle` — 标定*测试工具*本身 | **1.000** | **100%** | 0.646 / 0.708 | 100% |
| `null` — 什么都不抽取 | **0.000** | 10% | 见注释 | 见注释 |
| `mock` — 规则式，无需 API key | 0.750 | 30% | 0.646 / 0.708 | 100% |
| DeepSeek + **bge-m3**，`smart` | 0.967 | 100% | 0.929 / 1.000 | 100% |
| DeepSeek + **bge-m3**，`auto` | — | — | 0.893 / 1.000 | 100% |
| DeepSeek + **embeddinggemma**，`smart` | **0.989** | 0.967 | **0.958 / 1.000** | 100% |
| DeepSeek + **embeddinggemma**，`auto` | 0.899 | 0.933 | **0.938 / 1.000** | 100% |
| DeepSeek + **embeddinggemma**，`fast` | — | — | 0.583 / 0.625 | 100% |

**每一行都写明它用的 embedder，因为是 embedder 决定了召回。** bge-m3 那两行是在该
模型还装着的时候、在更早的 14 条召回用例上测的；embeddinggemma 各行来自当前 24 条
用例，在装有 `embeddinggemma`（621 MB）而非 `bge-m3`（1.2 GB）的机器上可复现。两者
不可比 —— 不同的考卷、不同的 embedder —— 而报告指纹现在记录了足够的信息（embedder、
宽度、模式、阈值、数据集哈希），`eval:compare` 会直接说明这一点，而不是去给差异打分。

三个离线行是在仓库默认配置下测的，CI 跑的也是这套配置。它们并非与配置无关 —— 见下面
第一条注释。

`fast` 不应用任何重排序，因此它的召回来自词法与实体路由，embedding 模型帮不上忙：
P@5 0.583，而 `smart` 是 0.958。`smart` 买到的几乎全部东西，都来自重排序器够到了那些
与查询在字面上毫无重叠的记忆。

报告现在会在指纹里记录 embedding 模型、其宽度与召回路径，任一项不同时 `eval:compare`
都拒绝判定两次运行可比。在这个修复之前，报告根本无法归因到某个 embedder —— 一次基准
就是这样被发布在了一个早已不在机器上的模型名下。

oracle 与 null 两次运行在测试套件里被断言：如果完美模型拿不到 1.0、空模型拿不到 0.0，
那么「F1 = 0.75」这样的真实分数测的就是测试工具而不是系统。离线召回行被钉在固定的
相似度下限上，好让它们在每台机器上测的是同一件事。

**关于这张表的九条诚实注释。**

*`null` 的召回列是空白的，不是因为它分数高。*
`NullEmbedding` 返回全零向量，而两个零向量之间的余弦距离无定义 —— 所以 pgvector 在
它们之上的排序是任意的。即便跑它，也会报出 P@5 0.639、R@5 1.000、负例准确率 16.7%、
违规命中率 25%：这就是「任意」的样子，而那些违规命中提醒你，**没有任何相似度下限能
救回一个返回零向量的 embedder**，因为所有下限都假设距离是有意义的。该 provider 只
用来标定*抽取*指标的零点，那 0.000 才是要紧的答案。

*离线两行是在当前发布的阈值下测的。* 相似度下限按 embedding provider 分别选定
（`config.ts` 里的 `DEFAULT_SEMANTIC_FLOOR`），所以它是这些数字含义的一部分。这两行
是 `oracle` 和 `mock`，它们永远跑哈希替身 embedder，却仍然继承 `MP_EMBEDDING_PROVIDER`
所指定的下限：把它指向 `ollama`（下限 0.65）而不是 `mock` 的默认值（0.15），同一套
用例就会得到不同的分数，因为更高的下限会让 `fast` 丢掉更多转述。两种读数都对；它们
回答的是不同的问题。如果你想拿自己的运行结果对照这张表，先看阈值 —— `eval:compare`
现在会报出每一处差异，所以这里的不一致是配置在说话，不是回归。

*召回套件有 24 条用例，最后十条是按测量摆放的。* `rec-015` .. `rec-024` 位于 smart
路径所探测的带内（下限减去 `semanticRescueMargin`），实测余弦落在 0.408 到 0.605
之间，而更早的用例要么远在下限之上、要么远在其下。一个够不到这条带的套件，无法告诉
你放宽它是否安全 —— 而这正是它们被造出来的原因。其中有一对实测余弦完全相同、都是
0.429：`rec-017`（一条文档风格偏好，必须被召回）与 `rec-020`（一只猫的名字，必须不被
召回）。没有任何阈值能同时满足两者，所以这一对只有在系统判断的是相关性、而不是距离时
才会通过。

*这十条用例进来后，离线两行从 0.750 / 0.857 降到 0.646 / 0.708。* 那是数据集变难了，
不是系统变差了，而这个区分正是数据集哈希要放进报告指纹的原因。离线栈现在漏掉的七条
用例，每一条都需要一个只出现在记忆里、从不出现在查询里的词；哈希词袋模型对转述没有
任何概念，因此结构上够不到它们。`rec-014` 是对应的哨兵 —— 一条离线栈确实能通过的
负例。

*这两行同时也是在默认向量宽度下测的。* 替身 embedder 把每个 token 哈希进
`hash % dim`，所以它的召回取决于 `pnpm migrate` 创建的列宽 —— `vector(1024)`，也就是
CI 和全新克隆所拥有的。在 768 维下同一条命令报 0.604 / 0.667。两者都没错；它们是不同
配置，而 `embeddingDim` 在指纹里，所以 `eval:compare` 会拒绝把其中一个读成另一个的
变化。

*bge-m3 那两行来自更早的 14 条套件，与其余各行不可比。* 它们是在该模型还装着时测的。
拿它们和现在的 embeddinggemma 行比较，就是在比较不同的考卷 —— 不同 embedder、不同
数据集 —— 而这正是指纹存在的目的。把它们当作一个方向，而不是一个分数。

*`auto` 才是要紧的那一行，因为它是默认值。* 在这套用例上它达到了 smart 路径精度的
两点以内 —— P@5 0.938 对 0.958，两者 R@5 都是 1.000、负例准确率都是 100% —— 同时
只对没有任何东西佐证的答案做升级。两个数字都是实测的，不是估算的；
`pnpm eval --recall-mode auto` 可以复现。

*两条路径回答的是不同的问题。* 在同一套用例上实测，`fast` 给出 P@5 0.583 / R@5 0.625
/ 负例 100%：它更经常拒绝，并且对自己返回的东西从不出错。`smart` 让出一些精度以回答
更多 —— 0.958，R@5 1.000。两者都不是「那个」分数，这就是报告要打印它所测模式的原因，
也是 `recallMode` 要进指纹的原因。

*mock 的抽取分数是 0.750，而不是数据集第一版时的 0.900。* 那个更早的数字是被抬高的：
数据集是看着规则式抽取器的输出写出来的，因此奖励了那个抽取器的措辞方式。尤其它在一句
包含两个事实的复合句上只期望**一条**记忆，而抽取 prompt 明确写着「一条记忆一个想法，
拆分复合句」。模型是在遵循指令，而基准在惩罚它。修正数据集**降低**了 mock 的分数，
这正是当基准不再围着某个实现拟合时的预期方向。

*裁决比抽取更嘈杂。* 真实栈六次完全相同运行的分布：

```
extraction F1        0.944   (min 0.897  max 1.000)
evolution accuracy   0.950   (min 0.900  max 1.000)
recall P@5 / R@5     0.833 / 0.917                    stable
```

托管模型即使在 temperature 0 下也不是确定性的。比较 prompt 改动时请用 `--repeat`：

```bash
pnpm eval --provider real --repeat 3
```

### 一次被测量出来的 prompt 改动

裁决曾是薄弱环节。失败的用例长这样：

```
existing : 用户喜欢在回答里看到大段代码示例
candidate: 用户不太喜欢大段代码，更希望看到思路和解释
expected : SUPERSEDE        got: CONTRADICT
```

原因很微妙。当候选句恰好**照抄了已有措辞**（「不太喜欢在回答里看到大段代码示例」）时，
模型 3/3 返回 SUPERSEDE；换成抽取实际产出的、更松散的措辞时，它 3/3 返回 CONTRADICT。
决策是被字面相似度驱动的，而不是被「用户是否在描述一次变化」驱动的。

prompt 里本来就*写着*这条规则（「随时间发生的变化是 SUPERSEDE，绝不是 CONTRADICT」）。
重述原则不够，于是这段指引被改写成一个流程 —— 追问每句话在*何时*为真，把
了/不再/现在/no longer/now 当作变化的信号，并用「这两句话可能写于同一时刻吗？」来识别
真正的矛盾。它还加了一条平局规则：优先 SUPERSEDE，因为它把旧版本保留在历史里，而
CONTRADICT 会让两种说法同时成立。

各跑六次的 A/B，同模型、同 embedder：

```
evolution accuracy   0.883 -> 0.950   better    (A 0.800-0.900, B 0.900-1.000)
extraction F1        0.944 -> 0.943   indistinguishable
recall P@5 / R@5     unchanged
```

B 的最差一次等于 A 的最好一次，且 B 能到 100%，A 从未超过 90%。抽取没有变化，所以这次
改动是专门改善了裁决，而不是整体改善了 prompt。

这也修掉了 `eval:compare` 的一个缺陷：比较两次单跑时，它把纯粹是运行间噪声的差异报成
抽取「WORSE」了 0.037。现在它在重复运行上比较区间，并拒绝把重叠的差异说成变化。

### 仍然薄弱的地方

- **`DUPLICATE` 与 `REFINE`。** 本质上就有歧义 —— 只多加了一个词的复述，说成哪个都
  站得住。有三条用例把两者都列为可接受，而不是断言作者的偏好，因此它们不再记为失败。
- **没有模型就无法解决 fast 路径的精度/召回权衡。** 在四个下限上实测，它可以做到
  R@5 1.000、同时 40% 的负例查询被回答，也可以做到负例准确率 100%、漏掉三条。两者
  之间没有平台期，因为用 bge-m3 时，一对不相关文本可以比一对相关的分更高。只有 smart
  路径能分开它们，这也是 `auto` 会选择升级、而不是把下限调得更狠的原因。
- **两个新机制的好坏完全取决于重排序器。** 否决会删掉 fast 路径本会返回的召回，升级
  则要花两次模型调用，所以一个便宜或孱弱的重排序器会让 smart 路径*比* fast 更差 ——
  这是实测的，也是这些阈值在 mock provider 下默认为 0 的原因。把
  `MP_RECALL_MIN_RERANK_RELEVANCE=0` 设上，可以让 smart 路径只增不减。
- **硬转述。** 相似度下限是个粗糙的过滤器（见上文），所以一个与它所需记忆几乎没有
  字面重合的问题可能落到下限之下。smart 路径救的正是这些，但只有在重排序器确认时才
  救，因此这个机制只在真正接了重排序器的地方活着。在 mock provider 下它**按构造就是
  惰性的**：mock embedder 从共享 token 推导相似度，对转述毫无概念，而 fast 路径根本
  不探测，所以 margin 动不了离线的行。`rec-013` 就是那个活案例，它在离线时故意失败。

  有一件事值得直说，因为本文档的早期版本把它搞错了：用 bge-m3、在旧的 0.45 下限下，
  这条用例得分 0.523，从来不需要被救；有一段时间，诚实的读法是这个机制买到的是精度
  （负例准确率 60% → 100%），而不是转述召回。这已经不再是全部故事。套件现在带了十条
  摆在*带内*的用例，而在这些用例上这个机制买到的是召回：把 margin 从 0.15 放宽到 0.25，
  P@5 从 0.667 升到 0.958、R@5 升到 1.000，同时负例准确率保持在 100%。那次更正依然
  成立 —— 旧的例子关于下限什么也没证明 —— 但从它得出的结论，是一个够不到这条带的
  14 条套件的性质。

### 语言漂移，以及对你自己估计的一次更正

模型偶尔会用错语言回答。这接近于一次静默失败：一条英文记忆躺在中文记忆库里几乎
找不到，因为 CJK 的词法匹配是基于双字的，而语义路由是在跨语言比较。

本文档的早期版本把发生率写成「大约 1/20」，来自一次观察。对中文输入抽样 55 次抽取，
只出现**一次**，所以诚实的数字更接近 1/55 —— 罕见，且无法按需复现。这正是为什么这个
修复是用确定性测试、而不是统计来验证的：

- `detectScript` 把文本分为 CJK / latin / mixed，且这个守卫只在输入以 CJK 为主、并且
  **每一个**候选都是纯 latin 时才触发 —— 因此含「PostgreSQL」或「Effect-TS」的中文
  记忆不受影响。
- 触发时，该分片会被**重新问一次**，并明确写出目标语言。两次为止，不再多：对着一个
  固执的模型循环重试会烧 token，并拖慢每一次写入。
- 只有当重试真的修正了不匹配时才保留它，并且计数被持久化在
  `extraction_runs.language_retries`（迁移 0002）里，好让上升的比率可见，而不是埋在
  一行日志里。

六条测试用一个「第一次漂移、第二次修正」的桩覆盖它。把守卫关掉会让其中三条失败，
所以它们测的是行为，而不是代码路径。

### 一个只有线上系统发现、测试没发现的 bug

记在这里，因为它是 `pnpm eval` 为什么存在的最清楚论据。

此前裁决的邻居查找被限制在**同一记忆类型**内，理由是「目标永远不会取代偏好」。然后
一个真实模型把 *「我用 Vue」* 存成 `fact`，把 *「我改用 React 了」* 存成 `decision`
—— 同一主题，不同类型。裁决**从未被调用**，候选被无条件插入，存储最后同时断言用户用
Vue 和用户不用 Vue。

类型描述的是这句话怎么被说出来的，不是它在说什么。这个限制被移除，prompt 现在写明哪些
决策可以跨类型，裁决准确率从 0.767 升到 0.833。ADR-0004 完整记录了这次更正。

它的回归测试最初在有 bug 的代码上也是通过的，因为离线 mock 抽取器把两句话标成同一个
类型 —— 于是类型过滤从未起作用。测试被改写为先以刻意不同的类型种入较早那条记忆，
现在它会在 bug 上失败，并报出 *「没有写入任何关系，说明裁决没有在较早那条记忆上运行」*。

### 另外两个 bug，是靠把 walkthrough 跑两遍发现的

两个都藏在 `pnpm demo` 自己的输出里，且都无法从测试套件触达。记在这里的理由与上一节
相同。

**重复运行会写崩。** 不带 `--reset` 跑第二次 `pnpm demo`，死于外键冲突：

```
error: insert or update on table "memories" violates foreign key constraint
       "memories_origin_observation_id_fkey"
detail: Key (origin_observation_id)=(obs_01M322VD...) is not present in table "observations".
```

`insertObservation` 按内容哈希去重，用 `ON CONFLICT ... DO NOTHING` —— 有意为之，这样
重复写入同一段文本不会存两遍。但 `remember` 继续用它*提议*的那个 id，于是它随后写的
记忆引用了一行从未被创建的 observation。这次写入丢了，用户的那句话也跟着丢了。

幂等测试把同一段文本覆盖了三遍，而且全程通过，这才是最有意思的地方：一次被判为
**DUPLICATE** 的重复会以 `reinforce` 应用，那是一个 UPDATE，从不触碰外键。这个 bug
需要一次决策为**插入**的重复 —— REFINE 或 SUPERSEDE —— 而这正是 demo 第二遍跑出来的，
因为那时它拿来比较的邻居已经被精炼成了不同的措辞。在生产中同样可达，没有任何奇特的
前提。

修复是一个契约，不是一个补丁：`insertObservation` 现在返回**持有这段内容的那一行**，
已存在的那行也算，而 `remember` 在下游一律用这一行。端口如此声明，所以未来的适配器
无法再悄悄破坏它。

**一个目标变成了事实。** 第 6 步打印过
`active Effect-TS goal memories: 0 (should stay 1)` —— 在一段谁也没细看的输出里，从
demo 存在起就是这样。那个检查读的是*类型*；
而类型漂移了。同一个事实换个说法重新抽取，会落在不同类型下（「我最近开始系统学习
Effect-TS」读作 `goal`，「我最近在系统学习 Effect-TS」读作 `fact`），而 REFINE 继承
了*候选的*类型 —— 于是改写自己这句话就把一条记忆在上下文分组之间搬了家，更糟的是在
写入策略之间搬家（`decision` 需要确认，`fact` 不需要）。现在精炼继承其来源的类型；
SUPERSEDE 仍然保留候选的类型，因为一次真正的状态变化可以改变类别，而不违背 ADR-0004
的教训。

所以 demo 现在会校验它打印的断言 —— *事实*的当前版本，无论类型是什么；存储的状态
是否是它应有的样子 —— 有一条为假就以非零退出。它是新用户跑的第一条命令；它不该是
仓库里被验证得最少的东西。

### 那些脚本此前没有被任何东西做类型检查

修上面这些时，需要先有一个类型错误在运行时暴露出来：`scripts/demo.ts` 里重复的
`const before` 编译通过，运行时才抛。`pnpm test` 只转译不检查，而根构建只引用了
`packages/` 与 `apps/` —— 于是 `scripts/` 里每个 CLI 以及 `evals/` 整个评估工具链都
没有被检查。`tsconfig.tools.json` 现在覆盖它们（不产出：它们是入口点，不是产物），
并且 `pnpm build` 会跑它。

把它打开后立刻发现了两个此前不可见的潜在错误：评估工具链里一个 `as never` 转型，
正在掩盖一个过窄、装不下工具链自己推断出的 `UNKNOWN` 的 `acceptDecisions` 类型；
以及一个从「从未导出过它的模块」里再导出的类型。

### 为什么 embedder 比看上去更重要

从哈希替身换到真实 embedder，既**改善**了召回（P@5 0.750 → 0.833，R@5 0.833 → 0.917），
*又*修好了裁决用例 —— 因为裁决无法决定去替换一条它从未检索到的记忆。

它也在第一次时把系统搞坏了，直到相似度下限按模型重新标定（见下）。这正是这套评估工具
存在的全部理由。

---

## 配置

所有选项见 [`.env.example`](./.env.example)。其中最重要的两个：

**`MP_LLM_PROVIDER`** —— `mock`（默认，无需 key）或 `deepseek` / `openai` /
`anthropic`。抽取是高吞吐路径，裁决是对质量敏感的路径，所以它们可以用不同的模型。

**`MP_EMBEDDING_PROVIDER`** —— `mock` 是一个只捕捉字面重合的哈希替身。**真实使用时
请把它设成真正的 embedding 模型**：转述召回取决于它，而 mock 的召回数字是地板而不是
目标。`ollama` 在本地跑模型，什么都不离开这台机器；`bge-m3` 是 1024 维的，开箱即与
schema 匹配。

embedding 模型是**独立于语言模型的一条质量轴**，评估工具链可以独立地变化它们 ——
`pnpm eval --provider oracle --embedding real` 把 embedder 的贡献单独隔出来。

**召回信任阈值** —— `MP_RECALL_MIN_RERANK_RELEVANCE` 与
`MP_RECALL_ESCALATE_BELOW_SEMANTIC` 决定重排序器的判断有多大权威。在
`MP_LLM_PROVIDER=mock` 下两者都默认为 0（替身无法判断相关性），在真实 provider 下
默认为 0.3 / 0.6。把任一个设为 0，会让 smart 路径只增加候选、绝不删除。

### 切换 embedding 模型

```bash
ollama pull bge-m3          # or whichever model you want
pnpm embedding:status       # compare schema width, model, and coverage
pnpm embedding:dim 1024     # only if the width differs — discards old vectors
pnpm embedding:reembed      # recompute
```

应用从 **schema** 读取列宽，而不是从源码里的常量，因此它不可能与自己的数据库不一致。
不匹配会在启动时失败，并给出修复它的确切命令。

### 相似度下限是模型相关的

`MP_RECALL_MIN_SEMANTIC_SIMILARITY` **按 provider** 取默认值，因为正确的值是
embedding 模型的属性，而不是系统的属性。哈希替身把不相关文本放在接近 0 的位置，所以
为它调好的下限，一旦换成真实模型就会放进一切 —— 这正是第一次切换 embedder 时发生的
事。

随后这个下限是从黄金数据集上的一次扫描定下来的，而不是凭直觉。那次扫描已经在**真实栈**
上**重跑过**（bge-m3 + DeepSeek，14 条召回用例），因为下文那些机制改变了这个下限还能
决定什么：

| floor | `fast` P@5 / R@5 / negative | `smart` P@5 / R@5 / negative |
|---|---|---|
| 0.35 | 0.488 / 1.000 /  20% | 0.893 / 1.000 / 100% |
| **0.45** *(old default)* | 0.750 / 1.000 /  60% | 0.929 / 1.000 / 100% |
| 0.55 | 0.679 / 0.857 /  80% | 0.929 / 1.000 / 100% |
| **0.65** *(current default)* | 0.714 / 0.786 / 100% | 0.929 / 1.000 / 100% |

两点值得读出来。**smart 路径几乎不在意这个下限** —— 救援补回了它损失的召回，否决
清掉了它放进来的噪声 —— 所以下限不再是过去那个「有效旋钮」。**权衡住在 fast 路径
里**，因为余弦是它仅有的东西：它可以做到 R@5 1.000、同时 40% 的负例查询被回答，也
可以做到负例准确率 100%、漏掉三条，而两者之间没有平台期。0.65 是按本文档自己长期的
标准选的 —— 负例准确率达到最大值的那一点 —— 代价是 fast 路径的 R@5 掉到 0.786。设
`MP_RECALL_MIN_SEMANTIC_SIMILARITY=0.45` 可以换回来，只差一个环境变量。

托管 provider 仍然带着更早的 0.45。下限是模型的属性，而它们在这里都没有被扫描过；
这一点是说明的，不是猜的。

**最终的**混合分数阈值（`MP_RECALL_MIN_SCORE`）曾与下限一起被扫描，结果证明它不是一个
有用的杠杆：

```
floor  minScore=0.18  0.30  0.40  0.50
0.25   P@5 0.667      0.667 0.667 0.583
0.35   P@5 0.750      0.750 0.750 0.667
0.45   P@5 0.833      0.833 0.833 0.750
```

提高它并不能把相关与不相关的结果分开，因为一条越过了语义下限的不相关记忆，同样会
收集到与相关记忆相同的 importance 与 recency 先验。**原因是结构性的，也正是 smart
路径现在显式否决的同一个原因：** 一次孤立的语义命中会被归一化成 RRF 1.0，而仅这一项
（在 smart 权重下是 0.45）就压过了模型对它的看法。重新加权修不了一个取值范围取决于
「这次查询恰好返回了多少候选」的项；否决可以，而且确实做到了（实测：smart 路径负例
准确率 60% → 100%）。

**一次值得记录的更正。** 本文档的早期版本声称存在清晰的分隔 ——「不相关的
0.164-0.400，相关的 0.599-0.800」。那是从五对手工挑出来的样本里得出的。在数据集上
测十六对，两个分布**重叠**：

```
RELEVANT    n=9  min 0.432  median 0.597  max 0.800
IRRELEVANT  n=7  min 0.152  median 0.213  max 0.799
```

这张表后面那段话，曾经给出一个硬转述落到下限*之下*的线上例子：

```
query : 讲技术概念的时候应该怎么组织？
memory: 用户希望在被讲解 TypeScript 时，先了解整体结构和设计思想，再深入具体 API
cosine: 0.432   -> below the 0.45 floor, so it is not recalled
```

**用 bge-m3 重新测量，这一对是 0.523，不是 0.432** —— 高于两个下限，所以它一直都被
召回，那个例子关于下限什么也没证明。所谓的修复（「把下限降到 0.40」）什么也换不来，
还会赔上负例准确率。同一次扫描*确实*显示的，比旧故事更锋利：bge-m3 把真正不相关的
两对放在 **0.502 和 0.553**，也就是*高于*一条相关的转述的 0.523。用这个 embedder，
不存在能把它们分开的下限，而早先那张表关于「0.45 是精度与负例准确率的峰值」的信心，
经不起这次测量。

这才是下面两个机制真正要解决的问题，而它们都不是阈值：fast 路径保留一个下限并接受它
的权衡，smart 路径则不再假装一个余弦能回答一个模型能答得更好的问题。

### smart 路径会探测到下限之下，并用一次确认来买单

fast 路径除了分数什么都没有，所以下限就是它的全部。smart 路径已经为「一个直接判断
相关性的 LLM 重排序器」付过钱了 —— 但低于下限的候选从到达不了它，因为下限是在候选被
*生成*时应用的。

所以在 smart 路径上下限被一分为二：

```text
              probe floor                     floor
                   │                            │
   ────────────────┼────────────────────────────┼──────────────►  cosine
                   │        rescued band        │
                   │   kept only if the         │  kept on the
                   │   reranker confirms        │  score alone
                   │   (relevance ≥ 0.6)        │
```

- `MP_RECALL_SEMANTIC_RESCUE_MARGIN`（默认 0.25）是 smart 路径向下探测多远。0 表示
  关闭。
- 以这种方式进入的候选是**被救援的**，只有当它的重排序相关性至少达到
  `MP_RECALL_RESCUE_MIN_RELEVANCE`（默认 0.6 —— 重排序评分标准里的「有用背景」档）
  才会被召回。它自身没有高于下限的证据，所以被要求比普通命中更严格。
- 如果重排序失败，被救援的候选会被丢弃，答案就是下限本会给出的那个。降级只会退回到
  旧行为，绝不越过它。
- **救援只能增加候选；它绝不改变另一条路由已经命中的记忆的处置。** 词法或实体路由
  命中的任何东西都有它自己的证据，fast 路径本就会返回它 —— 所以救援本身绝不会让
  `smart` 召回得比 `fast` 少。（*否决*在「仅语义命中」这种情况下会有意为之；那是下一
  节的主题。）
- **fast 路径从不探测**：没有确认信号，降低下限只会放进噪声，别的什么也没有。

每一个决定都能在审计轨迹里看到（`kept_rescued_confirmed` /
`rescued_unconfirmed`）；否则一次「不该发生」的召回与一个 bug 无法区分。

被否决的那个替代方案值得记下来，因为它是最显然的那个：**相对于每次查询自身相似度
分布的自适应阈值**。它确实修好了上面那个例子。但一次孤立的*不相关*命中，其分布与
一次孤立的*相关*命中完全一样，所以没有任何按查询统计的量能把它们分开 —— 而且这样一条
规则必须为低分查询降低下限，而低分查询恰恰是不相关命中所在的地方。它用一个可调的
常数，换来了一个无法标定的启发式。完整论证见 ADR-0006。

### 重排序器说「没用」时，这个判断是有约束力的

救援是请模型去确认那些被分数拒绝的候选。而实测到的问题是它的镜像：被分数*接受*、
被模型拒绝的候选。

```
                                        semantic   rerank   final   outcome
rec-013  relevant paraphrase              0.523     0.950    0.873   recalled
rec-008  "what do I use?" vs a preference 0.502     0.050    0.563   recalled  <- wrong
rec-014  the mnemonic technique            0.553     0.050    0.558   recalled  <- wrong
```

模型两次说「没用」时都是对的，而它的判断价值 0.35 分，那个分数已经仅凭排名就到了
0.56。所以在 smart 路径上，**重排序相关性低于 `MP_RECALL_MIN_RERANK_RELEVANCE`
（默认 0.3，即重排序评分标准自己的「这里没用」档）的候选会被直接否决。**

两条保护使它不至于鲁莽。否决只在重排序器*作答*时生效 —— 如果它失败了，就没有判断
可以遵从，而把一次故障当成相关性判断会比它清掉的噪声更糟。而且它只在 smart 路径上
生效，而只有显式 `mode: "smart"`、或 `auto` 判定答案未被解决时才会走到那里。

在召回套件上实测，同模型、同 embedder：

```
                     P@5     R@5     negative accuracy   forbidden hits
veto off             0.714   0.929   60.0%               7.1%
veto on              0.893   0.929   100.0%              0.0%
```

没有丢掉任何召回：被否决删掉的每一条都是错的。

**`auto` 依据同样的证据升级。** 默认模式先跑 fast 路径，而它的升级规则曾是「混合分数
低于 0.42」—— 对上面那些用例永远不会触发，因为一次孤立的语义命中无论是什么都拿大约
0.78。现在它还会在「fast 路径的最好答案仅依赖余弦、且该余弦低于
`MP_RECALL_ESCALATE_BELOW_SEMANTIC`（默认 0.6）」时升级：没有词法或实体命中意味着
没有任何东西佐证它，而 smart 路径是唯一能解决它的地方。

```
auto, 14 recall cases        P@5     R@5     negative   model calls
escalation on evidence off   0.750   1.000   60.0%       5
escalation on evidence on    0.893   1.000   100.0%     15
```

十五次调用，对比「永远 smart」的二十七次：被佐证的答案从不离开 fast 路径，而升级的
那些正是需要升级的。ADR-0007 记录了这些替代方案，以及为什么给分数重新加权做不到这
件事。

**信任与下限一样，是按 provider 分的。** 两个机制只有在重排序器称职时才是可靠的，而
内置替身不是 —— 它从 token 重合度推导相关性，所以一条中文记忆只要与查询共享一个特征
词就会拿到约 0.09，而真实重排序器会给约 0.95。信任它删掉了合法的召回（实测：mock
的 smart 从 0.714/0.786 掉到 0.500/0.500）。所以这两个阈值在
**`MP_LLM_PROVIDER=mock` 下默认为 0**，在真实 provider 下默认 0.3 / 0.6：替身的判断
没有效力。如果你配置了一个你不想被其判断约束的模型，用那两个环境变量显式关掉它们。

### 一个历史问题不会被钳制到「现在」

`includeHistory` 过去的意思比它听起来要少。有效期窗口仍然被钳制到现在，而一条被取代
记忆的 `valid_until` 按定义就在过去 —— 于是「我以前用什么？」只能返回那些*仍然*成立
的东西。`rec-010` 自套件写出来起就一直因为这个原因失败。

现在显式的 `asOf` 优先；否则只在**没有**请求历史时才钳制窗口。一个被理解为历史性的
问题（或调用方设置了 `includeHistory`）会搜索整条时间线，让排名与重排序器决定什么该
进答案。实测：`rec-010` 通过，`rec-009`/`rec-011` 不受影响，离线套件从 0.714/0.786
升到 0.750/0.857。ADR-0008 记录了为什么「要求调用方传一个过去的 `asOf`」这个替代方案
被否决。

---

## 项目结构

```
packages/
  shared/            ids, time, errors, RRF fusion, token estimation
  core/              domain: types, ports, formation, evolution, recall
  llm/               provider adapters + deterministic mock + response cache
  storage-pg/        the only package that knows SQL exists
  runtime/           composition root, MCP tool registrations, export rendering
  test-support/      test fixtures (separate so production can't import them)
  integration-tests/ cross-cutting tests that span packages
apps/
  api/               Hono: REST + web UI + MCP over Streamable HTTP
  mcp/               MCP server over stdio
  web/               static UI, no bundler
evals/               golden dataset, metrics, harness, oracle
docs/                the design doc, the plan, and the ADRs
```

`packages/core` 不能 import `storage-pg` —— 这由 TypeScript 的 project references
强制，而不是靠约定。

---

## 文档

- [设计文档](./docs/Memory-Palace-技术方案-v0.1.md) —— 最初的方案
- [技术选型评估](./docs/01-技术选型评估-v0.1.md) —— 每一项选型及其被否决的替代方案与理由
- [开发计划](./docs/02-开发计划-v0.1.md) —— 阶段、验收标准、风险

**这份 README 有两个语言版本，必须保持一致。** 英文版是
[`README.md`](./README.md)，中文版是本文件
[`README.zh-CN.md`](./README.zh-CN.md)。改动其中一份时，请在**同一个提交**里同步
另一份；`pnpm docs:check` 会校验两者的结构一致性（标题层级、代码块、表格、链接、
行内代码），并在 CI 中运行。它只能校验结构 —— 段落本身是否译得准确，仍然要靠人。

---

## 环境要求

- Node.js **≥ 22**（在 24.21 LTS 上开发）
- PostgreSQL **18**，带 **pgvector** 与 **pg_trgm**
  （`brew install postgresql@18 pgvector`，或 `docker compose up`）
- pnpm 11

Docker 是可选的：`scripts/db-local.sh` 在 `.local-pg/` 下跑一个自包含集群，不触碰任何
系统状态。

---

## 尚未构建

v0.1 的诚实范围：

- **图查询。** 关系有存储（`supersedes`、`refines`、`contradicts`……）也可以遍历，
  但没有图投影。这是有意的：见设计文档 §18。
- **托管式重嵌入。** schema 支持多个 embedding 模型并存；把它们填上的后台任务还不
  存在。
- **多设备同步。** 今天的传输方式是导出/导入。
- **多用户。** 每张表都以 `user_id` 划分命名空间，仓储层也强制要求它，但没有鉴权或
  租户隔离。
- **记忆衰减。** `archived` 存在且被排除在召回之外；自动老化还不存在。
- **定时备份。** 备份是你跑的一条命令，不是守护进程；没有 cron，也没有保留策略。
