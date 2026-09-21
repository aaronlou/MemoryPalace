import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createTestRuntime } from "@memory-palace/test-support"
import { describe, expect, it } from "vitest"
import { createApp, mountMcp } from "./app.js"

/**
 * Static verification of the web UI.
 *
 * A browser check would be better, but the environment cannot run one. These
 * assertions catch the failures that actually happen in a hand-written vanilla
 * UI and that no amount of API testing would notice:
 *
 *   - an element id renamed in the HTML but not in the JS (silent TypeError on load)
 *   - a fetch to a route that does not exist (works until the user clicks)
 *   - a colour pair that fails WCAG contrast
 *   - a third-party request from a local-first privacy tool
 *
 * They are cheap to run and they fail loudly, which is what a UI regression test
 * needs to do.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const webRoot = join(repoRoot, "apps", "web", "public")

const html = readFileSync(join(webRoot, "index.html"), "utf8")
const css = readFileSync(join(webRoot, "styles.css"), "utf8")
const js = readFileSync(join(webRoot, "app.js"), "utf8")

describe("element ids referenced by the script exist", () => {
  it("resolves every $('#id') and getElementById target", () => {
    // The drawer body is rendered by the script, so its ids legitimately appear
    // only in a template literal. An id counts as defined if it exists in the
    // static markup OR is emitted by the script itself.
    const htmlIds = new Set([
      ...[...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!),
      ...[...js.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]!),
      ...[...js.matchAll(/\sid='([A-Za-z0-9_-]+)'/g)].map((m) => m[1]!),
    ])
    const referenced = new Set<string>()

    for (const m of js.matchAll(/\$\("#([A-Za-z0-9_-]+)"\)/g)) referenced.add(m[1]!)
    for (const m of js.matchAll(/\$\$\("#([A-Za-z0-9_-]+)"\)/g)) referenced.add(m[1]!)
    for (const m of js.matchAll(/getElementById\("([A-Za-z0-9_-]+)"\)/g)) referenced.add(m[1]!)

    const missing = [...referenced].filter((id) => !htmlIds.has(id))
    expect(
      missing,
      `app.js references ids that index.html does not define: ${missing.join(", ")}`,
    ).toEqual([])
    // Sanity: the scan actually found something.
    expect(referenced.size).toBeGreaterThan(10)
  })

  it("has no duplicate ids", () => {
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!)
    const seen = new Set<string>()
    const duplicates: string[] = []
    for (const id of ids) {
      if (seen.has(id)) duplicates.push(id)
      else seen.add(id)
    }
    expect(duplicates).toEqual([])
  })
})

describe("the script only calls routes the server defines", () => {
  it("matches every api() path against the Hono route table", async () => {
    const rt = await createTestRuntime({ userId: "webui-test-user" })
    const app = createApp(rt)
    await mountMcp(app, rt)

    const routePaths = app.routes.map((r) => r.path)
    expect(routePaths.length).toBeGreaterThan(10)

    // Collect `api(...)` targets and strip query strings and template holes.
    const calls = new Set<string>()
    for (const m of js.matchAll(/api\(\s*[`"']([^`"']+)[`"']/g)) calls.add(m[1]!)
    for (const m of js.matchAll(/href="(\/api\/[^"?]+)/g)) calls.add(m[1]!)

    const missing: string[] = []
    for (const call of calls) {
      const path = call.split("?")[0]!.replace(/\$\{[^}]*\}/g, ":param")
      const known = routePaths.some((route) => {
        if (route === path) return true
        // Compare shapes, since ids are dynamic: /api/memories/:id vs /api/memories/:x
        const a = route.split("/")
        const b = path.split("/")
        if (a.length !== b.length) return false
        return a.every((seg, i) => seg.startsWith(":") || seg === b[i])
      })
      if (!known) missing.push(call)
    }

    expect(missing, `app.js calls routes that do not exist: ${missing.join(", ")}`).toEqual([])
    expect(calls.size).toBeGreaterThan(8)
    await rt.close()
  })
})

describe("accessibility and privacy basics", () => {
  it("makes no third-party network requests", () => {
    // A local-first tool must not announce to a CDN that you opened your memory
    // store. That rules out web fonts, icon CDNs and analytics.
    const external = [...`${html}${css}${js}`.matchAll(/https?:\/\/[^\s"')]+/g)]
      .map((m) => m[0])
      .filter((url) => !url.includes("127.0.0.1") && !url.includes("localhost"))
      // The SVG namespace is a spec identifier, never fetched.
      .filter((url) => !url.startsWith("http://www.w3.org/"))
    expect(external).toEqual([])
  })

  it("uses no emoji as structural icons", () => {
    // Emoji render differently per platform and cannot be themed; the UI uses
    // inline SVG instead.
    // The variation selector is an alternation, not a class member: combining
    // it into a range makes the class mean something different from what it reads.
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]|\uFE0F/u
    expect(emoji.test(html)).toBe(false)
    expect(emoji.test(js)).toBe(false)
  })

  it("labels every form control", () => {
    const controlIds = [...html.matchAll(/<(?:input|select|textarea)\b[^>]*\bid="([^"]+)"/g)].map(
      (m) => m[1]!,
    )
    const labelledIds = new Set([...html.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]!))
    const unlabelled = controlIds.filter((id) => {
      if (labelledIds.has(id)) return false
      // A control may instead carry an explicit accessible name.
      const tag = html.slice(html.indexOf(`id="${id}"`) - 300, html.indexOf(`id="${id}"`) + 300)
      return !/aria-label=/.test(tag)
    })
    expect(unlabelled, `unlabelled controls: ${unlabelled.join(", ")}`).toEqual([])
  })

  it("provides a skip link and a live region for announcements", () => {
    expect(html).toContain('class="skip-link"')
    expect(html).toMatch(/aria-live="polite"/)
  })

  it("never removes a focus outline without putting something in its place", () => {
    expect(css).toMatch(/:focus-visible\s*\{[^}]*box-shadow/)

    // `outline: none` is legitimate only when the same rule draws its own ring.
    // Removing it bare is the classic accessibility regression.
    const offenders: string[] = []
    for (const [index, match] of [...css.matchAll(/outline:\s*none\s*;/g)].entries()) {
      const ruleStart = css.lastIndexOf("}", match.index) + 1
      const ruleEnd = css.indexOf("}", match.index)
      const rule = css.slice(ruleStart, ruleEnd)
      if (!/box-shadow/.test(rule)) offenders.push(rule.trim().split("\n")[0] ?? `#${index}`)
    }
    expect(offenders, `outline removed with no replacement in: ${offenders.join(" | ")}`).toEqual(
      [],
    )
  })

  it("respects prefers-reduced-motion", () => {
    expect(css).toContain("prefers-reduced-motion: reduce")
  })

  it("meets the 44px minimum touch target for buttons", () => {
    const btnRule = css.slice(css.indexOf(".btn {"), css.indexOf(".btn:hover"))
    expect(btnRule).toMatch(/min-height:\s*44px/)
    expect(css).toMatch(/\.tab\s*\{[^}]*min-height:\s*44px/)
  })

  it("confirms destructive actions before performing them", () => {
    // Deleting a memory, replacing all data, and erasing everything must all ask.
    const confirms = [...js.matchAll(/window\.confirm\(/g)]
    expect(confirms.length).toBeGreaterThanOrEqual(3)
  })
})

describe("colour contrast meets WCAG AA", () => {
  function tokenCss(block: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]!] = m[2]!
    return out
  }

  function luminance(hex: string): number {
    const channel = (v: number) => {
      const c = v / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }
    const r = channel(Number.parseInt(hex.slice(1, 3), 16))
    const g = channel(Number.parseInt(hex.slice(3, 5), 16))
    const b = channel(Number.parseInt(hex.slice(5, 7), 16))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }

  function contrast(a: string, b: string): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
    return (hi + 0.05) / (lo + 0.05)
  }

  const lightBlock = css.slice(css.indexOf(":root {"), css.indexOf(':root[data-theme="dark"]'))
  const darkStart = css.indexOf(':root[data-theme="dark"]')
  const darkBlock = css.slice(darkStart, css.indexOf("@media (prefers-color-scheme: dark)"))

  const light = tokenCss(lightBlock)
  const dark = tokenCss(darkBlock)

  const pairs: Array<[string, string, string]> = [
    ["ink", "canvas", "body text"],
    ["ink", "surface", "text on cards"],
    ["muted", "surface", "secondary text"],
    ["muted", "canvas", "secondary text on canvas"],
    ["primary", "surface", "links and accents"],
    ["primary-ink", "primary", "primary button label"],
    ["danger", "surface", "danger text"],
  ]

  it("passes for the light theme", () => {
    for (const [fg, bg, label] of pairs) {
      const ratio = contrast(light[fg]!, light[bg]!)
      expect(ratio, `${label}: ${fg} on ${bg} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it("passes for the dark theme", () => {
    // Dark mode is verified separately: assuming the light values carry over is
    // how dark themes end up unreadable.
    for (const [fg, bg, label] of pairs) {
      const ratio = contrast(dark[fg]!, dark[bg]!)
      expect(ratio, `${label}: ${fg} on ${bg} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it("defines every token in both themes", () => {
    for (const key of Object.keys(light)) {
      expect(dark[key], `dark theme is missing --${key}`).toBeDefined()
    }
  })
})
