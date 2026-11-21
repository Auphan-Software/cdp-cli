/**
 * The step file of `video replay`: the Jarvis browser-video format, JSON
 * `{"steps": [...]}` or a bare list. Each step has `do` and the keys below; any
 * step may add `caption` (shown from that step on) and `timeout` (seconds to
 * find an element, default 5).
 *
 *   goto {url} | click {selector|text} | type {selector, value} | press {key}
 *   wait {selector|text [gone] | selector+value | ms} | caption {text}
 *   assert-visible {selector|text}
 *   scroll {selector, x?, y?}                     scroll a container by a delta in CSS px
 *   swipe {from?, to?|direction+distance, selector?} touch drag: from/to are [x, y] viewport points
 *   select {selector, value}                      set a native <select>, fires input and change
 *   upload {selector, files}                      local file path(s) into an <input type=file>
 */

export interface VideoStep {
  do: 'goto' | 'click' | 'type' | 'press' | 'wait' | 'caption' | 'assert-visible' | 'scroll' | 'swipe' | 'select' | 'upload';
  url?: string; selector?: string; text?: string; value?: string; key?: string;
  ms?: number; gone?: boolean; caption?: string; timeout?: number;
  x?: number; y?: number; from?: [number, number]; to?: [number, number];
  direction?: SwipeDirection; distance?: number; files?: string[];
}

import { CAPTION_POSITIONS, type CaptionPosition } from './overlay.js';

export type SwipeDirection = 'up' | 'down' | 'left' | 'right';

export interface StepFile { name?: string; pointer?: [number, number]; glideMs?: number; captionPosition?: CaptionPosition; steps: VideoStep[] }

const MAX_STEPS = 200;
const KEYS: Record<VideoStep['do'], string[]> = {
  goto: ['url'], click: ['selector', 'text'], type: ['selector', 'value'], press: ['key'],
  wait: ['selector', 'text', 'gone', 'value', 'ms'], caption: ['text'], 'assert-visible': ['selector', 'text'],
  scroll: ['selector', 'x', 'y'], swipe: ['selector', 'from', 'to', 'direction', 'distance'],
  select: ['selector', 'value'], upload: ['selector', 'files']
};
const DIRECTIONS: SwipeDirection[] = ['up', 'down', 'left', 'right'];
const MAX_FILES = 20;
const MAX_DELTA = 100_000;

const isStr = (v: unknown): boolean => typeof v === 'string' && v.length > 0;
const isPoint = (v: unknown): boolean => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);

/** The reason a scroll, swipe, select or upload step is malformed, or undefined when it is fine. */
function newStepProblem(step: any): string | undefined {
  switch (step.do as VideoStep['do']) {
    case 'scroll': {
      if (!isStr(step.selector)) return 'needs selector (the scrollable container) and x and/or y';
      const given = ['x', 'y'].filter((k) => step[k] !== undefined);
      if (!given.length) return 'needs selector (the scrollable container) and x and/or y';
      if (given.some((k) => !(typeof step[k] === 'number' && Math.abs(step[k]) <= MAX_DELTA))) return `x and y are numbers of CSS px, at most ${MAX_DELTA} either way`;
      return step.x === 0 && (step.y ?? 0) === 0 || step.y === 0 && (step.x ?? 0) === 0 ? 'x and y must not both be 0' : undefined;
    }
    case 'swipe': {
      const hasPath = step.to !== undefined;
      const hasDir = step.direction !== undefined || step.distance !== undefined;
      if (hasPath === hasDir) return 'needs from/to (or selector and to) or direction and distance, not both';
      if (step.from !== undefined && !isPoint(step.from)) return 'from must be [x, y] in CSS px, not negative';
      if (hasPath) {
        if (!isPoint(step.to)) return 'to must be [x, y] in CSS px, not negative';
        if (step.from === undefined && !isStr(step.selector)) return 'to needs a start: from [x, y] or selector';
        return undefined;
      }
      if (!DIRECTIONS.includes(step.direction)) return `direction is one of ${DIRECTIONS.join(', ')}`;
      return typeof step.distance === 'number' && step.distance > 0 && step.distance <= 5000 ? undefined : 'distance is a number of CSS px above 0, at most 5000';
    }
    case 'select':
      return isStr(step.selector) && typeof step.value === 'string' ? undefined : 'needs selector and value';
    case 'upload': {
      const files = typeof step.files === 'string' ? [step.files] : step.files;
      if (!isStr(step.selector) || !Array.isArray(files) || !files.length || !files.every(isStr)) return 'needs selector and files (a path or a list of paths)';
      return files.length > MAX_FILES ? `at most ${MAX_FILES} files` : undefined;
    }
    default: return undefined;
  }
}

