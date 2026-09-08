const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;
const HANDLE_NAMES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

export function fitCanvasViewport(width, height) {
  if (width <= 0 || height <= 0) return { scale: 1, left: 0, top: 0 };
  const scale = Math.min(width / CANVAS_WIDTH, height / CANVAS_HEIGHT);
  return {
    scale,
    left: (width - CANVAS_WIDTH * scale) / 2,
    top: (height - CANVAS_HEIGHT * scale) / 2,
  };
}

export function fitCanvasText(node, preferredSize, minimumSize = 10) {
  let size = preferredSize;
  node.style.fontSize = `${size}px`;
  while (
    size > minimumSize
    && (node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight)
  ) {
    size -= 1;
    node.style.fontSize = `${size}px`;
  }
  return size;
}

function hex(value) {
  return typeof value === "string" && /^[0-9A-F]{6}$/i.test(value) ? `#${value}` : "#14213D";
}

export function clampBox(box) {
  const width = Math.min(CANVAS_WIDTH, Math.max(1, box.width));
  const height = Math.min(CANVAS_HEIGHT, Math.max(1, box.height));
  const x = Math.min(Math.max(0, box.x), CANVAS_WIDTH - width);
  const y = Math.min(Math.max(0, box.y), CANVAS_HEIGHT - height);
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

export function resizeBox(origin, handle, dx, dy) {
  let left = origin.x;
  let top = origin.y;
  let right = origin.x + origin.width;
  let bottom = origin.y + origin.height;
  if (handle.includes("w")) left = origin.x + dx;
  if (handle.includes("e")) right = origin.x + origin.width + dx;
  if (handle.includes("n")) top = origin.y + dy;
  if (handle.includes("s")) bottom = origin.y + origin.height + dy;
  left = Math.min(Math.max(0, left), CANVAS_WIDTH - 1);
  top = Math.min(Math.max(0, top), CANVAS_HEIGHT - 1);
  right = Math.min(Math.max(left + 1, right), CANVAS_WIDTH);
  bottom = Math.min(Math.max(top + 1, bottom), CANVAS_HEIGHT);
  if (handle.includes("w")) left = Math.min(left, right - 1);
  if (handle.includes("n")) top = Math.min(top, bottom - 1);
  return clampBox({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  });
}

export function nudgeBox(box, dx, dy) {
  return clampBox({
    x: box.x + dx,
    y: box.y + dy,
    width: box.width,
    height: box.height,
  });
}

export function translateBoxes(items, dx, dy) {
  if (items.length === 0) return [];
  let minX = Infinity;
  let minY = Infinity;
  let maxRight = -Infinity;
  let maxBottom = -Infinity;
  for (const item of items) {
    minX = Math.min(minX, item.box.x);
    minY = Math.min(minY, item.box.y);
    maxRight = Math.max(maxRight, item.box.x + item.box.width);
    maxBottom = Math.max(maxBottom, item.box.y + item.box.height);
  }
  const shiftX = Math.min(Math.max(dx, -minX), CANVAS_WIDTH - maxRight);
  const shiftY = Math.min(Math.max(dy, -minY), CANVAS_HEIGHT - maxBottom);
  return items.map((item) => ({
    id: item.id,
    box: clampBox({
      x: item.box.x + shiftX,
      y: item.box.y + shiftY,
      width: item.box.width,
      height: item.box.height,
    }),
  }));
}

function boxesIntersect(left, right) {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

export function idsIntersectingRect(elements, rect) {
  const width = Math.abs(rect.width);
  const height = Math.abs(rect.height);
  if (width < 2 && height < 2) return [];
  const area = {
    x: Math.min(rect.x, rect.x + rect.width),
    y: Math.min(rect.y, rect.y + rect.height),
    width,
    height,
  };
  return elements.filter((element) => boxesIntersect(element.box, area)).map((element) => element.id);
}

function payloadValue(slide, fieldPath) {
  if (fieldPath === "title") return slide.title;
  let cursor = slide.payload;
  for (const match of fieldPath.matchAll(/([A-Za-z][A-Za-z0-9_]*)|\[(\d+)\]/g)) {
    if (cursor === null || typeof cursor !== "object") return null;
    cursor = cursor[match[1] ?? Number(match[2])];
  }
  return typeof cursor === "string" ? cursor : null;
}

export function overlayGeometry(source, slide) {
  if (!source) return null;
  const overrides = new Map((slide.boxOverrides ?? []).map((entry) => [entry.elementId, entry.box]));
  return {
    ...source,
    elements: source.elements.map((element) => {
      const text = element.evidence?.fieldPath
        ? payloadValue(slide, element.evidence.fieldPath) ?? element.text
        : element.text;
      return {
        ...element,
        text,
        lines: text === element.text ? element.lines : [text],
        box: overrides.get(element.id) ?? element.box,
      };
    }),
  };
}

function fieldPathFor(element) {
  const fieldPath = element.evidence?.fieldPath;
  if (typeof fieldPath !== "string" || fieldPath.length === 0) return null;
  return fieldPath === "title" ? "title" : `payload.${fieldPath}`;
}

function sameBox(left, right) {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

function applyBoxStyle(node, box) {
  node.style.left = `${box.x}px`;
  node.style.top = `${box.y}px`;
  node.style.width = `${box.width}px`;
  node.style.height = `${box.height}px`;
}

export function createSlidePlanCanvas(options) {
  const { canvas, onMove, onMoveMany, onEditText, onSelect } = options;
  const surface = document.createElement("div");
  surface.className = "slide-plan-canvas__surface";
  surface.setAttribute("role", "group");
  surface.setAttribute("aria-label", "슬라이드 요소");
  canvas.append(surface);

  let geometry = null;
  let selectedIds = new Set();
  let scale = 1;
  let drag = null;
  let marquee = null;

  const syncScale = () => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const viewport = fitCanvasViewport(width, height);
    scale = viewport.scale;
    surface.style.left = `${viewport.left}px`;
    surface.style.top = `${viewport.top}px`;
    surface.style.transform = `scale(${scale})`;
  };

  const attachHandles = (node) => {
    for (const name of HANDLE_NAMES) {
      const handle = document.createElement("span");
      handle.className = "slide-plan-canvas__handle";
      handle.dataset.resizeHandle = name;
      handle.setAttribute("aria-hidden", "true");
      node.append(handle);
    }
  };

  const syncSelection = () => {
    const single = selectedIds.size === 1;
    for (const node of surface.querySelectorAll("[data-geometry-element]")) {
      if (!(node instanceof HTMLElement)) continue;
      const selected = selectedIds.has(node.dataset.geometryElement);
      node.setAttribute("aria-selected", selected ? "true" : "false");
      for (const handle of [...node.querySelectorAll("[data-resize-handle]")]) handle.remove();
      if (selected && single) attachHandles(node);
    }
  };

  const paperPoint = (event) => {
    const bounds = surface.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left) / scale,
      y: (event.clientY - bounds.top) / scale,
    };
  };

  const emitMoves = (boxes) => {
    if (boxes.length === 0) return;
    if (boxes.length > 1 && typeof onMoveMany === "function") {
      onMoveMany(boxes);
      return;
    }
    onMove(boxes[0]);
  };

  const emitPrimary = () => {
    if (selectedIds.size !== 1) {
      emitSelect(null);
      return;
    }
    emitSelect(elementAt([...selectedIds][0]));
  };

  const selectedItems = () => [...selectedIds].flatMap((id) => {
    const element = elementAt(id);
    return element ? [{ id: element.id, box: { ...element.box } }] : [];
  });

  const applyGroup = (items) => {
    for (const item of items) {
      const element = elementAt(item.id);
      if (element) element.box = item.box;
      const node = surface.querySelector(`[data-geometry-element="${CSS.escape(item.id)}"]`);
      if (node instanceof HTMLElement) applyBoxStyle(node, item.box);
    }
  };

  const paintMarquee = (rect) => {
    if (!marquee) {
      marquee = document.createElement("div");
      marquee.className = "slide-plan-canvas__marquee";
      marquee.setAttribute("aria-hidden", "true");
      surface.append(marquee);
    }
    applyBoxStyle(marquee, rect);
  };

  const clearMarquee = () => {
    marquee?.remove();
    marquee = null;
  };

  const paint = () => {
    marquee = null;
    surface.replaceChildren();
    if (!geometry) return;
    for (const element of geometry.elements) {
      const node = document.createElement("button");
      node.type = "button";
      node.className = "slide-plan-canvas__el";
      node.dataset.geometryElement = element.id;
      applyBoxStyle(node, element.box);
      node.style.color = hex(element.resolvedTokens?.color);
      const size = element.resolvedTokens?.size;
      if (typeof size === "number") node.style.fontSize = `${size}px`;
      node.textContent = Array.isArray(element.lines) && element.lines.length > 0
        ? element.lines.join("\n")
        : element.text;
      surface.append(node);
      if (typeof size === "number") fitCanvasText(node, size);
    }
    syncSelection();
  };

  const elementAt = (id) => geometry?.elements.find((item) => item.id === id) ?? null;

  const emitSelect = (element) => {
    if (typeof onSelect !== "function") return;
    if (!element) {
      onSelect(null);
      return;
    }
    const path = fieldPathFor(element);
    onSelect(path === null ? null : {
      elementId: element.id,
      path,
      text: element.text,
      claimIds: element.evidence?.claimIds ?? [],
    });
  };

  const capturePointer = (target, pointerId) => {
    try {
      target.setPointerCapture(pointerId);
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== "InvalidStateError") throw error;
    }
  };

  const markNodes = (ids, key, value) => {
    for (const id of ids) {
      const node = surface.querySelector(`[data-geometry-element="${CSS.escape(id)}"]`);
      if (!(node instanceof HTMLElement)) continue;
      if (value) node.dataset[key] = "true";
      else delete node.dataset[key];
    }
  };

  surface.addEventListener("pointerdown", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target === surface || target === marquee) {
      if (!event.shiftKey) {
        selectedIds = new Set();
        emitSelect(null);
        syncSelection();
      }
      const origin = paperPoint(event);
      drag = { kind: "marquee", x: event.clientX, y: event.clientY, origin, current: origin, moved: false, shift: event.shiftKey };
      capturePointer(target, event.pointerId);
      event.preventDefault();
      return;
    }
    const handle = target.dataset.resizeHandle ?? null;
    const button = target.closest("[data-geometry-element]");
    if (!(button instanceof HTMLButtonElement)) return;
    if (button.isContentEditable) return;
    const id = button.dataset.geometryElement;
    const element = id === undefined ? null : elementAt(id);
    if (!element) return;
    const previous = [...selectedIds].sort().join("\0");
    if (handle) selectedIds = new Set([element.id]);
    else if (event.shiftKey) {
      if (selectedIds.has(element.id)) selectedIds.delete(element.id);
      else selectedIds.add(element.id);
    } else if (!selectedIds.has(element.id)) {
      selectedIds = new Set([element.id]);
    }
    emitPrimary();
    if (previous !== [...selectedIds].sort().join("\0")) syncSelection();
    drag = handle
      ? { kind: "resize", id: element.id, x: event.clientX, y: event.clientY, box: { ...element.box }, handle, moved: false }
      : { kind: "move", x: event.clientX, y: event.clientY, items: selectedItems(), moved: false };
    capturePointer(target, event.pointerId);
    if (handle) markNodes([element.id], "resizing", true);
    else markNodes(drag.items.map((item) => item.id), "dragging", true);
    if (!button.isContentEditable) button.focus();
    event.preventDefault();
  });

  surface.addEventListener("pointermove", (event) => {
    if (drag === null) return;
    const dx = (event.clientX - drag.x) / scale;
    const dy = (event.clientY - drag.y) / scale;
    if (drag.kind === "marquee") {
      drag.current = paperPoint(event);
      const rect = {
        x: Math.min(drag.origin.x, drag.current.x),
        y: Math.min(drag.origin.y, drag.current.y),
        width: Math.abs(drag.current.x - drag.origin.x),
        height: Math.abs(drag.current.y - drag.origin.y),
      };
      if (rect.width >= 2 || rect.height >= 2) drag.moved = true;
      paintMarquee(rect);
      return;
    }
    if (drag.kind === "resize") {
      const box = resizeBox(drag.box, drag.handle, dx, dy);
      if (!sameBox(box, drag.box)) drag.moved = true;
      const node = surface.querySelector(`[data-geometry-element="${CSS.escape(drag.id)}"]`);
      if (node instanceof HTMLElement) applyBoxStyle(node, box);
      return;
    }
    const next = translateBoxes(drag.items, dx, dy);
    if (next.some((item, index) => !sameBox(item.box, drag.items[index].box))) drag.moved = true;
    applyGroup(next);
  });

  const finishDrag = (event) => {
    if (drag === null) return;
    const origin = drag;
    drag = null;
    if (origin.kind === "marquee") {
      clearMarquee();
      const current = paperPoint(event);
      const ids = geometry
        ? idsIntersectingRect(geometry.elements, {
          x: Math.min(origin.origin.x, current.x),
          y: Math.min(origin.origin.y, current.y),
          width: Math.abs(current.x - origin.origin.x),
          height: Math.abs(current.y - origin.origin.y),
        })
        : [];
      if (origin.shift) for (const id of ids) selectedIds.add(id);
      else selectedIds = new Set(ids);
      syncSelection();
      emitPrimary();
      return;
    }
    markNodes(
      origin.kind === "resize" ? [origin.id] : origin.items.map((item) => item.id),
      origin.kind === "resize" ? "resizing" : "dragging",
      false,
    );
    if (!origin.moved) return;
    const dx = (event.clientX - origin.x) / scale;
    const dy = (event.clientY - origin.y) / scale;
    if (origin.kind === "resize") {
      const box = resizeBox(origin.box, origin.handle, dx, dy);
      const element = elementAt(origin.id);
      if (element) element.box = box;
      emitMoves([{ elementId: origin.id, box }]);
      return;
    }
    const next = translateBoxes(origin.items, dx, dy);
    applyGroup(next);
    emitMoves(next.map((item) => ({ elementId: item.id, box: item.box })));
  };

  surface.addEventListener("pointerup", finishDrag);
  surface.addEventListener("pointercancel", finishDrag);

  surface.addEventListener("dblclick", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.dataset.resizeHandle) return;
    const button = target instanceof HTMLButtonElement ? target : target.closest("[data-geometry-element]");
    if (!(button instanceof HTMLButtonElement)) return;
    if (button.isContentEditable) return;
    const id = button.dataset.geometryElement;
    const element = id === undefined ? null : elementAt(id);
    const path = element === null ? null : fieldPathFor(element);
    if (element === null || path === null) return;
    for (const handle of [...button.querySelectorAll("[data-resize-handle]")]) handle.remove();
    const editor = document.createElement("textarea");
    editor.className = button.className;
    editor.style.cssText = button.style.cssText;
    editor.style.resize = "none";
    editor.style.cursor = "text";
    editor.dataset.geometryElement = element.id;
    editor.dataset.geometryEditor = "";
    editor.setAttribute("aria-label", button.getAttribute("aria-label") ?? element.text);
    editor.value = element.text;
    button.replaceWith(editor);
    editor.focus();
    editor.select();
    const onKeyDown = (keyEvent) => {
      if (keyEvent.key === "Enter" && !keyEvent.shiftKey && !keyEvent.isComposing) {
        keyEvent.preventDefault();
        editor.blur();
      }
    };
    const commit = () => {
      editor.removeEventListener("keydown", onKeyDown);
      const text = editor.value;
      editor.replaceWith(button);
      onEditText({
        elementId: element.id,
        path,
        text,
        claimIds: element.evidence?.claimIds ?? [],
      });
    };
    editor.addEventListener("blur", commit, { once: true });
    editor.addEventListener("keydown", onKeyDown);
  });

  surface.addEventListener("keydown", (event) => {
    if (drag !== null || selectedIds.size === 0) return;
    if (event.target instanceof HTMLElement &&
        (event.target.isContentEditable || event.target.matches("input, textarea, select"))) return;
    const step = event.shiftKey ? 8 : 1;
    const delta = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }[event.key];
    if (!delta) return;
    const items = selectedItems();
    if (items.length === 0) return;
    const next = translateBoxes(items, delta[0], delta[1]);
    if (next.every((item, index) => sameBox(item.box, items[index].box))) return;
    event.preventDefault();
    event.stopPropagation();
    applyGroup(next);
    emitMoves(next.map((item) => ({ elementId: item.id, box: item.box })));
  });

  const observer = new ResizeObserver(() => syncScale());
  observer.observe(canvas);

  return {
    setGeometry(next) {
      geometry = next === null || next === undefined
        ? null
        : {
          slideId: next.slideId,
          elements: next.elements.map((element) => ({
            ...element,
            box: { ...element.box },
            lines: [...(element.lines ?? [])],
            evidence: element.evidence === null || element.evidence === undefined
              ? null
              : { fieldPath: element.evidence.fieldPath, claimIds: [...element.evidence.claimIds] },
            resolvedTokens: { ...element.resolvedTokens },
          })),
        };
      canvas.hidden = geometry === null;
      selectedIds = new Set([...selectedIds].filter((id) => geometry?.elements.some((element) => element.id === id)));
      paint();
      syncScale();
      emitPrimary();
    },
    applyOverride(elementId, box) {
      const element = elementAt(elementId);
      if (!element) return;
      element.box = clampBox(box);
      paint();
    },
    destroy() {
      observer.disconnect();
      surface.remove();
    },
  };
}
