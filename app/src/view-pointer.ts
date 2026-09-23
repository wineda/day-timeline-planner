/**
 * タイムラインビューのポインタ操作: ドラッグ（バーの移動・長さ変更・チップからの割り当て）、
 * タッチの長押し、横スワイプ、Ctrl+ホイール / ピンチのズーム、空き時間からの作成。
 * DayTimelineView のミックスイン（view.ts の末尾で合成）。this はビュー自身
 */
import { ScheduledTask, Task } from "./model";
import { MAX_HOUR_HEIGHT, MIN_HOUR_HEIGHT } from "./settings";
import { clamp, isSameDay, minutesToHHMM } from "./util";
import type { DayTimelineView } from "./view";
import {
  LONG_PRESS_MS,
  SWIPE_MIN_X,
  TOUCH_SLOP,
  WHEEL_ZOOM_INTENSITY,
  type DayColumn,
  type DragHandlers,
} from "./view-shared";

export class PointerMixin {
  /**
   * タッチの横スワイプで前後の日（3日・週・月）へ移動する（Google カレンダー方式）。
   * 縦のスクロールはブラウザに任せ（CSS の touch-action: pan-y）、横方向だけをここで拾う。
   * 以前は横スワイプが「空き時間のドラッグ」と解釈されてタスク作成ダイアログが開いてしまっていた
   */
  attachSwipeNavigation(this: DayTimelineView): void {
    this.scrollEl.addEventListener(
      "pointerdown",
      (e: PointerEvent) => {
        if (!this.isTouch(e) || !e.isPrimary) return;
        const sx = e.clientX;
        const sy = e.clientY;
        const id = e.pointerId;
        const cleanup = () => {
          document.removeEventListener("pointermove", onMove, true);
          document.removeEventListener("pointerup", onEnd, true);
          document.removeEventListener("pointercancel", onEnd, true);
        };
        const onMove = (ev: PointerEvent) => {
          if (ev.pointerId !== id) return;
          // 長押しから始まったドラッグ（タスク移動・範囲作成）中と2本指ピンチ中はスワイプしない
          if (this.interacting || this.pinchZooming) {
            cleanup();
            return;
          }
          const dx = ev.clientX - sx;
          const dy = ev.clientY - sy;
          // 縦方向が優勢ならスクロールに譲る
          if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > TOUCH_SLOP) {
            cleanup();
            return;
          }
          if (Math.abs(dx) >= SWIPE_MIN_X && Math.abs(dx) > Math.abs(dy) * 1.5) {
            cleanup();
            this.dismissTouchChip();
            if (dx < 0) this.goToNext();
            else this.goToPrev();
          }
        };
        const onEnd = (ev: PointerEvent) => {
          if (ev.pointerId !== id) return;
          cleanup();
        };
        document.addEventListener("pointermove", onMove, true);
        document.addEventListener("pointerup", onEnd, true);
        document.addEventListener("pointercancel", onEnd, true);
      },
      { capture: true }
    );