export function parseSteps(text: string): StepFile {
  const doc = JSON.parse(text);
  const raw = Array.isArray(doc) ? { steps: doc } : doc;
  if (!raw || !Array.isArray(raw.steps) || !raw.steps.length) throw new Error('step file has no steps');
  if (raw.steps.length > MAX_STEPS) throw new Error(`step file exceeds ${MAX_STEPS} steps`);
  const str = (v: unknown): boolean => typeof v === 'string' && v.length > 0;
  raw.steps.forEach((step: any, i: number) => {
    const where = `step ${i + 1}`;
    if (!step || typeof step !== 'object' || !(step.do in KEYS)) throw new Error(`${where}: unknown do ${JSON.stringify(step?.do)}`);
    const allowed = new Set([...KEYS[step.do as VideoStep['do']], 'do', 'caption', 'timeout']);
    const extra = Object.keys(step).find((k) => !allowed.has(k));
    if (extra) throw new Error(`${where} (${step.do}): unknown key ${extra}`);
    const problem = newStepProblem(step);
    if (problem) throw new Error(`${where} (${step.do}): ${problem}`);
    if (step.do === 'upload' && typeof step.files === 'string') step.files = [step.files];
    if (step.do === 'scroll' || step.do === 'swipe' || step.do === 'select' || step.do === 'upload') {
      if (step.timeout !== undefined && !(typeof step.timeout === 'number' && step.timeout > 0 && step.timeout <= 120)) throw new Error(`${where}: timeout must be 0-120 seconds`);
      return;
    }
    const target = str(step.selector) !== str(step.text);
    const ok = step.do === 'goto' ? str(step.url)
      : step.do === 'click' || step.do === 'assert-visible' ? target
        : step.do === 'type' ? str(step.selector) && typeof step.value === 'string'
          : step.do === 'press' ? str(step.key)
            : step.do === 'caption' ? typeof step.text === 'string'
              : typeof step.ms === 'number' ? step.ms >= 0 && step.ms <= 60_000 && !step.selector && !step.text
                : step.value !== undefined ? str(step.selector) && typeof step.value === 'string' && !step.gone && !step.text
                  : target;
    if (!ok) throw new Error(`${where} (${step.do}): needs ${step.do === 'type' ? 'selector and value' : KEYS[step.do as VideoStep['do']].join(' or ')}`);
    if (step.timeout !== undefined && !(typeof step.timeout === 'number' && step.timeout > 0 && step.timeout <= 120)) {
      throw new Error(`${where}: timeout must be 0-120 seconds`);
    }
  });
  const pointer = Array.isArray(raw.pointer) && raw.pointer.length === 2 && raw.pointer.every(Number.isFinite)
    ? raw.pointer as [number, number] : undefined;
  if (raw.caption_position !== undefined && !CAPTION_POSITIONS.includes(raw.caption_position)) {
    throw new Error(`caption_position must be one of ${CAPTION_POSITIONS.join(', ')}`);
  }
  const glideMs = typeof raw.glide_ms === 'number' && raw.glide_ms >= 0 ? raw.glide_ms : undefined;
  return { ...(typeof raw.name === 'string' ? { name: raw.name } : {}), ...(pointer ? { pointer } : {}),
    ...(glideMs !== undefined ? { glideMs } : {}), ...(raw.caption_position ? { captionPosition: raw.caption_position as CaptionPosition } : {}), steps: raw.steps as VideoStep[] };
}

