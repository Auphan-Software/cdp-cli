// @ts-nocheck
/** A self-contained browser expression. The host replaces only the serialized options. */
export function captureExpression(options: { frame?: string; ignore: string[]; maxElements: number }): string {
  return `(${capturePage.toString()})(${JSON.stringify(options)})`;
}

// Runs in Chrome, not Node. Keep this plain JS and use local declarations so the
// serialized function has no references to module scope.
function capturePage(options: any): any {
  for (const selector of options.ignore) {
    try { document.querySelector(selector); }
    catch { throw new Error(`STATE_INVALID_IGNORE_SELECTOR: ${selector}`); }
  }
  const hash = (text: string) => {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return (h >>> 0).toString(16).padStart(8, '0');
  };
  const clean = (text: unknown) => String(text ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  const shorten = (text: string) => text.length <= 120 ? text : `${text.slice(0, 120)}…#${hash(text)}`;
  const stableId = (value: string) => !!value &&
    !/\d{4,}|[0-9a-f]{8,}|^(ember|react|radix|mui|headlessui|ext-gen|jquery|mat-|cdk-)|^:.*:$|^«.*»$|-\d+$/i.test(value);
  const ignored = (el: any) => options.ignore.some((selector: string) => !!el.closest(selector)) ||
    !!el.closest('[data-cdp-ignore]');
  const visible = (el: any) => {
    if (el.hidden || el.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const path = (el: any) => {
    const parts: string[] = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 6) {
      const tag = cur.tagName.toLowerCase();
      if (stableId(cur.id)) {
        parts.unshift(`id:${cur.id}`);
        break;
      }
      const parent = cur.parentElement;
      const siblings = parent ? Array.from(parent.children).filter((x: any) => x.tagName === cur.tagName) : [];
      parts.unshift(`${tag}:${siblings.length > 1 ? siblings.indexOf(cur) + 1 : 1}`);
      cur = parent;
    }
    return parts.join('>');
  };
  const roleOf = (el: any) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (el.hasAttribute('contenteditable') && el.getAttribute('contenteditable') !== 'false') return 'textbox';
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
      return 'textbox';
    }
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return tag;
  };
  const nameOf = (el: any) => {
    const labelledby = el.getAttribute('aria-labelledby');
    const labelled = labelledby ? labelledby.split(/\s+/).map((id: string) => el.ownerDocument.getElementById(id)?.textContent || '').join(' ') : '';
    const label = el.labels?.length ? Array.from(el.labels).map((x: any) => x.textContent || '').join(' ') : '';
    const editable = el.hasAttribute('contenteditable') && el.getAttribute('contenteditable') !== 'false';
    const typed = editable || el.getAttribute('role') === 'textbox' || ['input', 'textarea'].includes(el.tagName.toLowerCase());
    const buttonValue = el.tagName.toLowerCase() === 'input' && /^(button|submit|reset)$/i.test(el.type || '') ? el.value : '';
    return shorten(clean(el.getAttribute('aria-label') || labelled || label || el.getAttribute('title') ||
      el.getAttribute('placeholder') || buttonValue || (typed ? '' : el.innerText || el.textContent || '')));
  };
  const result: any[] = [];
  const unreachableFrames: string[] = [];
  let nodeCount = 0;
  let truncated = false;
  const candidates: any[] = [];
  const walk = (doc: any, fp: string) => {
    const all = doc.querySelectorAll('*');
    nodeCount += all.length;
    for (const el of all) {
      if (candidates.length >= options.maxElements) { truncated = true; break; }
      if (ignored(el)) continue;
      const tag = el.tagName.toLowerCase();
      const editableRegion = !!el.isContentEditable || !!el.closest('[contenteditable]:not([contenteditable="false"]),[role="textbox"]');
      if (el.shadowRoot) walk(el.shadowRoot, `${fp}/shadow:${path(el)}`);
      if (tag === 'iframe') {
        const childFp = `${fp}/frame:${path(el)}`;
        try {
          if (el.contentDocument?.documentElement) walk(el.contentDocument, childFp);
          else unreachableFrames.push(childFp);
        } catch { unreachableFrames.push(childFp); }
      }
      const explicitRole = el.getAttribute('role');
      const interactive = /^(button|input|select|textarea|a|summary|option)$/.test(tag) ||
        (el.hasAttribute('contenteditable') && el.getAttribute('contenteditable') !== 'false') ||
        !!el.getAttribute('onclick') || !!el.getAttribute('tabindex') ||
        ['aria-expanded', 'aria-checked', 'aria-selected', 'aria-pressed', 'aria-current', 'aria-valuenow'].some((attr) => el.hasAttribute(attr)) ||
        /^(button|link|tab|menuitem|option|switch|combobox|textbox|checkbox|radio)$/.test(explicitRole || '');
      const semantic = /^h[1-6]$/.test(tag) || /^(dialog|details)$/.test(tag) ||
        /^(alert|status|dialog|alertdialog|heading)$/.test(explicitRole || '');
      const directText = Array.from(el.childNodes).filter((n: any) => n.nodeType === 3).map((n: any) => n.textContent || '').join(' ');
      const textRegion = !editableRegion && /^(p|td|th|li|label|span|div|strong|b)$/.test(tag) && clean(directText).length > 0;
      if (!interactive && !semantic && !textRegion) continue;
      const role = textRegion && !interactive && !semantic ? 'text' : roleOf(el);
      const name = interactive || semantic ? nameOf(el) : undefined;
      const vis = visible(el);
      const state: Record<string, boolean | string> = { vis };
      if ('open' in el) state.open = !!el.open;
      if (interactive) {
        state.en = !el.disabled && el.getAttribute('aria-disabled') !== 'true';
        for (const [attr, key] of [['aria-expanded', 'expanded'], ['aria-selected', 'selected'], ['aria-checked', 'ariaChecked'],
          ['aria-pressed', 'pressed'], ['aria-invalid', 'invalid'], ['aria-busy', 'busy']]) {
          const value = el.getAttribute(attr);
          if (value === 'true' || value === 'false') state[key] = value === 'true';
        }
        if ('checked' in el) state.checked = !!el.checked;
        if ('indeterminate' in el) state.indeterminate = !!el.indeterminate;
        if (tag === 'option') state.selected = !!el.selected;
        for (const [attr, key] of [['aria-current', 'current'], ['aria-valuenow', 'valueNow']]) {
          const value = el.getAttribute(attr);
          if (value !== null) state[key] = value;
        }
        if ('readOnly' in el) state.readonly = !!el.readOnly;
        if ('required' in el) state.required = !!el.required;
      }
      let candidate: string;
      const testId = el.getAttribute('data-cdp-key') || el.getAttribute('data-testid') || el.getAttribute('data-qa');
      if (testId) candidate = `testid:${testId}`;
      else if (stableId(el.id)) candidate = `id:${el.id}`;
      else if (interactive && el.getAttribute('name')) {
        const type = (el.type || '').toLowerCase();
        candidate = type === 'radio' || type === 'checkbox'
          ? `name:${el.getAttribute('name')}>${type}:${el.getAttribute('value') || path(el)}`
          : `name:${el.getAttribute('name')}`;
      }
      else candidate = `path:${path(el)}`;
      const parentRow = el.closest('[data-row-key],[data-key],[data-id],tr[id],li[id]');
      const rowKey = parentRow && parentRow !== el ? (parentRow.getAttribute('data-row-key') ||
        parentRow.getAttribute('data-key') || parentRow.getAttribute('data-id') ||
        (stableId(parentRow.id) ? parentRow.id : null)) : null;
      if (rowKey) candidate = `row:${rowKey}>${candidate}`;
      const rect = el.getBoundingClientRect();
      const box = [rect.x, rect.y, rect.width, rect.height].map((n: number) => Math.round(n / 4) * 4);
      const text = textRegion && !interactive && vis ? shorten(clean(directText)) : undefined;
      const editable = (el.hasAttribute('contenteditable') && el.getAttribute('contenteditable') !== 'false') ||
        el.getAttribute('role') === 'textbox';
      const rawValue = editable ? String(el.innerText || '') : interactive &&
        !/^(checkbox|radio|submit|button|reset|file|hidden)$/i.test(el.type || '') && 'value' in el ? String(el.value) : undefined;
      candidates.push({ fp, candidate, role, name, text, rawValue,
        state, box, path: path(el) });
    }
  };
  let root = document;
  if (options.frame && options.frame !== '0') {
    const frame = /^\d+$/.test(options.frame) ? document.querySelectorAll('iframe')[Number(options.frame) - 1] : document.querySelector(options.frame);
    if (!frame || frame.tagName.toLowerCase() !== 'iframe') throw new Error(`FRAME_NOT_FOUND: ${options.frame}`);
    try { root = frame.contentDocument; } catch { root = null; }
    if (!root) unreachableFrames.push(`frame:${options.frame}`);
  }
  if (root) walk(root, options.frame && options.frame !== '0' ? `frame:${options.frame}` : 'top');
  const counts = new Map<string, number>();
  for (const item of candidates) counts.set(`${item.fp}|${item.candidate}`, (counts.get(`${item.fp}|${item.candidate}`) || 0) + 1);
  for (const item of candidates) {
    const duplicate = (counts.get(`${item.fp}|${item.candidate}`) || 0) > 1;
    result.push({ k: `${item.fp}|${item.candidate}${duplicate ? `>${item.path}` : ''}`,
      kq: duplicate ? 'ambiguous' : item.candidate.includes('path:') ? 'weak' : 'strong',
      role: item.role, ...(item.name ? { name: item.name } : {}), ...(item.text ? { text: item.text } : {}),
      ...(item.rawValue !== undefined ? { rawValue: item.rawValue } : {}), state: item.state, box: item.box });
  }
  const visibleText: string[] = [];
  const collectVisibleText = (container: any) => {
    const walker = container.ownerDocument.createTreeWalker(container, 4);
    let textNode;
    while ((textNode = walker.nextNode())) {
      const parent = textNode.parentElement;
      if (parent && !/^(SCRIPT|STYLE|NOSCRIPT)$/.test(parent.tagName) && !ignored(parent) && visible(parent)) {
        visibleText.push(textNode.nodeValue || '');
      }
    }
    for (const el of container.querySelectorAll('*')) {
      if (ignored(el)) continue;
      if (el.shadowRoot) collectVisibleText(el.shadowRoot);
      if (el.tagName.toLowerCase() === 'iframe') {
        try { if (el.contentDocument?.body) collectVisibleText(el.contentDocument.body); } catch { /* coverage recorded by walk */ }
      }
    }
  };
  if (root?.body) collectVisibleText(root.body);
  const bodyText = clean(visibleText.join(' '));
  return { url: root?.defaultView?.location?.href ?? location.href, title: document.title, readyState: document.readyState,
    bodyTextHash: hash(bodyText), nodeCount, elements: result, coverage: { truncated, unreachableFrames, blockedByDialog: false,
      ambiguousKeys: result.filter((item: any) => item.kq === 'ambiguous').map((item: any) => item.k) } };
}
