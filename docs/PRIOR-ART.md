# Prior art: the reference list behind the algorithm

The projects this one read, and what it took from them — including what it
deliberately did not. It is the **Prior art** tab of the web UI, and versioned
content in `scripts/prior-art-seed.ts`.

Why it is its own page and not memory: a memory answers "what should this agent
know about the user"; an entry here answers "why is the algorithm like this".
Filing one as the other would let a question about a user's preferences surface a
system this project merely read. It is a separate table for the same reason.

## Adding one takes a URL and nothing else

You are not asked to judge whether a project is worth borrowing from; that is the
part being automated. Paste a GitHub link and, in the background, the system reads
the repository — description, topics and README, at a recorded revision — and asks
a model what the project claims, where it overlaps this one, and what we would
deliberately *not* take from it. What comes back is a **draft you review**: every
field is editable, and nothing enters the list until you accept it. Discarding
costs nothing, because the entry never held more than a link.

## The rule that makes it worth reading

An entry marked `adopted` or `partial` must point at something in this repository:
a file, optionally with a line anchor; a golden-dataset case id; or the commit
that adopted the idea.

The model is given an index of this project's ADRs, evaluation cases and source
paths, and told to cite only from it; every reference it produces is then resolved
against the checkout, and the ones that do not resolve are **dropped and shown to
you**. That is the difference between a citation and a plausible file name.

`pnpm prior-art check` applies the same test to the seed content, and CI runs it,
so renaming a file fails the build instead of leaving a claim on a page that no
longer describes anything.

`watched` entries need a kill criterion, because "we are watching this" with no
exit condition is how a list like this rots. `rejected` entries need no evidence:
the reason *is* the evidence, and the entries that record a rejection are usually
the more useful half.

## Reading a repository

Uses the public GitHub API — 60 requests an hour without a token, 5000 with one,
so set `GITHUB_TOKEN` in `.env` if you will use this often.

An assessment runs inside the API process, one at a time. A restart mid-assessment
fails it and offers a retry rather than resuming it; a second instance would need
the queue moved out of the process. That limitation is listed under "Not built yet"
in the README.

## Commands

```bash
pnpm prior-art list      # what is on the page
pnpm prior-art check     # resolve every claim against this checkout
pnpm prior-art seed      # write the versioned seed content into the database
```
