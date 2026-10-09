/** Internal page instrumentation. No handlers/business state are invoked. */
export function pointerGuardScript(token: string, clockSelectors: string[]): string {
  return `(() => {
    const key = '__cdpCliPointerGuard';
    globalThis[key]?.dispose?.();
    const observers = [], listeners = [], boxes = new Map(), styles = new WeakMap(), pseudos = new WeakMap();
    const guard = { token: ${JSON.stringify(token)}, changed: false, unsupported: false, regions: [], dispose() {
      observers.forEach(o => o.disconnect()); listeners.forEach(([w,f]) => w.removeEventListener('scroll',f,true));
    } };
    Object.defineProperty(globalThis, key, { configurable: true, value: guard });
    const clocks = ${JSON.stringify(clockSelectors)};
    function box(node) {
      const el = node?.nodeType === 3 ? node.parentElement : node;
      if (!el?.getBoundingClientRect) return null;
      const r = el.getBoundingClientRect(); let x = r.left, y = r.top, win = el.ownerDocument.defaultView;
      while (win !== top) { const f = win.frameElement, p = f.getBoundingClientRect(); x += p.left + f.clientLeft; y += p.top + f.clientTop; win = f.ownerDocument.defaultView; }
      return [x,y,r.width,r.height];
    }
    const contains = (r,x,y) => !!r && x >= r[0] && y >= r[1] && x < r[0]+r[2] && y < r[1]+r[3];
    function hitStyle(el, pseudo) { const s = el.ownerDocument.defaultView.getComputedStyle(el,pseudo); return Array.from(s, p => [p,s.getPropertyValue(p)]); }
    function pseudoStyle(el) { return ['::before','::after'].map(p => { const s = el.ownerDocument.defaultView.getComputedStyle(el,p); return s.content === 'none' || s.content === 'normal' ? null : hitStyle(el,p); }); }
    guard.check = (x,y) => {
      if (guard.regions.some(r => contains(r,x,y))) return false;
      // Retain competing source surfaces too: stylesheet/CSSOM changes can expose
      // a previously covered target without changing that target's own box/style.
      for (const [node, prior] of boxes) {
        const current = box(node);
        if (JSON.stringify(pseudos.get(node)) !== JSON.stringify(pseudoStyle(node))) return false;
        if ((contains(prior,x,y) || contains(current,x,y)) &&
          (JSON.stringify(prior) !== JSON.stringify(current) ||
           JSON.stringify(styles.get(node)) !== JSON.stringify(hitStyle(node)) ||
           node.getAnimations().some(a => a.playState === 'running' || a.pending))) return false;
      }
      let doc = document, px = x, py = y, el;
      for (let depth=0; depth<16; depth++) {
        el = doc.elementFromPoint(px,py); if (!el) return false;
        while (el.shadowRoot) { const next = el.shadowRoot.elementFromPoint(px,py); if (!next || next === el) break; el = next; }
        if (el.tagName !== 'IFRAME' && el.tagName !== 'FRAME') break;
        const r = el.getBoundingClientRect(); px -= r.left + el.clientLeft; py -= r.top + el.clientTop;
        doc = el.contentDocument; if (!doc) return false;
      }
      const prior = boxes.get(el), current = box(el);
      if (!contains(prior,x,y) || JSON.stringify(prior) !== JSON.stringify(current) || el.closest('canvas,video')) return false;
      for (let node = el; node; node = node.parentElement || node.getRootNode()?.host) {
        if (JSON.stringify(styles.get(node)) !== JSON.stringify(hitStyle(node))) return false;
      }
      return true;
    };
    function watch(doc) {
      const observer = new doc.defaultView.MutationObserver(records => {
        for (const r of records) {
          const el = r.target.nodeType === 3 ? r.target.parentElement : r.target;
          const clock = r.type !== 'attributes' && el?.matches?.(clocks.join(',') || ':not(*)') &&
            [...r.addedNodes, ...r.removedNodes].every(n => n.nodeType === 3);
          if (clock) continue;
          const nodes = r.type === 'childList' ? [...r.addedNodes,...r.removedNodes] : [el];
          for (const node of nodes) {
            const target = node.nodeType === 3 ? el : node;
            for (const rect of [boxes.get(target),box(target)]) if (rect && rect[2] > 0 && rect[3] > 0) guard.regions.push(rect);
          }
          if (guard.regions.length > 512) guard.changed = true;
        }
      });
      observer.observe(doc.documentElement, { subtree:true, childList:true, characterData:true, attributes:true }); observers.push(observer);
      const moved = () => { guard.changed = true; }; doc.defaultView.addEventListener('scroll',moved,true); listeners.push([doc.defaultView,moved]);
      for (const el of doc.querySelectorAll('*')) {
        boxes.set(el,box(el));
        styles.set(el,hitStyle(el));
        pseudos.set(el,pseudoStyle(el));
        if (el.shadowRoot) { observer.observe(el.shadowRoot,{subtree:true,childList:true,characterData:true,attributes:true});
          for (const child of el.shadowRoot.querySelectorAll('*')) { boxes.set(child,box(child)); styles.set(child,hitStyle(child)); pseudos.set(child,pseudoStyle(child)); if (child.shadowRoot) guard.unsupported = true; } }
        if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
          try { if (!el.contentDocument) guard.unsupported = true; else watch(el.contentDocument); } catch { guard.unsupported = true; }
        }
      }
    }
    watch(document);
    guard.viewport = [innerWidth, innerHeight, devicePixelRatio, scrollX, scrollY, visualViewport?.scale, visualViewport?.offsetLeft, visualViewport?.offsetTop];
    return { token:guard.token, supported:!guard.unsupported };
  })()`;
}

export function pointerGuardCheck(token: string, x: number, y: number): string {
  return `(() => { const g = globalThis.__cdpCliPointerGuard; return !!g && g.token === ${JSON.stringify(token)} && !g.changed && !g.unsupported &&
    g.check(${x},${y}) && JSON.stringify(g.viewport) === JSON.stringify([innerWidth,innerHeight,devicePixelRatio,scrollX,scrollY,visualViewport?.scale,visualViewport?.offsetLeft,visualViewport?.offsetTop]); })()`;
}
