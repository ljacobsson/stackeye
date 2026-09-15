/* Deep links live in the fragment: '#/view?filter=value'. The workspace stays in the
   query string so server-side scoping keeps working, and the fragment carries every
   piece of view state, so pasting a URL reopens the same page with the same filters. */

export function parseRoute(hash=location.hash){
  const raw=String(hash||'').replace(/^#\/?/,'');
  if(!raw)return null;
  const separator=raw.indexOf('?'),view=decodeURIComponent(separator<0?raw:raw.slice(0,separator));
  if(!view)return null;
  return {view,params:Object.fromEntries(new URLSearchParams(separator<0?'':raw.slice(separator+1)))};
}

export function formatRoute(view,params={}){
  const search=new URLSearchParams();
  for(const [key,value] of Object.entries(params))if(value!==undefined&&value!==null&&value!=='')search.set(key,String(value));
  const query=search.toString();
  return `#/${encodeURIComponent(view)}${query?`?${query}`:''}`;
}

// Tracks what this module last wrote so programmatic updates are not mistaken for
// the user pressing back, forward, or pasting a different URL.
let written='';

export function writeRoute(view,params,{replace=false}={}){
  const hash=formatRoute(view,params);
  if(hash===location.hash)return false;
  written=hash;
  history[replace?'replaceState':'pushState'](null,'',`${location.pathname}${location.search}${hash}`);
  return true;
}

export function onRoute(handler){
  const react=()=>{if(location.hash===written)return;written=location.hash;handler(parseRoute())};
  addEventListener('popstate',react);
  addEventListener('hashchange',react);
}
