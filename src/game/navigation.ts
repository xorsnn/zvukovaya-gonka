import type { WordScene } from "./types";

/**
 * The query-string key that carries the active experience, e.g. `?scene=vot`
 * (issue #20). A QUERY param, not a path segment: the build is served
 * path-relative (`base: "./"` in `vite.config.ts`) from GitHub Pages, any
 * subfolder, or even `file://`, so there is no server to rewrite a `/pull` path
 * route (it would 404 on a hard reload). Sits alongside the existing `?debug`.
 */
export const SCENE_PARAM = "scene";

export interface ResolvedScene {
  /** The pickable scene id to make active (always a real, pickable id). */
  id: string;
  /**
   * The canonical value the URL's `scene` param should carry: the id for an
   * explicit valid pick, or `null` when the URL should have NO `scene` param
   * (absent / empty / unknown token → the default, kept as a clean URL).
   */
  param: string | null;
}

/**
 * Resolve a raw `?scene=` value against the pickable scenes. Pure and DOM-free
 * (unit-testable in plain Node, like `carrotDepth`/`stepPlay`), so the deep-link
 * contract is verified without a browser.
 *
 *   • `null` / `""`                  → default, no param (clean cold-load URL)
 *   • a known PICKABLE id (any case) → that scene, param = its canonical id
 *   • anything else (garbage, or a real-but-not-pickable word like `dom`/`kit`)
 *                                    → default, no param (the bad token is dropped)
 *
 * The default experience is represented by the ABSENCE of the param, so a fresh
 * visit stays a clean URL and reproduces the pre-#20 flow byte-for-byte.
 */
export function resolveSceneParam(
  raw: string | null,
  pickable: WordScene[],
  defaultId: string,
): ResolvedScene {
  const token = raw?.trim().toLowerCase() ?? "";
  if (token) {
    const hit = pickable.find((s) => s.id.toLowerCase() === token);
    if (hit) return { id: hit.id, param: hit.id };
  }
  return { id: defaultId, param: null };
}