/** `click "Save"`, the label a failure names its step by. */
export function describeStep(step: VideoStep): string {
  const target = step.url ?? step.selector ?? step.text ?? step.key ?? (step.do === 'swipe' ? step.direction : undefined) ?? (step.ms !== undefined ? `${step.ms}ms` : '');
  return target ? `${step.do} ${JSON.stringify(target)}` : step.do;
}

/** The cdp-cli command a step runs as a child, after the pointer is placed; undefined when the recorder handles it. */
export function childArgs(step: VideoStep, pageId: string, point?: [number, number]): string[] | undefined {
  switch (step.do) {
    case 'goto': return ['navigate', step.url as string, pageId];
    case 'click': return ['click', pageId, '--x', String(Math.round(point![0])), '--y', String(Math.round(point![1]))];
    case 'type': return ['fill', step.selector as string, step.value as string, pageId];
    case 'press': return ['press-key', step.key as string, pageId];
    default: return undefined;
  }
}

/**
 * Page expression for an actionable target: {x, y} at its centre once it is
 * attached, visible, inside the viewport (scrolled into view otherwise), enabled,
 * stable over two animation frames and receives events at its centre;
 * otherwise {wait: reason}. Text prefers an exact match on an interactive element.
 */
export function locateExpression(step: Pick<VideoStep, 'selector' | 'text'>): string {
  return `((sel,text)=>{const norm=s=>(s||'').replace(/\\s+/g,' ').trim();
 const vis=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'};
 let el; if(sel) el=document.querySelector(sel); else {
  const all=[...document.querySelectorAll('body *')].filter(e=>!e.closest('#__bv')&&(norm(e.innerText)===text||norm(e.getAttribute('aria-label'))===text||(e.matches('input[type=button],input[type=submit]')&&norm(e.value)===text)));
  const act=all.filter(e=>e.matches('a,button,input,select,textarea,summary,label,[role=button],[role=link],[role=tab],[role=menuitem],[onclick]')).filter(vis);
  const pool=act.length?act:all.filter(vis); el=pool.find(e=>!pool.some(o=>o!==e&&e.contains(o))); }
 if(!el) return {wait:'not found'}; if(!vis(el)) return {wait:'not visible'};
 const r=el.getBoundingClientRect(); if(r.left+r.width/2<0||r.top+r.height/2<0||r.left+r.width/2>=innerWidth||r.top+r.height/2>=innerHeight){el.scrollIntoView({block:'center',inline:'center'});return {wait:'scrolling into view'}}
 if(el.disabled||el.closest('[aria-disabled="true"],[inert]')) return {wait:'disabled'};
 const x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);
 if(!hit||!(hit===el||el.contains(hit))) return {wait:'covered by '+(hit?hit.tagName.toLowerCase()+(hit.id?'#'+hit.id:''):'nothing')};
 return new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(()=>{const q=el.getBoundingClientRect();ok(Math.abs(q.left-r.left)<1&&Math.abs(q.top-r.top)<1?{x,y}:{wait:'moving'})})));
})(${JSON.stringify(step.selector ?? null)},${JSON.stringify(step.text ?? null)})`;
}

/** Page expression that is true once a wait or assert-visible step is satisfied. */
export function conditionExpression(step: VideoStep): string {
  const sel = JSON.stringify(step.selector ?? null);
  if (step.value !== undefined) return `(document.querySelector(${sel})||{}).value===${JSON.stringify(step.value)}`;
  const shown = step.selector
    ? `(()=>{const e=document.querySelector(${sel});return !!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden'})()`
    : `!!document.body&&document.body.innerText.includes(${JSON.stringify(step.text ?? '')})`;
  return step.gone ? `!${shown}` : shown;
}

/**
 * Page expression for a scroll step: eases the container by (x, y) over about 400 ms so the video shows it,
 * then answers {moved: [dx, dy]}; {wait} while the container is missing; {fail} when it cannot scroll that way.
 */
