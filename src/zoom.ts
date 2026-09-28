/**
 * Figure zoom: click (or tap, or press Enter on) a diagram to open it full screen, then zoom with
 * the wheel, pinch, double-click, or the + / − / Reset controls, and drag to pan. Escape closes.
 *
 * Ported from the Reading Room's editorial bundle (reading-room:
 * skill/editorial-longform-html/assets/engineering-reference.html, EDITORIAL-HEAD/BODY "edzoom"),
 * with four changes: bench-sheet color tokens instead of the editorial palette (so it follows the
 * light and dark themes); the zoomed copy keeps the diagram's grid ground and fonts; links, buttons,
 * and glossary terms inside a figure keep working instead of opening the zoom; and every figure gets
 * a corner zoom button (⤢), faint at rest and full on hover or focus, which is both the desktop
 * affordance and the keyboard path (focus returns to it on close). Touch screens get a "Tap to
 * zoom" label above the drawing instead.
 *
 * The class names and the `window.__edzoom` guard are kept, so a page served inside the Reading
 * Room (which injects its own copy) runs only one zoom.
 */

export const ZOOM_CSS = `
/* ── figure zoom (ported from the Reading Room editorial bundle) ─────────── */
.edzoom-able { cursor: zoom-in; position: relative; }
/* The corner button is always faintly present, so desktop readers can see a figure is interactive. */
.edzoom-btn {
  position: absolute; top: 8px; right: 8px; z-index: 2;
  display: inline-flex; align-items: center;
  font: 600 9px/1 var(--f-mono); letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--cobalt); background: var(--paper-2); border: 1px solid var(--rule); border-radius: 2px;
  padding: 4px 7px; cursor: pointer; opacity: 0.6; transition: opacity .15s, border-color .15s;
}
.edzoom-btn .edzoom-ico { font-size: 13px; letter-spacing: 0; line-height: 0.8; }
.edzoom-btn .edzoom-lbl { max-width: 0; overflow: hidden; white-space: nowrap; transition: max-width .15s, margin .15s; }
.edzoom-able:hover .edzoom-btn, .edzoom-btn:focus-visible { opacity: 1; border-color: var(--cobalt); }
.edzoom-able:hover .edzoom-lbl, .edzoom-btn:focus-visible .edzoom-lbl { max-width: 6em; margin-left: 6px; }
.edzoom-btn:focus-visible { outline: 2px solid var(--cobalt); outline-offset: 2px; }
/* Touch screens have no hover: hide the button and set a label above the drawing, not over it. */
@media (hover: none) {
  .edzoom-btn { display: none; }
  .edzoom-able::before {
    content: "Tap to zoom"; display: block; width: max-content; margin: 0 0 6px auto;
    font: 600 9px/1 var(--f-mono); letter-spacing: 0.16em; text-transform: uppercase;
    color: var(--cobalt); background: var(--paper-2); border: 1px solid var(--rule);
    padding: 4px 7px; border-radius: 2px;
  }
}
.edzoom-overlay {
  position: fixed; inset: 0; z-index: 1000; display: none; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--paper) 97%, transparent);
  -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px); cursor: zoom-out;
}
.edzoom-overlay.open { display: flex; }
.edzoom-stage {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  overflow: hidden; cursor: grab; touch-action: none;
}
.edzoom-stage.dragging { cursor: grabbing; }
.edzoom-content {
  transform-origin: center center; will-change: transform; user-select: none;
  width: min(94vw, 1400px); max-height: 88vh; display: flex; align-items: center; justify-content: center;
}
.edzoom-content svg, .edzoom-content img {
  display: block; width: 100% !important; height: auto !important;
  max-width: 100% !important; max-height: 88vh !important;
  box-sizing: border-box; padding: 0.9rem; border: 1px solid var(--rule); border-radius: 2px;
  background-color: var(--paper);
  background-image:
    linear-gradient(var(--rule-2) 1px, transparent 1px),
    linear-gradient(90deg, var(--rule-2) 1px, transparent 1px);
  background-size: 16px 16px; background-position: -1px -1px;
}
.edzoom-content svg .m { font-family: var(--f-mono); }
.edzoom-content svg .f { font-family: var(--f-head); }
.edzoom-controls {
  position: fixed; bottom: max(24px, env(safe-area-inset-bottom)); left: 50%; transform: translateX(-50%);
  z-index: 1001; display: flex;
  font: 11px/1 var(--f-mono); letter-spacing: 0.12em; text-transform: uppercase;
  background: var(--paper-2); border: 1px solid var(--rule); border-radius: 3px; overflow: hidden;
  box-shadow: 0 .3rem 1rem rgba(0,0,0,.12);
}
.edzoom-controls button {
  appearance: none; background: transparent; border: none; border-left: 1px solid var(--rule);
  color: var(--cobalt); padding: 10px 15px; cursor: pointer; font: inherit; letter-spacing: inherit; text-transform: inherit;
}
.edzoom-controls button:first-child { border-left: none; }
.edzoom-controls button:hover { background: var(--cobalt-wash); }
.edzoom-controls button:focus-visible { outline: 2px solid var(--cobalt); outline-offset: -2px; }
.edzoom-controls .edzoom-pct {
  color: var(--ink-2); padding: 10px 14px; border-left: 1px solid var(--rule); min-width: 64px; text-align: center; align-self: center;
}
:root.edzoom-open .bookbar { visibility: hidden; }
@media print { .edzoom-overlay, .edzoom-controls, .edzoom-btn, .edzoom-able::before { display: none !important; } }
`;

