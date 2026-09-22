/**
 * Types for `i18n.js`.
 *
 * The interface is hand-written JavaScript served as-is by `apps/api`, with no
 * build step, so there is nothing to emit declarations from. This file is the
 * declaration for it: TypeScript resolves `./i18n.js` to this, which is what lets
 * `apps/api/src/web-ui.test.ts` import the dictionary and check it.
 *
 * It has to mirror the module. If it drifts, a call site stops typechecking —
 * which is the point, since the alternative is an untyped `any` import.
 */

export declare const LANGS: readonly string[]
export declare const MESSAGES_BY_LANG: Record<string, Record<string, string>>

/** Keys present in a language. Throws at import time if the tables diverge. */
export declare function keys(lang: string): string[]
export declare function languages(): string[]

/** Interpolates `{name}` placeholders; an unknown key renders as itself. */
export declare function t(key: string, params?: Record<string, string | number>): string

export declare function currentLang(): string
/** The stored choice, then the browser's, then `"en"`. */
export declare function initialLang(storage?: { getItem(key: string): string | null }): string
/** Sets `document.documentElement.lang` and re-applies the static markup. */
export declare function setLang(lang: string): string
export declare function applyStatic(root?: ParentNode): void

export declare function typeLabel(type: string): string
export declare function statusLabel(status: string): string
export declare function priorStatusLabel(status: string): string
export declare function evidenceLabel(kind: string): string
