/**
 * view.ts の分割（ミックスイン）: 各ファイルのメソッドがビューのプロトタイプに合成されていること
 */
import { describe, expect, it } from "vitest";
import { DayTimelineView } from "../src/view";
import { SidebarMixin } from "../src/view-sidebar";
import { PointerMixin } from "../src/view-pointer";
import { ActionsMixin } from "../src/view-actions";

const methodNames = (cls: { prototype: object }) =>
  Object.getOwnPropertyNames(cls.prototype).filter((n) => n !== "constructor");

describe("DayTimelineView のミックスイン", () => {
  it("分割したファイルのメソッドがビューのプロトタイプに全部入っている", () => {
    const proto = DayTimelineView.prototype as unknown as Record<string, unknown>;
    for (const m of [SidebarMixin, PointerMixin, ActionsMixin]) {
      for (const name of methodNames(m)) {
        expect(typeof proto[name], name).toBe("function");
      }
    }
  });

  it("同じ名前のメソッドがファイル間で重複していない", () => {
    const all = [SidebarMixin, PointerMixin, ActionsMixin].flatMap(methodNames);
    expect(new Set(all).size).toBe(all.length);
  });

  it("本体のメソッド（onOpen など）は残っている", () => {
    const proto = DayTimelineView.prototype as unknown as Record<string, unknown>;
    for (const name of ["onOpen", "onClose", "getViewType", "reload", "renderHeader", "rebuildTimeline"]) {
      expect(typeof proto[name], name).toBe("function");
    }
  });
});
