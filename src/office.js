import { unzipSync, strFromU8 } from 'fflate';

export function previewOffice(buffer, extension) {
  const files = unzipSync(new Uint8Array(buffer));
  const read = (name) => files[name] ? strFromU8(files[name]) : '';
  if (extension === '.docx') return xmlText(read('word/document.xml'));
  if (extension === '.pptx') return Object.keys(files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort(natural).map((name, index) => `SLIDE ${index + 1}\n${xmlText(read(name))}`).join('\n\n');
  if (extension === '.xlsx') {
    const shared = [...read('xl/sharedStrings.xml').matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)].map((m) => xmlText(m[1]));
    return Object.keys(files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort(natural).map((name, index) => {
      const rows = [...read(name).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((row) => [...row[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)].map((cell) => {
        const value = cell[2].match(/<v[^>]*>([\s\S]*?)<\/v>/)?.[1] || cell[2].match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] || '';
        return /t="s"/.test(cell[1]) ? shared[Number(value)] || '' : decode(value);
      }).join('\t')).join('\n');
      return `SHEET ${index + 1}\n${rows}`;
    }).join('\n\n');
  }
  throw new Error('This Office format cannot be previewed locally');
}

function xmlText(xml) { return decode(xml.replace(/<\/(w:p|a:p|text:p)>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<[^>]+>/g, '')).replace(/\n{3,}/g, '\n\n').trim(); }
function decode(value) { return value.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))); }
function natural(a,b) { return a.localeCompare(b,undefined,{numeric:true}); }
