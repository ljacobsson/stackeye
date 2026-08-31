import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync, strToU8, strFromU8 } from 'fflate';
import { isArchiveKey, archiveEntries, archiveSummary, archiveLevel, searchArchive, readArchiveEntry, resolveArchive } from '../src/archive.js';
import { AwsData } from '../src/aws.js';

const inner = zipSync({ 'nested/note.txt': strToU8('from the nested zip') });
const sample = zipSync({
  'readme.md': strToU8('# hello'),
  'src/app.js': strToU8('console.log(1)'),
  'src/lib/deep.json': strToU8('{"a":1}'),
  'empty/': new Uint8Array(0),
  'bundle.zip': inner
});

test('reads the zip listing without inflating any member', () => {
  const entries = archiveEntries(sample);
  assert.deepEqual(entries.map((e) => e.path).sort(), ['bundle.zip', 'empty/', 'readme.md', 'src/app.js', 'src/lib/deep.json']);
  assert.equal(entries.find((e) => e.path === 'readme.md').size, 7);
  assert.equal(entries.find((e) => e.path === 'empty/').directory, true);
  assert.deepEqual(archiveSummary(entries), { entryCount: 4, totalSize: 7 + 14 + 7 + inner.length });
});

test('groups members into one directory level like a delimited bucket listing', () => {
  const entries = archiveEntries(sample);
  const root = archiveLevel(entries, '');
  assert.deepEqual(root.folders, ['empty/', 'src/']);
  assert.deepEqual(root.files.map((f) => f.path), ['bundle.zip', 'readme.md']);

  const src = archiveLevel(entries, 'src/');
  assert.deepEqual(src.folders, ['src/lib/']);
  assert.deepEqual(src.files.map((f) => f.path), ['src/app.js']);

  // The directory marker itself is a folder, never a file in its own listing.
  assert.deepEqual(archiveLevel(entries, 'empty/'), { folders: [], files: [] });
});

test('searches members and refuses one-character queries', () => {
  const entries = archiveEntries(sample);
  assert.deepEqual(searchArchive(entries, 'APP').map((f) => f.path), ['src/app.js']);
  assert.deepEqual(searchArchive(entries, 'src/').map((f) => f.path), ['src/app.js', 'src/lib/deep.json']);
  assert.deepEqual(searchArchive(entries, 'empty').map((f) => f.path), []); // directory markers never match
  assert.throws(() => searchArchive(entries, 'a'), /at least two characters/);
});

test('extracts a single member and reports missing ones', () => {
  assert.equal(strFromU8(readArchiveEntry(sample, 'src/lib/deep.json')), '{"a":1}');
  assert.throws(() => readArchiveEntry(sample, 'src/missing.js'), /is not in this archive/);
});

test('walks nested archives and rejects hops that are not archives', () => {
  assert.equal(strFromU8(readArchiveEntry(resolveArchive(sample, ['bundle.zip']), 'nested/note.txt')), 'from the nested zip');
  assert.equal(resolveArchive(sample, []), sample);
  assert.throws(() => resolveArchive(sample, ['readme.md']), /is not a zip archive/);
});

test('treats archive formats as browsable but leaves Office containers alone', () => {
  for (const key of ['a/b.zip', 'lambda.ZIP', 'app.jar', 'pkg.whl']) assert.equal(isArchiveKey(key), true, key);
  for (const key of ['report.docx', 'sheet.xlsx', 'notes.txt', '', undefined]) assert.equal(isArchiveKey(key), false, String(key));
});

test('reports a zip level from S3 and downloads the object only once', async () => {
  const { aws, calls } = stubbedAws(sample);
  const first = await aws.listArchive({ bucketName: 'Assets', key: 'builds/app.zip' });
  assert.deepEqual(first.archive, { key: 'builds/app.zip', trail: [], entryCount: 4, totalSize: 7 + 14 + 7 + inner.length });
  assert.deepEqual(first.folders, ['empty/', 'src/']);

  const second = await aws.listArchive({ bucketName: 'Assets', key: 'builds/app.zip', prefix: 'src/' });
  assert.deepEqual(second.files.map((f) => f.path), ['src/app.js']);
  assert.deepEqual(calls, ['HeadObject', 'GetObject', 'HeadObject']);
});

test('serves a member from a nested zip with a guessed content type', async () => {
  const { aws } = stubbedAws(sample);
  const entry = await aws.getArchiveEntry({ bucketName: 'Assets', key: 'builds/app.zip', trail: ['bundle.zip'], entryPath: 'nested/note.txt' });
  assert.equal(entry.contentType, 'text/plain');
  assert.equal(entry.buffer.toString(), 'from the nested zip');
});

test('searches inside an archive through the S3 layer', async () => {
  const { aws } = stubbedAws(sample);
  const result = await aws.listArchive({ bucketName: 'Assets', key: 'builds/app.zip', query: 'deep' });
  assert.deepEqual(result.files.map((f) => f.path), ['src/lib/deep.json']);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.folders, []);
});

test('refuses keys that are not archives and objects too large to hold in memory', async () => {
  const { aws, calls } = stubbedAws(sample);
  await assert.rejects(aws.listArchive({ bucketName: 'Assets', key: 'builds/app.txt' }), /is not a zip archive/);
  assert.deepEqual(calls, []); // rejected before any S3 call

  const huge = stubbedAws(sample, { contentLength: 400_000_000 });
  await assert.rejects(huge.aws.listArchive({ bucketName: 'Assets', key: 'builds/app.zip' }), /too large to browse \(400 MB\)/);
  assert.deepEqual(huge.calls, ['HeadObject']); // never downloaded
});

test('evicts older archives instead of growing the cache without bound', async () => {
  const { aws, calls } = stubbedAws(sample);
  for (let index = 0; index < 6; index += 1) await aws.listArchive({ bucketName: 'Assets', key: `builds/app-${index}.zip` });
  assert.equal(aws.archiveCache.size, 4);
  assert.equal(calls.filter((call) => call === 'GetObject').length, 6);
  // The most recent archives survive; the first ones were dropped.
  assert.equal([...aws.archiveCache.keys()].some((key) => key.includes('app-5.zip')), true);
  assert.equal([...aws.archiveCache.keys()].some((key) => key.includes('app-0.zip')), false);
});

function stubbedAws(zip, { contentLength = zip.length } = {}) {
  const aws = Object.create(AwsData.prototype); const calls = [];
  aws.resources = [{ logicalId: 'Assets', physicalId: 'assets-bucket', type: 'AWS::S3::Bucket' }];
  aws.s3 = { send: async (command) => {
    const operation = command.constructor.name.replace(/Command$/, ''); calls.push(operation);
    if (operation === 'HeadObject') return { ContentLength: contentLength, ETag: '"etag-1"' };
    return { Body: { transformToByteArray: async () => zip } };
  } };
  return { aws, calls };
}
