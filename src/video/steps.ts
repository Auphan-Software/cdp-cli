/**
 * The step file of `video replay`: the Jarvis browser-video format, JSON
 * `{"steps": [...]}` or a bare list. Each step has `do` and the keys below; any
 * step may add `caption` (shown from that step on) and `timeout` (seconds to
 * find an element, default 5).
 *
 *   goto {url} | click {selector|text} | type {selector, value} | press {key}
 *   wait {selector|text [gone] | selector+value | ms} | caption {text}
 *   assert-visible {selector|text}
 */

export interface VideoStep {
  do: 'goto' | 'click' | 'type' | 'press' | 'wait' | 'caption' | 'assert-visible';
  url?: string; selector?: string; text?: string; value?: string; key?: string;
  ms?: number; gone?: boolean; caption?: string; timeout?: number;
}

export interface StepFile { name?: string; pointer?: [number, number]; glideMs?: number; steps: VideoStep[] }

const MAX_STEPS = 200;
const KEYS: Record<VideoStep['do'], string[]> = {
  goto: ['url'], click: ['selector', 'text'], type: ['selector', 'value'], press: ['key'],
  wait: ['selector', 'text', 'gone', 'value', 'ms'], caption: ['text'], 'assert-visible': ['selector', 'text']
};

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
  const glideMs = typeof raw.glide_ms === 'number' && raw.glide_ms >= 0 ? raw.glide_ms : undefined;
  return { ...(typeof raw.name === 'string' ? { name: raw.name } : {}), ...(pointer ? { pointer } : {}),
    ...(glideMs !== undefined ? { glideMs } : {}), steps: raw.steps as VideoStep[] };
}

/** `click "Save"`, the label a failure names its step by. */
export function describeStep(step: VideoStep): string {
  const target = step.url ?? step.selector ?? step.text ?? step.key ?? (step.ms !== undefined ? `${step.ms}ms` : '');
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
