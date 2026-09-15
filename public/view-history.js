/* Recently viewed pages, kept on this device only. Entries are recency-ordered and
   unique per URL; re-tweaking a filter on the page you are already on updates the
   newest entry in place instead of pushing a near-duplicate row. */

const HISTORY_MAX=80;
let storageKey='stackeye.viewhistory',entries=[];

export function loadHistory(key){
  storageKey=key;
  try{entries=JSON.parse(localStorage.getItem(storageKey)||'[]').filter(entry=>entry?.url&&entry?.view)}catch{entries=[]}
  return entries;
}
export function historyEntries(){return entries}
function persist(){try{localStorage.setItem(storageKey,JSON.stringify(entries))}catch{}}

// `subject` is the thing being looked at (a view plus its primary resource). Two visits
// to the same subject collapse; a different table, bucket, or function starts a new row.
export function recordVisit(entry){
  const top=entries[0];
  if(top&&top.subject===entry.subject)entries[0]={...top,...entry,at:Date.now()};
  else{entries=entries.filter(existing=>existing.url!==entry.url);entries.unshift({...entry,at:Date.now()})}
  entries=entries.slice(0,HISTORY_MAX);
  persist();
  return entries;
}
export function dropVisit(index){entries.splice(index,1);persist()}
export function clearHistory(){entries=[];persist()}
