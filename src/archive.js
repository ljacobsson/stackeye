import { unzipSync } from 'fflate';

// Office documents are zip containers too, but they keep their dedicated text preview instead.
const ARCHIVE_PATTERN = /\.(zip|jar|war|ear|whl|nupkg)$/i;

export function isArchiveKey(key) { return ARCHIVE_PATTERN.test(String(key || '')); }

// fflate calls the filter for every member and skips the ones it rejects, so returning
// false everywhere reads the whole listing without inflating a single byte.
export function archiveEntries(buffer) {
  const entries = [];
  unzip(buffer, (file) => { entries.push({ path: file.name, size: file.originalSize, compressedSize: file.size, directory: file.name.endsWith('/') }); return false; });
  return entries;
}

export function archiveSummary(entries) {
  const files = entries.filter((entry) => !entry.directory);
  return { entryCount: files.length, totalSize: files.reduce((total, entry) => total + (entry.size || 0), 0) };
}

// Groups the flat member list into one directory level, the way ListObjectsV2 does with a delimiter.
export function archiveLevel(entries, prefix = '') {
  const folders = new Set(); const files = [];
  for (const entry of entries) {
    if (!entry.path.startsWith(prefix)) continue;
    const rest = entry.path.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf('/');
    if (slash === -1) { if (!entry.directory) files.push(entry); continue; }
    folders.add(prefix + rest.slice(0, slash + 1));
  }
  return { folders: [...folders].sort(byName), files: files.sort((a, b) => byName(a.path, b.path)) };
}

export function searchArchive(entries, query) {
  const needle = String(query || '').toLowerCase();
  if (needle.length < 2) throw new Error('Enter at least two characters to search');
  return entries.filter((entry) => !entry.directory && entry.path.toLowerCase().includes(needle)).sort((a, b) => byName(a.path, b.path));
}

export function readArchiveEntry(buffer, entryPath) {
  const found = unzip(buffer, (file) => file.name === entryPath);
  if (!found[entryPath]) throw new Error(`“${entryPath}” is not in this archive`);
  return Buffer.from(found[entryPath]);
}

// Walks a chain of nested archives: each hop is an entry path inside the archive the previous hop produced.
export function resolveArchive(buffer, trail = []) {
  let current = buffer;
  for (const hop of trail) {
    if (!isArchiveKey(hop)) throw new Error(`“${hop}” is not a zip archive`);
    current = readArchiveEntry(current, hop);
  }
  return current;
}

function unzip(buffer, filter) {
  try { return unzipSync(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer), { filter }); }
  catch (error) { throw new Error(`This file could not be read as a zip archive: ${error.message}`); }
}
function byName(a, b) { return String(a).localeCompare(String(b), undefined, { numeric: true }); }