    // タイムライン内の横ジェスチャが Obsidian 本体（モバイルのサイドバー開閉）に
    // 取られてしまわないよう、横方向優勢の touchmove はここで止める
    let tsx = 0;
    let tsy = 0;
    this.scrollEl.addEventListener(
      "touchstart",
      (ev: TouchEvent) => {
        const t = ev.touches[0];
        if (!t) return;
        tsx = t.clientX;
        tsy = t.clientY;
      },
      { passive: true }
    );
    this.scrollEl.addEventListener(
      "touchmove",
      (ev: TouchEvent) => {
        const t = ev.touches[0];
        if (!t) return;
        if (Math.abs(t.clientX - tsx) > Math.abs(t.clientY - tsy)) ev.stopPropagation();
      },
      { passive: true }
    );
  }

  /**
   * Ctrl（macOS では Cmd でも可）＋ホイールで時間軸を拡大・縮小する。
   * トラックパッドのピンチも Chromium では ctrlKey 付きの wheel として届くので同じ経路になる。
   * Obsidian 本体の Ctrl+ホイール（UI 全体のズーム）に取られないよう、既定の動作と伝播を止める
   */
  attachWheelZoom(this: DayTimelineView): void {
    this.scrollEl.addEventListener(
      "wheel",
      (ev: WheelEvent) => {
        if (!ev.ctrlKey && !ev.metaKey) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (this.interacting) return; // ドラッグ中に縮尺が変わると座標計算が狂う
        // deltaMode は 0=px / 1=行 / 2=ページ（Chromium は px だが念のため換算する）
        const dy = ev.deltaY * (ev.deltaMode === 1 ? 33 : ev.deltaMode === 2 ? 300 : 1);
        this.pendingZoomFactor *= Math.exp(-dy * WHEEL_ZOOM_INTENSITY);
        this.pendingZoomClientY = ev.clientY;
        this.schedulePendingZoom();
      },
      { passive: false }
    );
  }

  /**
   * タッチの2本指ピンチで時間軸を拡大・縮小する（モバイル向け。Google カレンダー方式）。
   * 指の間隔の変化を倍率にし、2本指の中間点の時刻を保ったまま縮尺を変える
   * （中間点が動けばその分だけ追従するので、ピンチしながらのスクロールも自然につながる）。
   *
   * 注意: ズームのたびにグリッドは作り直されるため、touchstart した要素はピンチの途中で
   * DOM から外れる。touch イベントは外れた後もその要素にだけ届き続け、scrollEl へは
   * バブルしなくなるので、move / end は開始時点の各タッチの target に直接付ける
   */
  attachPinchZoom(this: DayTimelineView): void {
    /** ピンチ中に move / end リスナを付けた要素（終了時に外す）。SVG（アイコン）上の
     * タッチもあり得るので HTMLElement に限らない */
    let attachedEls: GlobalEventHandlers[] = [];
    /** 直前のフレームでの2本指の間隔（px） */
    let lastDist = 0;

    const distOf = (ev: TouchEvent): number => {
      const a = ev.touches[0];
      const b = ev.touches[1];
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    };

    const detach = () => {
      for (const el of attachedEls) {
        el.removeEventListener("touchmove", onMove);
        el.removeEventListener("touchend", onEnd);
        el.removeEventListener("touchcancel", onEnd);
      }
      attachedEls = [];
    };

    const onMove = (ev: TouchEvent) => {
      if (!this.pinchZooming) return;
      if (ev.touches.length < 2) return;
      // ブラウザにスクロールを始めさせない（すでにスクロール中だと cancelable でないことがある）
      if (ev.cancelable) ev.preventDefault();
      ev.stopPropagation();
      const d = distOf(ev);
      if (lastDist > 0 && d > 0) {
        this.pendingZoomFactor *= d / lastDist;
        this.pendingZoomClientY = (ev.touches[0].clientY + ev.touches[1].clientY) / 2;
        this.schedulePendingZoom();
      }
      lastDist = d;
    };

    const onEnd = (ev: TouchEvent) => {
      if (!this.pinchZooming) return;
      if (ev.touches.length >= 2) {
        // 3本目以降の指が離れただけ。間隔を測り直して続ける（外れた指の分で跳ねないように）
        lastDist = distOf(ev);
        return;
      }
      this.pinchZooming = false;
      detach();
      // ピンチ後に残った指へブラウザが合成する click が、指の位置のタスクや空き時間に
      // 当たって編集・チップ表示が誤発動しないように握りつぶす
      this.swallowNextClick();
    };

    this.scrollEl.addEventListener(
      "touchstart",
      (ev: TouchEvent) => {
        if (ev.touches.length !== 2) return; // 2本目が置かれた瞬間だけ開始
        if (this.interacting || this.pinchZooming) return;
        // ev.touches は画面全体のタッチ。1本目がパネルなどタイムラインの外にあるなら
        // ピンチにしない（パネルのスクロールを止めてしまわないように）
        for (let i = 0; i < ev.touches.length; i++) {
          const t = ev.touches[i].target;
          if (!(t instanceof Node) || !this.scrollEl.contains(t)) return;
        }
        this.pinchZooming = true;
        this.dismissTouchChip();
        this.canvasTapArmed = false;
        lastDist = distOf(ev);
        // 2本目の指でのネイティブ動作（スクロール開始・合成 click）を止める。
        // 1本目の touchstart は通常どおり通しているので、1本指のスクロールは妨げない
        if (ev.cancelable) ev.preventDefault();
        ev.stopPropagation();
        for (let i = 0; i < ev.touches.length; i++) {
          const t = ev.touches[i].target;
          const el: GlobalEventHandlers =
            t instanceof HTMLElement || t instanceof SVGElement ? t : this.scrollEl;
          if (attachedEls.includes(el)) continue;
          attachedEls.push(el);
          el.addEventListener("touchmove", onMove, { passive: false });
          el.addEventListener("touchend", onEnd);
          el.addEventListener("touchcancel", onEnd);
        }
      },
      { passive: false, capture: true }
    );
  }

  /** ためておいたズームぶんの反映を次のフレームに予約する（グリッドの作り直しは重いのでまとめる） */
  schedulePendingZoom(this: DayTimelineView): void {
    if (this.pendingZoomRaf != null) return;
    this.pendingZoomRaf = requestAnimationFrame(() => {
      this.pendingZoomRaf = null;
      this.applyPendingZoom();
    });
  }

  /** ためておいたホイール・ピンチぶんの拡大縮小を、ポインタ位置の時刻を保ったまま反映する */
  applyPendingZoom(this: DayTimelineView): void {
    const factor = this.pendingZoomFactor;
    this.pendingZoomFactor = 1;
    if (!this.scrollEl?.isConnected) return;
    const s = this.plugin.settings;
    const next = clamp(this.hourHeightPx * factor, MIN_HOUR_HEIGHT, MAX_HOUR_HEIGHT);
    if (Math.abs(next - this.hourHeightPx) < 0.01) return; // 既に上限・下限
    // 「1時間の高さ」として記憶する。
    // 0.1px 単位に丸めるのは、トラックパッドの細かい delta でも値が進む（整数に丸めると止まる）ようにするため
    s.hourHeight = Math.round(next * 10) / 10;
    this.persistZoomDebounced();
    this.rebuildTimeline(this.pendingZoomClientY);
  }

  /**
   * サイドバーのチップをタイムラインへドラッグする共通処理。
   * ドラッグ中はゴーストを出し、グリッドに落とすと onDrop(日, 開始, 終了)、
   * 動かさずに離すと onClick を呼ぶ
   */
  attachChipDrag(
    this: DayTimelineView,
    chip: HTMLElement,
    ignoreSelector: string,
    ghostLabel: () => string,
    onDrop: (date: Date, start: number, end: number) => void,
    onClick: () => void
  ): void {
    // タッチではタップ（＝ネイティブの click）で開き、長押ししてからドラッグ
    // （パネルのスクロールを妨げない）
    let touchTapArmed = false;
    chip.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      touchTapArmed = false;
      if ((e.target as HTMLElement).closest(ignoreSelector)) return;
      if (this.isTouch(e)) {
        touchTapArmed = true;
        this.touchGate(chip, e, {
          onLongPress: () => {
            touchTapArmed = false;
            chip.addClass("is-lifted");
            begin(e);
          },
        });
        return;
      }
      e.preventDefault();
      begin(e);
    });
    chip.addEventListener("click", (ce: MouseEvent) => {
      if (!touchTapArmed) return; // マウスのクリックは begin の onEnd(!moved) が扱う
      touchTapArmed = false;
      ce.stopPropagation();
      if (this.touchDragging) return;
      if ((ce.target as HTMLElement).closest(ignoreSelector)) return;
      onClick();
    });
    const begin = (e: PointerEvent) => {
      const s = this.plugin.settings;
      const dayStart = s.startHour * 60;
      const dayEnd = s.endHour * 60;
      let ghost: HTMLElement | null = null;
      let dropStart: number | null = null;
      let dropCol: DayColumn | null = null;
      const duration = s.defaultDurationMinutes;

      this.startDrag(chip, e, {
        onMove: (_dy, ev) => {
          chip.addClass("is-dragging");
          const over = this.overGrid(ev) ? this.columnAt(ev.clientX, ev.clientY) : null;
          if (!over) {
            dropStart = null;
            dropCol = null;
            ghost?.remove();
            ghost = null;
            return;
          }
          if (over !== dropCol) {
            ghost?.remove();
            ghost = null;
            dropCol = over;
          }
          dropStart = clamp(
            this.snapFloor(this.clientYToMinutes(ev.clientY, over.row)),
            dayStart,
            Math.max(dayStart, dayEnd - duration)
          );
          if (!ghost) ghost = over.eventsEl.createDiv("dt-ghost");
          ghost.style.top = this.minutesToPx(dropStart) + "px";
          ghost.style.height =
            Math.max(this.minutesToPx(dropStart + duration) - this.minutesToPx(dropStart) - 2, 4) + "px";
          ghost.setText(
            `${minutesToHHMM(dropStart)} - ${minutesToHHMM(dropStart + duration)}  ${ghostLabel()}`
          );
        },
        onEnd: (moved) => {
          chip.removeClass("is-dragging");
          chip.removeClass("is-lifted");
          ghost?.remove();
          if (!moved) {
            if (this.isTouch(e)) this.swallowNextClick(); // 合成 click がダイアログに当たらないように
            onClick();
            return;
          }
          if (dropStart !== null && dropCol) {
            onDrop(dropCol.date, dropStart, Math.min(dropStart + duration, dayEnd));
          }
        },
        onCancel: () => {
          chip.removeClass("is-dragging");
          chip.removeClass("is-lifted");
          ghost?.remove();
        },
      });
    };
  }

  isTouch(this: DayTimelineView, e: PointerEvent): boolean {
    return e.pointerType === "touch";
  }

  /**
   * タッチの pointerdown から「長押し」だけを判定する。
   * - 指が動かないまま LONG_PRESS_MS 経過 → onLongPress（ここからドラッグを始める）
   * - 先に TOUCH_SLOP を超えて動いた / 離した / キャンセル → 何もしない
   *   （スクロール・横スワイプはブラウザと swipe ナビに、タップは各要素の click に任せる。
   *    タップを pointerup から自前で再構成すると、実機の WebView や Obsidian 本体の
   *    ジェスチャ処理に食われて拾えないことがあるため、click に寄せている）
   */
  touchGate(this: DayTimelineView, target: HTMLElement, e: PointerEvent, h: { onLongPress: () => void }): void {
    const pointerId = e.pointerId;
    const sx = e.clientX;
    const sy = e.clientY;
    const cleanup = () => {
      window.clearTimeout(timer);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUpOrCancel);
      target.removeEventListener("pointercancel", onUpOrCancel);
    };
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (Math.abs(ev.clientX - sx) > TOUCH_SLOP || Math.abs(ev.clientY - sy) > TOUCH_SLOP) cleanup();
    };
    const onUpOrCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      cleanup();
    };
    const timer = window.setTimeout(() => {
      cleanup();
      // 2本指ピンチが始まっていたら長押しにしない（指をあまり動かさないピンチで
      // ドラッグが誤って始まらないように）
      if (this.pinchZooming) return;
      navigator.vibrate?.(15);
      h.onLongPress();
    }, LONG_PRESS_MS);
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUpOrCancel);
    target.addEventListener("pointercancel", onUpOrCancel);
  }

  /**
   * タッチ操作の直後にブラウザが合成する click を、次の1回だけ握りつぶす。
   * 長押しから指を離した位置にメニューやダイアログが出ると、その合成 click が
   * 出てきたばかりの UI に当たって即閉じてしまうのを防ぐ
   */
  swallowNextClick(this: DayTimelineView): void {
    const swallow = (ev: MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      cleanup();
    };
    const cleanup = () => {
      document.removeEventListener("click", swallow, true);
      window.clearTimeout(timer);
    };
    const timer = window.setTimeout(cleanup, 400);
    document.addEventListener("click", swallow, { capture: true });
  }

  /** マウス／タッチのドラッグをまとめて扱う */
  startDrag(this: DayTimelineView, target: HTMLElement, e: PointerEvent, h: DragHandlers): void {
    const startY = e.clientY;
    const pointerId = e.pointerId;
    const touch = this.isTouch(e);
    let moved = false;
    this.interacting = true;
    if (touch) this.touchDragging = true;

    // タッチのドラッグ中はブラウザにスクロールを始めさせない（始まると pointercancel で
    // ドラッグが打ち切られる）。touch イベントは touchstart した要素に届き続けるので
    // target で受けられる
    const onTouchMove = (ev: TouchEvent) => ev.preventDefault();
    if (touch) target.addEventListener("touchmove", onTouchMove, { passive: false });

    const detach = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onCancel);
      if (touch) target.removeEventListener("touchmove", onTouchMove);
      try {
        target.releasePointerCapture(pointerId);
      } catch (_e) {
        /* すでに解放済み */
      }
    };
    const done = () => {
      this.interacting = false;
      // contextmenu（Android は長押しの約 500ms 後、指を離した後に来ることもある）を
      // 拾ってメニューが二重に開かないよう、少し遅らせて解除する
      if (touch) window.setTimeout(() => (this.touchDragging = false), 350);
      if (this.pendingReload) {
        this.pendingReload = false;
        void this.reload();
      }
    };
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const dy = ev.clientY - startY;
      if (!moved && Math.abs(dy) < 3 && Math.abs(ev.clientX - e.clientX) < 3) return;
      moved = true;
      h.onMove?.(dy, ev);
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      detach();
      h.onEnd(moved, ev);
      done();
    };
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      detach();
      h.onCancel?.();
      done();
    };

    try {
      target.setPointerCapture(pointerId);
    } catch (_e) {
      /* 非対応環境 */
    }
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onCancel);
  }

  /** 空き時間のクリック／ドラッグ → タスクを作成 */
  onCanvasPointerDown(this: DayTimelineView, e: PointerEvent, col: DayColumn): void {
    if (e.button !== 0) return;
    const targetEl = e.target as HTMLElement;
    this.canvasTapArmed = false;
    if (targetEl.closest(".dt-event")) return;

    if (this.isTouch(e)) {
      // チップ自身のタップはチップの click（作成ダイアログを開く）に任せる
      if (targetEl.closest(".dt-touch-chip")) return;
      // タッチでは誤操作を避ける: タップ（＝ネイティブの click、onCanvasClick）→
      // 「＋ 追加」チップを出して 2 タップ目で作成、長押し → その場からドラッグで
      // 範囲を決めて作成（Google カレンダー方式）。スクロール・横スワイプでは何もしない
      this.canvasTapArmed = true;
      this.touchGate(col.canvasEl, e, {
        onLongPress: () => {
          this.canvasTapArmed = false;
          this.beginCanvasCreateDrag(e, col);
        },
      });
      return;
    }
    this.dismissTouchChip();
    this.beginCanvasCreateDrag(e, col);
  }

  /** タッチのタップ（ブラウザが確定した click）で「＋ 追加」チップを出す */
  onCanvasClick(this: DayTimelineView, e: MouseEvent, col: DayColumn): void {
    if (!this.canvasTapArmed) return; // マウスのクリックは onCanvasPointerDown 側で扱う
    this.canvasTapArmed = false;
    if (this.touchDragging) return;
    const targetEl = e.target as HTMLElement;
    if (targetEl.closest(".dt-event, .dt-touch-chip")) return;
    this.showTouchCreateChip(col, e.clientY);
  }

  /** タッチで空き時間をタップ → その枠に「＋ 時刻」チップを出す。チップをタップで作成 */
  showTouchCreateChip(this: DayTimelineView, col: DayColumn, clientY: number): void {
    this.dismissTouchChip();
    const s = this.plugin.settings;
    const dayStart = s.startHour * 60;
    const dayEnd = s.endHour * 60;
    const start = clamp(this.snapFloor(this.clientYToMinutes(clientY, col.row)), dayStart, dayEnd - s.snapMinutes);
    const end = Math.min(start + s.defaultDurationMinutes, dayEnd);
    const el = col.eventsEl.createDiv("dt-ghost dt-touch-chip");
    el.style.top = this.minutesToPx(start) + "px";
    el.style.height = Math.max(this.minutesToPx(end) - this.minutesToPx(start) - 2, 4) + "px";
    el.setText(`＋ ${minutesToHHMM(start)} - ${minutesToHHMM(end)}`);
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.dismissTouchChip();
      this.openCreateModal(col.date, start, end);
    });
    this.touchChipEl = el;
  }

  dismissTouchChip(this: DayTimelineView): void {
    this.touchChipEl?.remove();
    this.touchChipEl = null;
  }

  /** 空き時間からのドラッグ（マウス、またはタッチの長押し後）でタスクを作成する */
  beginCanvasCreateDrag(this: DayTimelineView, e: PointerEvent, col: DayColumn): void {
    const s = this.plugin.settings;
    const dayStart = s.startHour * 60;
    const dayEnd = s.endHour * 60;
    const snap = s.snapMinutes;
    const anchor = clamp(this.snapFloor(this.clientYToMinutes(e.clientY, col.row)), dayStart, dayEnd - snap);
    const defaultRange = (): [number, number] => [
      anchor,
      Math.min(anchor + s.defaultDurationMinutes, dayEnd),
    ];
    let range = defaultRange();

    const ghost = col.eventsEl.createDiv("dt-ghost");
    const drawGhost = () => {
      ghost.style.top = this.minutesToPx(range[0]) + "px";
      ghost.style.height = Math.max(this.minutesToPx(range[1]) - this.minutesToPx(range[0]) - 2, 4) + "px";
      ghost.setText(`${minutesToHHMM(range[0])} - ${minutesToHHMM(range[1])}`);
    };
    drawGhost();

    this.startDrag(col.canvasEl, e, {
      onMove: (_dy, ev) => {
        const cur = clamp(this.snapFloor(this.clientYToMinutes(ev.clientY, col.row)), dayStart, dayEnd - snap);
        if (cur === anchor) range = defaultRange();
        else if (cur > anchor) range = [anchor, cur + snap];
        else range = [cur, anchor + snap];
        drawGhost();
      },
      onEnd: (moved) => {
        if (!moved) {
          range = defaultRange();
          // 長押しだけで離した場合は合成 click が来うるので、ダイアログに当たらないように
          if (this.isTouch(e)) this.swallowNextClick();
        }
        this.openCreateModal(col.date, range[0], range[1], () => ghost.remove());
      },
      onCancel: () => ghost.remove(),
    });
  }

  attachEventInteractions(
    this: DayTimelineView,
    el: HTMLElement,
    timeEl: HTMLElement,
    handle: HTMLElement,
    col: DayColumn,
    task: ScheduledTask
  ): void {
    const s = this.plugin.settings;
    const dayStart = s.startHour * 60;
    const dayEnd = s.endHour * 60;

    // 本体: クリックで編集（Ctrl/Cmd+クリックでノートへ）、ドラッグで移動（週表示では別の日へも）。
    // タッチではタップ（＝ネイティブの click）で編集、長押ししてからドラッグで移動
    // （長押しして動かさなければメニュー）
    let touchTapArmed = false;
    el.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      touchTapArmed = false;
      if (this.isTouch(e)) {
        touchTapArmed = true;
        this.touchGate(el, e, {
          onLongPress: () => {
            touchTapArmed = false;
            el.addClass("is-lifted");
            beginMove(e, true);
          },
        });
        return;
      }
      beginMove(e, false);
    });
    // タップ = ブラウザが確定した click（スクロールや長押しになったタップでは発火しない）。
    // マウスのクリックは beginMove の onEnd(!moved) が扱うのでここでは無視する
    el.addEventListener("click", (ce: MouseEvent) => {
      ce.stopPropagation();
      if (!touchTapArmed) return;
      touchTapArmed = false;
      if (this.touchDragging) return;
      this.openEditModal(col.date, task);
    });
    const beginMove = (e: PointerEvent, viaLongPress: boolean) => {
      const dur = task.end - task.start;
      // 掴んだ位置がブロックの上端から何分か（別の段へ運ぶとき、その段の時間軸で上端を出すのに使う）
      const grabOffset = this.clientYToMinutes(e.clientY, col.row) - task.start;
      let newStart = task.start;
      let targetCol: DayColumn = col;
      this.startDrag(el, e, {
        onMove: (dy, ev) => {
          const over = this.columns.length > 1 ? (this.columnAt(ev.clientX, ev.clientY) ?? col) : col;
          // 同じ段ならポインタの移動量から。別の段（2週間表示の今週 ⇄ 来週）なら、
          // その段の時間軸でのポインタ位置から時刻を出す（段の間の距離を足し込まない）
          const raw =
            over.row === col.row
              ? task.start + this.pxToMinutes(dy)
              : this.clientYToMinutes(ev.clientY, over.row) - grabOffset;
          newStart = clamp(this.snapRound(raw), dayStart, Math.max(dayStart, dayEnd - dur));
          el.addClass("is-dragging");
          el.style.top = this.minutesToPx(newStart) + "px";
          timeEl.setText(`${minutesToHHMM(newStart)} - ${minutesToHHMM(newStart + dur)}`);
          if (over !== targetCol) {
            targetCol = over;
            // 要素は元の列に置いたまま、ずらして別の日の列（別の段）の上に見せる
            // （DOM を移すとポインタキャプチャが外れる環境があるため）
            const from = col.canvasEl.getBoundingClientRect();
            const to = targetCol.canvasEl.getBoundingClientRect();
            const dx = to.left - from.left;
            const dyRow = to.top - from.top;
            el.style.transform = dx || dyRow ? `translate(${dx}px, ${dyRow}px)` : "";
            el.toggleClass("is-moving-day", targetCol !== col);
          }
        },
        onEnd: (moved, ev) => {
          el.removeClass("is-dragging");
          el.removeClass("is-lifted");
          if (!moved) {
            // 長押しだけ（動かさず離した）→ 右クリック相当のメニュー。
            // モバイルでは完了・削除・持ち越しなどへの入口になる
            if (viaLongPress) {
              this.swallowNextClick(); // 合成 click がメニューに当たって即閉じないように
              this.showTaskMenu(col.date, task, ev);
            } else this.openEditModal(col.date, task);
            return;
          }
          const draft = { ...this.draftOf(task), start: newStart, end: newStart + dur };
          if (targetCol !== col) {
            void this.commitMove(col.date, task, targetCol.date, draft);
          } else if (newStart !== task.start) {
            void this.commitUpdate(col.date, task, draft);
          } else {
            this.renderEvents();
          }
        },
        onCancel: () => this.renderEvents(),
      });
    };

    // 下端のハンドル: ドラッグで終了時刻を変更（タッチでは長押ししてからドラッグ。
    // タップは el へバブルする click が編集を開く）
    handle.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      touchTapArmed = false;
      if (this.isTouch(e)) {
        touchTapArmed = true;
        this.touchGate(handle, e, {
          onLongPress: () => {
            touchTapArmed = false;
            el.addClass("is-lifted");
            beginResize(e);
          },
        });
        return;
      }
      beginResize(e);
    });
    const beginResize = (e: PointerEvent) => {
      let newEnd = task.end;
      this.startDrag(handle, e, {
        onMove: (dy) => {
          newEnd = clamp(this.snapRound(task.end + this.pxToMinutes(dy)), task.start + s.snapMinutes, dayEnd);
          el.addClass("is-dragging");
          el.style.height = Math.max(this.minutesToPx(newEnd) - this.minutesToPx(task.start) - 2, 4) + "px";
          timeEl.setText(`${minutesToHHMM(task.start)} - ${minutesToHHMM(newEnd)}`);
        },
        onEnd: (moved) => {
          el.removeClass("is-dragging");
          el.removeClass("is-lifted");
          if (moved && newEnd !== task.end) {
            void this.commitUpdate(col.date, task, { ...this.draftOf(task), end: newEnd });
          } else {
            this.renderEvents();
          }
        },
        onCancel: () => this.renderEvents(),
      });
    };

    // 右クリックメニュー
    el.addEventListener("contextmenu", (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.touchDragging) return; // 長押しドラッグ中の contextmenu（Android）は無視
      this.showTaskMenu(col.date, task, e);
    });
  }

  /** トレイのチップ: クリックで編集、タイムラインへドラッグで時刻を割り当て */
  attachTrayInteractions(this: DayTimelineView, chip: HTMLElement, date: Date, task: Task): void {
    this.attachChipDrag(
      chip,
      ".dt-tray-check",
      () => this.displayTitle(task),
      (dropDate, start, end) => {
        const draft = { ...this.draftOf(task), start, end };
        if (isSameDay(dropDate, date)) void this.commitUpdate(date, task, draft);
        else void this.commitMove(date, task, dropDate, draft);
      },
      () => this.openEditModal(date, task)
    );

    chip.addEventListener("contextmenu", (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.touchDragging) return;
      this.showTaskMenu(date, task, e);
    });
  }

  /** Inbox のチップ: クリックで編集、タイムラインへドラッグでその日に移して時刻を割り当て */
  attachInboxInteractions(this: DayTimelineView, chip: HTMLElement, task: Task): void {
    this.attachChipDrag(
      chip,
      ".dt-tray-check",
      () => this.displayTitle(task),
      (date, start, end) =>
        void this.commitInboxToDay(task, date, { ...this.draftOf(task), start, end }),
      () => this.openInboxEditModal(task)
    );

    chip.addEventListener("contextmenu", (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.touchDragging) return;
      this.showInboxTaskMenu(task, e);
    });
  }
}
