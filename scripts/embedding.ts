/**
 * Embedding maintenance CLI.
 *
 *   pnpm embedding:dim <N>   change the vector column width (DISCARDS all vectors)
 *   pnpm embedding:reembed   recompute every embedding with the configured model
 *   pnpm embedding:status    report the schema width, the model, and coverage
 *
 * Switching embedding model needs `dim` then `reembed`. Both are explicit
 * commands because both are disruptive and one of them is destructive.
 */
import { createRuntime, embeddingCoverage, reembedAll } from "@memory-palace/runtime"
import { changeEmbeddingDim, readEmbeddingDim } from "@memory-palace/storage-pg"

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2)
  const runtime = createRuntime()

  try {
    const declared = await readEmbeddingDim(runtime.storage.db)

    if (command === "status" || command === undefined) {
      const coverage = await embeddingCoverage(
        runtime.storage.store,
        runtime.config.userId,
        runtime.llm.embeddings.modelId,
      )
      console.log(`schema declares   vector(${declared ?? "?"})`)
      console.log(`config expects    ${runtime.config.embedding.dim}`)
      console.log(`provider          ${runtime.config.embedding.provider}`)
      console.log(`model             ${runtime.llm.embeddings.modelId}`)
      console.log(
        `coverage          ${coverage.withVector}/${coverage.total} memories have a vector`,
      )
      if (declared !== null && declared !== runtime.config.embedding.dim) {
        console.log(
          `\nMISMATCH — run: pnpm embedding:dim ${runtime.config.embedding.dim} && pnpm embedding:reembed`,
        )
      }
      return
    }

    if (command === "dim") {
      const dim = Number.parseInt(arg ?? "", 10)
      if (Number.isNaN(dim)) throw new Error("usage: pnpm embedding:dim <N>")
      const result = await changeEmbeddingDim(runtime.storage.db, dim)
      console.log(`vector column: ${result.previous ?? "?"} -> ${result.next}`)
      console.log(`discarded ${result.embeddingsDeleted} existing vector(s)`)
      console.log(`\nNext: pnpm embedding:reembed`)
      return
    }

    if (command === "reembed") {
      await runtime.assertSchemaMatchesConfig()
      console.log(
        `re-embedding with ${runtime.llm.embeddings.modelId} (${runtime.config.embedding.dim}d)`,
      )
      let lastReport = 0
      const result = await reembedAll(
        runtime.storage.store,
        runtime.llm.embeddings,
        runtime.config.userId,
        {
          onProgress: (done, total) => {
            // Report at most every 5%, so a large run is not a wall of text.
            if (done - lastReport >= Math.max(1, Math.floor(total / 20))) {
              lastReport = done
              process.stdout.write(`  ${done}/${total}\r`)
            }
          },
        },
      )
      process.stdout.write("\n")
      console.log(`embedded ${result.embedded}/${result.total} (${result.failed} failed)`)
      if (result.failed > 0) process.exitCode = 1
      return
    }

    throw new Error(`unknown command "${command}". Use: dim <N> | reembed | status`)
  } finally {
    await runtime.close()
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
