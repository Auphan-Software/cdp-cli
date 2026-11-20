/**
 * Pointer, click ring and caption drawn into the recorded page, so the
 * screencast frames carry them with no image library. Ported from the Jarvis
 * browser-video recorder: DOM elements built with createElement, CSSOM styles
 * and Element.animate (no <style> element, no innerHTML), so a page's
 * Content-Security-Policy leaves the overlay intact and is itself untouched.
 * Page.addScriptToEvaluateOnNewDocument re-installs it on every navigation;
 * sessionStorage keeps the pointer position and caption.
 */

/** Name of the Runtime binding a followed real click reports through. */
export const CLICK_BINDING = '__cdpVideoClick';

/**
 * The pointer is a 26 px box (CSS px): a 3 px red border (radius 10-13 from its
 * centre) hugged by a white outline of this width (radius 13 to 13 + width).
 * 4 px, not 2: VP8/VP9 keep colour at half resolution (4:2:0), so a 2 px white
 * line on a yellow page loses its blue and fades into the background.
 */
export const OUTLINE_PX = 4;

export const OVERLAY_JS = String.raw`(()=>{ if(window.__bv) return; let root,ptr,ring,cap; const kv=(k,v)=>{try{if(v===undefined)return sessionStorage.getItem(k);sessionStorage.setItem(k,v)}catch(e){}};
 const st=Object.assign({x:-40,y:-40,cap:'',follow:false},JSON.parse(kv('__bv')||'{}')); const save=()=>kv('__bv',JSON.stringify(st));
 const mk=(id,css)=>{const e=document.createElement('div');e.id=id;for(const k in css)e.style.setProperty(k,css[k],k=='opacity'?'':'important');return e};
 const ensure=()=>{ if(!document.documentElement) return; if(root&&root.isConnected) return;
  root=mk('__bv',{position:'fixed',inset:'0','pointer-events':'none','z-index':'2147483647'});
  ptr=mk('__bv_ptr',{position:'absolute','box-sizing':'border-box',width:'26px',height:'26px',margin:'-13px 0 0 -13px',left:'0',top:'0',
   border:'3px solid #ff3b30','border-radius':'50%',background:'rgba(255,59,48,.35)',outline:'${OUTLINE_PX}px solid #fff'});
  ring=mk('__bv_ring',{position:'absolute','box-sizing':'border-box',width:'50px',height:'50px',margin:'-25px 0 0 -25px',border:'4px solid #ffd60a','border-radius':'50%',opacity:'0'});
  cap=mk('__bv_caption',{position:'absolute',left:'50%',bottom:'28px',transform:'translateX(-50%)','max-width':'80%',padding:'10px 18px','border-radius':'8px',
   background:'rgba(0,0,0,.78)',color:'#fff',font:'600 20px/1.3 system-ui,sans-serif','text-align':'center',display:'none'});
  root.append(ring,ptr,cap); document.documentElement.appendChild(root); apply(); };
 const apply=()=>{ ptr.style.setProperty('transform','translate('+st.x+'px,'+st.y+'px)','important'); ring.style.setProperty('left',st.x+'px','important'); ring.style.setProperty('top',st.y+'px','important');
  cap.textContent=st.cap; cap.style.setProperty('display',st.cap?'block':'none','important'); };
 const now=()=>(performance.timeOrigin+performance.now())/1000;
 window.__bv={move(x,y){st.x=x;st.y=y;save();ensure();apply()},click(){ensure();ring.getAnimations().forEach(a=>a.cancel());
   ring.animate([{opacity:1,transform:'scale(0.2)'},{opacity:0,transform:'scale(1.4)'}],{duration:600,easing:'ease-out'})},
  caption(t){st.cap=t||'';save();ensure();apply()},at(){ensure();const r=ptr.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]},
  follow(){st.follow=true;save()}};
 // record mode: the pointer follows the real mouse and a real press rings and is reported, so the video's own check covers it
 addEventListener('pointermove',e=>{if(st.follow&&e.isTrusted)window.__bv.move(e.clientX,e.clientY)},true);
 addEventListener('pointerdown',e=>{if(!st.follow||!e.isTrusted)return;window.__bv.move(e.clientX,e.clientY);window.__bv.click();
  try{window.${CLICK_BINDING}&&window.${CLICK_BINDING}(JSON.stringify({x:e.clientX,y:e.clientY,t:now()}))}catch(_){}},true);
 ensure(); document.addEventListener('DOMContentLoaded',ensure); })()`;

/** A square window of RGB pixels around a point; `null` marks a pixel outside the frame. */
export interface PixelWindow {
  size: number;
  /** RGB at (x, y) of the window, or null when it lies outside the frame. */
  at(x: number, y: number): [number, number, number] | null;
  /**
   * Where the click point lies in window pixels, when it is not the window's
   * middle: pixel i covers [i, i + 1), so a point at 287.5 on a frame whose
   * window was cut at round(287.5) = 288 sits half a pixel left of the middle.
   */
  cx?: number;
  cy?: number;
}

type RGB = [number, number, number];

