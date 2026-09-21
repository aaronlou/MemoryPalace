# ADR-0003: Model access goes through ports defined in the domain

**Status:** accepted · **Date:** 2026-09-21

## Context

The formation and recall pipelines call language models constantly. The Vercel AI
SDK is the pragmatic choice for multi-provider access, but it is on major v7 and
has shipped roughly two majors a year, each with renames (`system` →
`instructions`, `onFinish` → `onEnd`, `generateObject` → `Output.object`).

## Decision

`packages/core` defines `LlmPort` and `EmbeddingPort`. `packages/llm` implements
them. No other package imports `ai` or a provider SDK; `packages/core` cannot,
because it does not depend on them.

```ts
interface LlmPort {
  generateObject<T>(req: GenerateObjectRequest<T>): Promise<GenerateObjectResult<T>>
  readonly defaultModelId: string
}
```

## Rationale beyond vendor isolation

1. **The evaluation suite must mock.** A deterministic `RuleBasedLlm` lets the
   whole pipeline and every eval case run with no key and no network. That is the
   difference between a suite you run on every prompt change and one you avoid.
2. **Prompt-hash caching lives at the boundary.** The eval suite is only viable
   if repeat runs are free; a cache keyed on the prompt must therefore be part of
   the port's contract, not an afterthought in a caller.
3. **Cost must be observable per call.** `TokenUsage` is returned by the port, so
   "what did this pipeline run cost?" is answerable rather than guessed.
4. **Different tasks deserve different models.** Extraction is high-volume and
   mechanical; adjudication is low-volume and subtle. Port-level model selection
   makes that a configuration choice.

## Consequences

- Swapping or upgrading the AI SDK touches one file.
- Tests inject an oracle that returns the expected answer, which is how the
  harness itself is calibrated (see ADR-0005's note on measurement).
- A small amount of boilerplate: every new operation needs a Zod schema and a
  prompt helper. Worth it — see ADR-0004.

## Alternatives rejected

- **Calling the SDK directly from the domain.** Fastest to write, and it couples
  the hardest part of the system to the fastest-moving dependency.
- **LangChain.js.** It solves orchestration and provider abstraction with a large
  abstraction surface; the explicit pipeline here is a few hundred lines and can
  be read end to end.