export function scrollExpression(step: Pick<VideoStep, 'selector' | 'x' | 'y'>): string {
  return `((sel,dx,dy)=>{const el=document.querySelector(sel); if(!el) return {wait:'not found'};
 if(el.getClientRects().length===0) return {wait:'not visible'};
 const x0=el.scrollLeft,y0=el.scrollTop,t0=performance.now(),D=400;
 return new Promise(done=>{const tick=now=>{const k=Math.min(1,(now-t0)/D),e=k<.5?2*k*k:1-Math.pow(-2*k+2,2)/2;
  el.scrollLeft=x0+dx*e; el.scrollTop=y0+dy*e;
  if(k<1) return requestAnimationFrame(tick);
  const mx=el.scrollLeft-x0,my=el.scrollTop-y0;
  done(Math.abs(mx)<1&&Math.abs(my)<1?{fail:'did not move: not scrollable that way, or already at its end'}:{moved:[Math.round(mx),Math.round(my)]})};
  requestAnimationFrame(tick)})})(${JSON.stringify(step.selector)},${step.x ?? 0},${step.y ?? 0})`;
}

/** Page expression for a select step: sets the value and fires input and change; {wait} or {fail: reason} otherwise. */
export function selectExpression(step: Pick<VideoStep, 'selector' | 'value'>): string {
  return `((sel,val)=>{const el=document.querySelector(sel); if(!el) return {wait:'not found'};
 if(el.tagName!=='SELECT') return {fail:'is a '+el.tagName.toLowerCase()+', not a select'};
 if(el.disabled) return {wait:'disabled'};
 const o=[...el.options].find(o=>o.value===val); if(!o) return {fail:'has no option with value '+JSON.stringify(val)+' (options: '+[...el.options].map(o=>JSON.stringify(o.value)).join(', ')+')'};
 if(o.disabled) return {fail:'option '+JSON.stringify(val)+' is disabled'};
 el.scrollIntoView({block:'center',inline:'center'}); el.value=val;
 el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
 return {selected:el.value}})(${JSON.stringify(step.selector)},${JSON.stringify(step.value)})`;
}

/** Page expression that is a reason string when the element cannot take the files, else null (checked before DOM.setFileInputFiles). */
export function fileInputProblemExpression(selector: string, count: number): string {
  return `((sel,n)=>{const el=document.querySelector(sel); if(!el) return 'not found';
 if(el.tagName!=='INPUT'||el.type!=='file') return 'is not an <input type=file>';
 if(el.disabled) return 'is disabled'; if(n>1&&!el.multiple) return 'takes one file (no multiple attribute), '+n+' given'; return null})(${JSON.stringify(selector)},${count})`;
}

/** The touch path of a swipe, from `start` (already the click-target centre or the viewport centre when from is absent): the points, in CSS px, the finger passes. */
export function swipePath(step: Pick<VideoStep, 'from' | 'to' | 'direction' | 'distance'>, start: [number, number],
  viewport: { width: number; height: number }, moves = 12): Array<[number, number]> {
  const from = step.from ?? start;
  let to: [number, number];
  if (step.to) to = step.to;
  else {
    const d = step.distance as number;
    to = step.direction === 'up' ? [from[0], from[1] - d] : step.direction === 'down' ? [from[0], from[1] + d]
      : step.direction === 'left' ? [from[0] - d, from[1]] : [from[0] + d, from[1]];
  }
  for (const [label, p] of [['start', from], ['end', to]] as const) {
    if (p[0] < 0 || p[1] < 0 || p[0] > viewport.width || p[1] > viewport.height) {
      throw new Error(`swipe ${label} point (${Math.round(p[0])}, ${Math.round(p[1])}) is outside the ${viewport.width}x${viewport.height} viewport`);
    }
  }
  const path: Array<[number, number]> = [];
  for (let i = 0; i <= moves; i++) path.push([from[0] + (to[0] - from[0]) * i / moves, from[1] + (to[1] - from[1]) * i / moves]);
  return path;
}
