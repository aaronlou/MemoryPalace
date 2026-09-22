import { ConfigurationError, ValidationError } from "@memory-palace/shared"

/**
 * Reading a candidate repository.
 *
 * Only what an assessment needs: what the project says about itself, and the
 * revision that was read so the assessment can be attributed later. No cloning, no
 * source-tree walk — a README and the repository's own description carry the
 * thesis, and anything more would cost more than it informs.
 *
 * Injectable (`RepoFetcher`) so tests never touch the network, and so a future
 * source — a different host, a cached mirror — is an adapter rather than a rewrite.
 */

export interface RepoFacts {
  repo: string
  url: string
  description?: string
  topics: string[]
  stars?: number
  language?: string
  defaultBranch?: string
  /** Head of the default branch. The revision the assessment is about. */
  revision?: string
  readme?: string
  /** True when the README was cut, so a thin assessment can be explained. */
  readmeTruncated?: boolean
}

export interface RepoFetcher {
  fetch(repo: string): Promise<RepoFacts>
}

/** Enough to carry a thesis; beyond this the prompt is mostly badges and tables. */
export const README_LIMIT = 8000

const API = "https://api.github.com"
const TIMEOUT_MS = 15_000

export class GitHubRepoFetcher implements RepoFetcher {
  private readonly token: string | undefined

  constructor(token = process.env.GITHUB_TOKEN) {
    this.token = token
  }

  async fetch(repo: string): Promise<RepoFacts> {
    const meta = await this.get<{
      description: string | null
      topics?: string[]
      stargazers_count?: number
      language: string | null
      default_branch?: string
      html_url?: string
    }>(`/repos/${repo}`)

    const defaultBranch = meta.default_branch
    // The README endpoint redirects to the default branch, so it works even when
    // the branch name is unusual. A repository without one is still assessable.
    const readme = await this.readme(repo)
    const revision = defaultBranch ? await this.revision(repo, defaultBranch) : undefined

    const body = readme.text
    const truncated = body !== undefined && body.length > README_LIMIT

    return {
      repo,
      url: meta.html_url ?? `https://github.com/${repo}`,
      description: meta.description ?? undefined,
      topics: meta.topics ?? [],
      stars: meta.stargazers_count,
      language: meta.language ?? undefined,
      defaultBranch,
      revision,
      readme: truncated ? body.slice(0, README_LIMIT) : body,
      readmeTruncated: truncated,
    }
  }

  private async readme(repo: string): Promise<{ text?: string }> {
    try {
      const response = await this.request(`/repos/${repo}/readme`, "application/vnd.github.raw")
      if (!response.ok) return {}
      const text = (await response.text()).trim()
      return text === "" ? {} : { text }
    } catch {
      // A missing README is not a failure: the description and topics still say
      // something, and the model is told how thin its evidence is.
      return {}
    }
  }

  private async revision(repo: string, branch: string): Promise<string | undefined> {
    try {
      const response = await this.request(`/repos/${repo}/commits/${encodeURIComponent(branch)}`)
      if (!response.ok) return undefined
      const body = (await response.json()) as { sha?: string }
      return body.sha
    } catch {
      return undefined
    }
  }

  private request(path: string, accept = "application/vnd.github+json"): Promise<Response> {
    return fetch(`${API}${path}`, {
      headers: {
        accept,
        "user-agent": "memory-palace-prior-art",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  }

  private async get<T>(path: string): Promise<T> {
    let response: Response
    try {
      response = await this.request(path)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new ConfigurationError(
        `could not reach GitHub to read ${path}: ${reason}. Check the network, or set GITHUB_TOKEN if this is a rate limit.`,
      )
    }

    if (response.status === 404) {
      throw new ValidationError(`no public repository at ${path.replace("/repos/", "")}`)
    }
    if (response.status === 403 || response.status === 429) {
      const remaining = response.headers.get("x-ratelimit-remaining")
      throw new ConfigurationError(
        `GitHub refused the request (${response.status}${remaining ? `, ${remaining} left` : ""}). ` +
          `Unauthenticated requests are limited to 60 per hour; set GITHUB_TOKEN to raise it.`,
      )
    }
    if (!response.ok) {
      throw new ConfigurationError(`GitHub returned ${response.status} for ${path}`)
    }
    return (await response.json()) as T
  }
}