const SAMPLES = 24;
/** Radii searched, in CSS px from the pointer centre: the red ring is 10-13, the white outline 13-17. */
const RED_BAND: [number, number] = [9.5, 13];
const WHITE_BAND: [number, number] = [13, 17.5];
/** The white must lie this far (CSS px) outside the red, and not further than MAX_GAP. */
const MIN_GAP = 1.5;
const MAX_GAP = 7;

const luma = ([r, g, b]: RGB): number => 0.299 * r + 0.587 * g + 0.114 * b;
/** Red ring: red clearly above green and blue (JPEG/VP9 blur the edge, so not exactly #ff3b30). */
const isRed = ([r, g, b]: RGB): boolean => r > 150 && r - Math.max(g, b) > 70;
/** Where the page lies just outside the pointer, to tell a bled outline from page content of the same colour. */
const OUTSIDE_BAND: [number, number] = [19.5, 21.5];
/** A bled outline must be this much brighter (luma) than the page around the pointer. */
const BLEED_CONTRAST = 12;
/**
 * White outline: bright, tested on luma. 4:2:0 chroma subsampling bleeds a coloured
 * page into the white (yellow takes its blue, so the minimum channel falls under
 * 200) but the luma stays full resolution. A pixel that is still plain white (every
 * channel > 200) passes; a bled one must also stand out from the page beside the
 * pointer by BLEED_CONTRAST luma, so pale page content (#ffff80: luma 241, weakest
 * channel 128) is not mistaken for an outline. A floor on the weakest channel keeps
 * saturated bright pages (#ffd60a luma 203, #ffff00 luma 226) out.
 */
const isWhite = (p: RGB, outside: number | undefined): boolean => {
  const l = luma(p);
  const weakest = Math.min(...p);
  if (l < 215 || weakest < 120) return false;
  return weakest > 200 || (outside !== undefined && l >= outside + BLEED_CONTRAST);
};

/** Median luma of the page just outside the pointer, or undefined when fewer than 8 samples are in the frame. */
function outsideLuma(win: PixelWindow, scale: number): number | undefined {
  const cx = win.cx ?? win.size / 2;
  const cy = win.cy ?? win.size / 2;
  const lumas: number[] = [];
  for (let r = OUTSIDE_BAND[0] * scale; r <= OUTSIDE_BAND[1] * scale + 1e-9; r += 1) {
    for (let k = 0; k < SAMPLES; k++) {
      const a = (2 * Math.PI * k) / SAMPLES;
      const p = win.at(Math.floor(cx + r * Math.cos(a)), Math.floor(cy + r * Math.sin(a)));
      if (p) lumas.push(luma(p));
    }
  }
  if (lumas.length < 8) return undefined;
  lumas.sort((a, b) => a - b);
  return lumas[Math.floor(lumas.length / 2)];
}

/**
 * Radii (device px) of the circles of the band at which `ok` holds for two thirds
 * of the samples inside the frame, with at least 8 inside.
 */
function matchingRadii(win: PixelWindow, scale: number, band: [number, number], ok: (p: RGB) => boolean): number[] {
  const cx = win.cx ?? win.size / 2;
  const cy = win.cy ?? win.size / 2;
  const hits: number[] = [];
  // Half a device pixel between circles: a ring is at least 2 device px wide, so none is skipped at any scale.
  for (let r = band[0] * scale; r <= band[1] * scale + 1e-9; r += 0.5) {
    let inside = 0;
    let good = 0;
    for (let k = 0; k < SAMPLES; k++) {
      const a = (2 * Math.PI * k) / SAMPLES;
      const p = win.at(Math.floor(cx + r * Math.cos(a)), Math.floor(cy + r * Math.sin(a)));
      if (!p) continue;
      inside++;
      if (ok(p)) good++;
    }
    if (inside >= 8 && good * 3 >= inside * 2) hits.push(r);
  }
  return hits;
}

/**
 * True when the pointer is drawn centred on the window: the overlay's own shape,
 * not just its colour. Some circle in the red band (CSS px 9.5-13) must be
 * #ff3b30-like for two thirds of its samples and some circle further out
 * (13-17.5, 1.5 to 7 px beyond it) white for two thirds, with at least 8 samples
 * of each inside the frame. Searching a band instead of one radius keeps the
 * check true under a fractional device scale (a radius that falls between
 * pixels) and under the blur and colour bleed of lossy video. Red page content
 * has no white outline hugging a red ring, so it does not pass; the translucent
 * centre takes the target's colour, so it is not tested. `scale` is device
 * pixels per CSS pixel.
 */
export function pointerSeen(win: PixelWindow, scale = 1): boolean {
  const red = matchingRadii(win, scale, RED_BAND, isRed);
  if (!red.length) return false;
  const outside = outsideLuma(win, scale);
  const white = matchingRadii(win, scale, WHITE_BAND, (p) => isWhite(p, outside));
  return red.some((r) => white.some((w) => w - r >= MIN_GAP * scale && w - r <= MAX_GAP * scale));
}

/** Ease-in-out pointer path from one point to another, one point per ~16 ms. */
export function glidePath(from: [number, number], to: [number, number], ms: number): Array<[number, number]> {
  const n = Math.max(1, Math.round(ms / 16));
  const path: Array<[number, number]> = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    path.push([from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e]);
  }
  return path;
}
