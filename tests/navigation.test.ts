import { describe, it, expect } from "vitest";
import { resolveSceneParam, SCENE_PARAM } from "../src/game/navigation";
import { PICKABLE_SCENES, DEFAULT_WORD } from "../src/game/words";

// --- URL scene deep-link resolver (#20) --------------------------------------
// Pure, DOM-free: the deep-link contract is verified in plain Node. The DOM
// wiring (replaceState, card write, init parse in main.ts) is browser-smoke
// tested, same as the #16 picker.

const DEFAULT_ID = DEFAULT_WORD.id; // "kot"

describe("resolveSceneParam", () => {
  it("absent param → default, clean URL (no param)", () => {
    expect(resolveSceneParam(null, PICKABLE_SCENES, DEFAULT_ID)).toEqual({
      id: DEFAULT_ID,
      param: null,
    });
  });

  it("empty / whitespace param → default, clean URL", () => {
    expect(resolveSceneParam("", PICKABLE_SCENES, DEFAULT_ID)).toEqual({
      id: DEFAULT_ID,
      param: null,
    });
    expect(resolveSceneParam("   ", PICKABLE_SCENES, DEFAULT_ID)).toEqual({
      id: DEFAULT_ID,
      param: null,
    });
  });

  it("a valid pickable id resolves to itself and carries the param", () => {
    expect(resolveSceneParam("vot", PICKABLE_SCENES, DEFAULT_ID)).toEqual({
      id: "vot",
      param: "vot",
    });
    expect(resolveSceneParam("kot", PICKABLE_SCENES, DEFAULT_ID)).toEqual({
      id: "kot",
      param: "kot",
    });
  });

  it("is case-insensitive and canonicalizes to the lowercase id", () => {
    expect(resolveSceneParam("VOT", PICKABLE_SCENES, DEFAULT_ID)).toEqual({
      id: "vot",
      param: "vot",
    });
    expect(resolveSceneParam("Kot", PICKABLE_SCENES, DEFAULT_ID)).toEqual({
      id: "kot",
      param: "kot",
    });
  });

  it("unknown token → default, dropped from the URL", () => {
    expect(resolveSceneParam("foo", PICKABLE_SCENES, DEFAULT_ID)).toEqual({
      id: DEFAULT_ID,
      param: null,
    });
  });

  it("a real but NON-pickable word (dom/kit) → default, dropped", () => {
    // дом/кит exist in WORDS but are not surfaced in the picker, so they are not
    // linkable — only pickable experiences get a URL.
    expect(resolveSceneParam("dom", PICKABLE_SCENES, DEFAULT_ID)).toEqual({
      id: DEFAULT_ID,
      param: null,
    });
    expect(resolveSceneParam("kit", PICKABLE_SCENES, DEFAULT_ID)).toEqual({
      id: DEFAULT_ID,
      param: null,
    });
  });

  it("the resolved id is always a real pickable scene", () => {
    for (const raw of [null, "", "vot", "VOT", "foo", "dom"]) {
      const { id } = resolveSceneParam(raw, PICKABLE_SCENES, DEFAULT_ID);
      expect(PICKABLE_SCENES.some((s) => s.id === id)).toBe(true);
    }
  });

  it("exposes the query key as `scene`", () => {
    expect(SCENE_PARAM).toBe("scene");
  });
});
