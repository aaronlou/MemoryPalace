import { evolutionCases } from "./evolution.js"
import { extractionCases } from "./extraction.js"
import { recallCases } from "./recall.js"
import type { Dataset } from "./types.js"

export const dataset: Dataset = {
  extraction: extractionCases,
  evolution: evolutionCases,
  recall: recallCases,
}

export * from "./types.js"
