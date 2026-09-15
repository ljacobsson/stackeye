import test from 'node:test';
import assert from 'node:assert/strict';

// router.js and view-history.js run in the browser, so the handful of globals they
// touch are stubbed here before the modules are imported.
globalThis.location = { pathname: '/', search: '?workspace=dev', hash: '' };
globalThis.history = {
  entries: [],
  pushState(_state, _title, url) { this.entries.push(url); globalThis.location.hash = url.slice(url.indexOf('#')); },
  replaceState(_state, _title, url) { this.entries[Math.max(0, this.entries.length - 1)] = url; globalThis.location.hash = url.slice(url.indexOf('#')); },
};
const listeners = {};
globalThis.addEventListener = (type, handler) => { (listeners[type] ||= []).push(handler); };
const store = new Map();
globalThis.localStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: (key) => store.delete(key) };

const { parseRoute, formatRoute, writeRoute, onRoute } = await import('../public/router.js');
const { loadHistory, historyEntries, recordVisit, dropVisit, clearHistory } = await import('../public/view-history.js');

test('formats a route and drops empty filters', () => {
  assert.equal(formatRoute('overview', {}), '#/overview');
  assert.equal(formatRoute('dynamodb', { table: 'Orders', op: '', qlimit: undefined, pk: 'USER#1' }), '#/dynamodb?table=Orders&pk=USER%231');
});

test('parses a route back into a view and its filters', () => {
  assert.deepEqual(parseRoute('#/dynamodb?table=Orders&pk=USER%231'), { view: 'dynamodb', params: { table: 'Orders', pk: 'USER#1' } });
  assert.deepEqual(parseRoute('#/s3'), { view: 's3', params: {} });
  assert.equal(parseRoute(''), null);
  assert.equal(parseRoute('#'), null);
});

test('survives a round trip through values needing encoding', () => {
  const params = { q: 'a b/c?d=e&f', filter: 'ERROR "boom"' };
  assert.deepEqual(parseRoute(formatRoute('logs', params)).params, params);
});

test('writes a route once and keeps the workspace query string', () => {
  globalThis.location.hash = '';
  globalThis.history.entries = [];
  assert.equal(writeRoute('logs', { fn: 'Api' }), true);
  assert.equal(globalThis.history.entries.at(-1), '/?workspace=dev#/logs?fn=Api');
  assert.equal(writeRoute('logs', { fn: 'Api' }), false, 'an unchanged route must not push a duplicate entry');
  assert.equal(globalThis.history.entries.length, 1);
});

test('reports back and forward navigation but ignores its own writes', () => {
  const seen = [];
  onRoute((route) => seen.push(route));
  writeRoute('s3', { bucket: 'Assets' });
  for (const handler of listeners.popstate) handler();
  assert.deepEqual(seen, [], 'a programmatic write is not a user navigation');
  globalThis.location.hash = '#/dsql?cluster=Main';
  for (const handler of listeners.popstate) handler();
  assert.deepEqual(seen, [{ view: 'dsql', params: { cluster: 'Main' } }]);
});

test('keeps view history recency ordered and unique per URL', () => {
  loadHistory('stackeye.viewhistory.test');
  recordVisit({ url: '#/overview', view: 'overview', subject: 'overview:', title: 'Overview' });
  recordVisit({ url: '#/s3?bucket=A', view: 's3', subject: 's3:A', title: 'A' });
  recordVisit({ url: '#/overview', view: 'overview', subject: 'overview:', title: 'Overview' });
  assert.deepEqual(historyEntries().map((entry) => entry.url), ['#/overview', '#/s3?bucket=A']);
});

test('collapses repeated filter changes on the same subject', () => {
  clearHistory();
  recordVisit({ url: '#/dynamodb?table=Orders', view: 'dynamodb', subject: 'dynamodb:Orders', title: 'Orders' });
  recordVisit({ url: '#/dynamodb?table=Orders&pk=USER%231', view: 'dynamodb', subject: 'dynamodb:Orders', title: 'Orders' });
  assert.equal(historyEntries().length, 1);
  assert.equal(historyEntries()[0].url, '#/dynamodb?table=Orders&pk=USER%231');
  recordVisit({ url: '#/dynamodb?table=Carts', view: 'dynamodb', subject: 'dynamodb:Carts', title: 'Carts' });
  assert.deepEqual(historyEntries().map((entry) => entry.title), ['Carts', 'Orders']);
});

test('persists history across reloads and can be pruned', () => {
  clearHistory();
  recordVisit({ url: '#/logs?fn=Api', view: 'logs', subject: 'logs:Api', title: 'Api' });
  recordVisit({ url: '#/architecture', view: 'architecture', subject: 'architecture:', title: 'Stack architecture' });
  assert.deepEqual(loadHistory('stackeye.viewhistory.test').map((entry) => entry.url), ['#/architecture', '#/logs?fn=Api']);
  dropVisit(0);
  assert.deepEqual(loadHistory('stackeye.viewhistory.test').map((entry) => entry.url), ['#/logs?fn=Api']);
  clearHistory();
  assert.deepEqual(loadHistory('stackeye.viewhistory.test'), []);
});