export const ZOOM_JS = `
(function(){
  if(window.__edzoom)return; window.__edzoom=true;
  var overlay,stage,content,pct,scale=1,tx=0,ty=0,drag=null,pointers=new Map(),pinch=null,opener=null;
  function apply(){content.style.transform='translate('+tx+'px,'+ty+'px) scale('+scale+')';pct.textContent=Math.round(scale*100)+'%';}
  function clamp(s){return Math.max(0.4,Math.min(12,s));}
  function reset(){scale=1;tx=0;ty=0;apply();}
  function zoomBy(f){scale=clamp(scale*f);apply();}
  function build(){
    overlay=document.createElement('div');overlay.className='edzoom-overlay';overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');overlay.setAttribute('aria-label','Zoomed figure');
    stage=document.createElement('div');stage.className='edzoom-stage';
    content=document.createElement('div');content.className='edzoom-content';
    stage.appendChild(content);overlay.appendChild(stage);
    var ctr=document.createElement('div');ctr.className='edzoom-controls';
    ctr.innerHTML='<button type="button" data-z="out" aria-label="Zoom out">&#8722;</button><span class="edzoom-pct" aria-live="polite">100%</span><button type="button" data-z="in" aria-label="Zoom in">+</button><button type="button" data-z="reset">Reset</button><button type="button" data-z="close">Close</button>';
    overlay.appendChild(ctr);pct=ctr.querySelector('.edzoom-pct');
    document.body.appendChild(overlay);
    ctr.addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;e.stopPropagation();var z=b.getAttribute('data-z');if(z==='in')zoomBy(1.3);else if(z==='out')zoomBy(1/1.3);else if(z==='reset')reset();else if(z==='close')close();});
    overlay.addEventListener('click',function(e){if(e.target===overlay||e.target===stage)close();});
    stage.addEventListener('wheel',function(e){e.preventDefault();var f;if(e.ctrlKey){f=Math.exp(-e.deltaY*0.01);f=Math.max(0.7,Math.min(1.4,f));}else{f=Math.exp(-e.deltaY*0.0015);f=Math.max(0.85,Math.min(1.18,f));}zoomBy(f);},{passive:false});
    var ptDist=function(a,b){var dx=a.x-b.x,dy=a.y-b.y;return Math.sqrt(dx*dx+dy*dy);};
    var ptList=function(){return Array.from(pointers.values());};
    stage.addEventListener('pointerdown',function(e){
      pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      try{stage.setPointerCapture(e.pointerId);}catch(_){}
      if(pointers.size===1){drag={x:e.clientX,y:e.clientY,tx:tx,ty:ty};stage.classList.add('dragging');}
      else{drag=null;var p=ptList();pinch={d:ptDist(p[0],p[1]),cx:(p[0].x+p[1].x)/2,cy:(p[0].y+p[1].y)/2};}
    });
    stage.addEventListener('pointermove',function(e){
      if(!pointers.has(e.pointerId))return;
      pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(pointers.size>=2&&pinch){
        var p=ptList(),nd=ptDist(p[0],p[1]),ncx=(p[0].x+p[1].x)/2,ncy=(p[0].y+p[1].y)/2;
        if(pinch.d>0)scale=clamp(scale*(nd/pinch.d));
        tx+=ncx-pinch.cx;ty+=ncy-pinch.cy;pinch={d:nd,cx:ncx,cy:ncy};apply();
      }else if(drag){tx=drag.tx+(e.clientX-drag.x);ty=drag.ty+(e.clientY-drag.y);apply();}
    });
    var endPt=function(e){
      pointers.delete(e.pointerId);
      if(pointers.size<2)pinch=null;
      if(pointers.size===0){drag=null;stage.classList.remove('dragging');}
      else if(pointers.size===1){var q=ptList()[0];drag={x:q.x,y:q.y,tx:tx,ty:ty};}
    };
    stage.addEventListener('pointerup',endPt);
    stage.addEventListener('pointercancel',endPt);
    stage.addEventListener('dblclick',function(e){e.preventDefault();if(scale>1.05)reset();else zoomBy(2.4);});
    document.addEventListener('keydown',function(e){if(!overlay.classList.contains('open'))return;if(e.key==='Escape')close();else if(e.key==='+'||e.key==='=')zoomBy(1.3);else if(e.key==='-')zoomBy(1/1.3);else if(e.key==='0')reset();});
  }
  function open(vis,host){
    opener=host||null;
    content.innerHTML='';
    var copy=vis.cloneNode(true);
    /* The copy's ids would duplicate the original's (marker refs, aria-labelledby); strip aria refs, keep defs. */
    copy.removeAttribute&&copy.removeAttribute('aria-labelledby');
    content.appendChild(copy);reset();
    overlay.classList.add('open');document.documentElement.classList.add('edzoom-open');document.documentElement.style.overflow='hidden';
    var z=overlay.querySelector('[data-z="close"]');if(z)z.focus();
  }
  function close(){
    overlay.classList.remove('open');document.documentElement.classList.remove('edzoom-open');document.documentElement.style.overflow='';
    content.innerHTML='';pointers.clear();pinch=null;drag=null;
    if(opener&&opener.focus)opener.focus();opener=null;
  }
  function visIn(el){return el.querySelector('svg, img, canvas');}
  function hostOf(t){
    if(!t.closest)return null;
    if(t.closest('.edzoom-overlay'))return null;
    /* Links, buttons, and glossary terms inside a figure (a caption link, say) keep their own behavior. */
    if(t.closest('a, button, .gloss'))return null;
    var host=t.closest('figure.edzoom-able, pre.mermaid, div.mermaid');
    return host&&visIn(host)?host:null;
  }
  function mark(){
    document.querySelectorAll('figure, pre.mermaid, div.mermaid').forEach(function(el){
      if(el.classList.contains('edzoom-marked'))return;
      if(!visIn(el))return;
      el.classList.add('edzoom-marked','edzoom-able');
      /* A real button is the keyboard and screen-reader path; hostOf skips buttons, so it opens the zoom itself. */
      var b=document.createElement('button');b.type='button';b.className='edzoom-btn';
      b.setAttribute('aria-label','Zoom figure');b.title='Open this figure full screen to zoom';
      b.innerHTML='<span class="edzoom-ico" aria-hidden="true">&#10530;</span><span class="edzoom-lbl" aria-hidden="true">Zoom</span>';
      b.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();var v=visIn(el);if(v)open(v,b);});
      el.appendChild(b);
    });
  }
  function init(){
    build();mark();
    document.addEventListener('click',function(e){var h=hostOf(e.target);if(h){e.preventDefault();open(visIn(h),h);}});
    try{new MutationObserver(mark).observe(document.body,{childList:true,subtree:true});}catch(_){}
  }
  if(document.readyState!=='loading')init();else document.addEventListener('DOMContentLoaded',init);
})();
`;
