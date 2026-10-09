/** Internal page instrumentation. No handlers/business state are invoked. */
export function pointerGuardScript(token: string, clockSelectors: string[]): string {
  return `(() => {
    const key = '__cdpCliPointerGuard';
    globalThis[key]?.dispose?.();
    const observers = [], listeners = [];
    const guard = { token: ${JSON.stringify(token)}, changed: false, unsupported: false, dispose() {
      observers.forEach(o => o.disconnect()); listeners.forEach(([w,f]) => w.removeEventListener('scroll',f,true));
    } };
    Object.defineProperty(globalThis, key, { configurable: true, value: guard });
    const clocks = ${JSON.stringify(clockSelectors)};
    function watch(doc) {
      const observer = new doc.defaultView.MutationObserver(records => {
        if (records.some(r => {
          const el = r.target.nodeType === 3 ? r.target.parentElement : r.target;
          const clock = r.type !== 'attributes' && el?.matches?.(clocks.join(',') || ':not(*)') &&
            [...r.addedNodes, ...r.removedNodes].every(n => n.nodeType === 3);
          return !clock;
        })) guard.changed = true;
      });
      observer.observe(doc.documentElement, { subtree:true, childList:true, characterData:true, attributes:true }); observers.push(observer);
      const moved = () => { guard.changed = true; }; doc.defaultView.addEventListener('scroll',moved,true); listeners.push([doc.defaultView,moved]);
      for (const el of doc.querySelectorAll('*')) {
        if (el.shadowRoot) { observer.observe(el.shadowRoot,{subtree:true,childList:true,characterData:true,attributes:true}); }
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

export function pointerGuardCheck(token: string): string {
  return `(() => { const g = globalThis.__cdpCliPointerGuard; return !!g && g.token === ${JSON.stringify(token)} && !g.changed && !g.unsupported &&
    JSON.stringify(g.viewport) === JSON.stringify([innerWidth,innerHeight,devicePixelRatio,scrollX,scrollY,visualViewport?.scale,visualViewport?.offsetLeft,visualViewport?.offsetTop]); })()`;
}
