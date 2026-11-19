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

export const OVERLAY_JS = String.raw`(()=>{ if(window.__bv) return; let root,ptr,ring,cap; const kv=(k,v)=>{try{if(v===undefined)return sessionStorage.getItem(k);sessionStorage.setItem(k,v)}catch(e){}};
 const st=Object.assign({x:-40,y:-40,cap:'',follow:false},JSON.parse(kv('__bv')||'{}')); const save=()=>kv('__bv',JSON.stringify(st));
 const mk=(id,css)=>{const e=document.createElement('div');e.id=id;for(const k in css)e.style.setProperty(k,css[k],k=='opacity'?'':'important');return e};
 const ensure=()=>{ if(!document.documentElement) return; if(root&&root.isConnected) return;
  root=mk('__bv',{position:'fixed',inset:'0','pointer-events':'none','z-index':'2147483647'});
  ptr=mk('__bv_ptr',{position:'absolute','box-sizing':'border-box',width:'26px',height:'26px',margin:'-13px 0 0 -13px',left:'0',top:'0',
   border:'3px solid #ff3b30','border-radius':'50%',background:'rgba(255,59,48,.35)',outline:'2px solid #fff'});
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
}

/**
 * True when the pointer is drawn centred on the window: the overlay's own shape,
 * not just its colour. Of 24 samples on the red ring (radius 11.5 css px) two
 * thirds must be #ff3b30-like (JPEG/VP9 blur the edge), and of 24 on the white
 * outline (radius 14) two thirds white, with at least 8 of each inside the
 * frame. Red page content has no white outline hugging a red ring, so it does
 * not pass; the translucent centre takes the target's colour, so it is not tested.
 */
export function pointerSeen(win: PixelWindow, scale = 1): boolean {
  const c = win.size / 2;
  const ring = (radius: number, ok: (p: [number, number, number]) => boolean): boolean => {
    const samples: Array<[number, number, number]> = [];
    for (let k = 0; k < 24; k++) {
      const a = (2 * Math.PI * k) / 24;
      const p = win.at(Math.round(c + radius * scale * Math.cos(a)), Math.round(c + radius * scale * Math.sin(a)));
      if (p) samples.push(p);
    }
    return samples.length >= 8 && samples.filter(ok).length * 3 >= samples.length * 2;
  };
  return ring(11.5, ([r, g, b]) => r > 150 && r - Math.max(g, b) > 70) &&
    ring(14, (p) => Math.min(...p) > 200);
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
