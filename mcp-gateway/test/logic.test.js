import test from 'node:test';
import assert from 'node:assert/strict';
import { inResearchHours, validatePublicUrl, searchWeb, scrapeWeb } from '../src/logic.js';

test('research hours follow Eastern time, including overnight, weekends and daylight saving', () => {
  const cases = [
    ['2026-10-26T20:59:00Z', false], ['2026-10-26T21:00:00Z', true],
    ['2026-10-27T05:59:00Z', true], ['2026-10-27T06:00:00Z', false],
    ['2026-10-31T19:59:00Z', false], ['2026-10-31T20:00:00Z', true],
    ['2026-11-01T07:59:00Z', true], ['2026-11-01T08:00:00Z', false],
    ['2026-11-01T20:59:00Z', false], ['2026-11-01T21:00:00Z', true],
    ['2026-11-02T07:59:00Z', true], ['2026-11-02T08:00:00Z', false],
    ['2026-11-02T21:59:00Z', false], ['2026-11-02T22:00:00Z', true],
    ['2026-11-03T06:59:00Z', true], ['2026-11-03T07:00:00Z', false],
    ['2026-10-31T05:59:00Z', true], ['2026-10-31T06:00:00Z', false]
  ];
  for (const [instant, expected] of cases) assert.equal(inResearchHours(new Date(instant)), expected, instant);
});

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const privateLookup = async () => [{ address: '192.168.1.1', family: 4 }];
test('rejects local, literal, malformed, private and credential-bearing URLs', async () => {
  for (const url of ['http://127.0.0.1/', 'http://localhost/', 'http://crawler.railway.internal/', 'http://user:pass@example.com/', 'file:///etc/passwd', 'https://example.com:8000/'])
    await assert.rejects(validatePublicUrl(url, publicLookup));
  await assert.rejects(validatePublicUrl('https://example.com', privateLookup));
  await assert.rejects(validatePublicUrl('https://example.com', async () => [{ address: '::ffff:127.0.0.1' }]));
  assert.equal(await validatePublicUrl('https://example.com', publicLookup), 'https://example.com/');
});
test('search passes the query and returns bounded structured result fields', async () => {
  const fetchFn = async (url, options) => {
    assert.equal(url.searchParams.get('q'), 'test query');
    assert.equal(url.searchParams.get('format'), 'json');
    assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => ({ results: [{ title: 'Title', url: 'https://example.com', content: 'Description', engines: ['test'], extra: 'ignored' }] }) };
  };
  const result = await searchWeb({ query: 'test query', count: 1 }, { baseUrl: 'http://search.internal:8080', fetchFn });
  assert.deepEqual(result.results, [{ title: 'Title', url: 'https://example.com', description: 'Description', engines: ['test'] }]);
});
test('search reports missing configuration, empty results and upstream errors', async () => {
  await assert.rejects(searchWeb({ query: 'x' }, {}), /not configured/);
  await assert.rejects(searchWeb({ query: 'x' }, { baseUrl: 'http://search.internal', fetchFn: async () => ({ ok: false, status: 429 }) }), /HTTP 429/);
  await assert.rejects(searchWeb({ query: 'x' }, { baseUrl: 'http://search.internal', fetchFn: async () => ({ ok: true, json: async () => ({ results: [] }) }) }), /No search results/);
});
test('scrape uses backend authentication and truncates content', async () => {
  const fetchFn = async (url, options) => {
    assert.equal(url.toString(), 'http://crawler.railway.internal:11235/md');
    assert.equal(options.headers.Authorization, 'Bearer backend-secret');
    assert.equal(JSON.parse(options.body).url, 'https://example.com/');
    return { ok: true, json: async () => ({ success: true, markdown: 'abcdef' }) };
  };
  assert.deepEqual(await scrapeWeb({ url: 'https://example.com', max_chars: 3 }, { baseUrl: 'http://crawler.railway.internal:11235', token: 'backend-secret', lookup: publicLookup, fetchFn }), { url: 'https://example.com/', markdown: 'abc', truncated: true });
});
test('scrape surfaces failed backend requests', async () => {
  await assert.rejects(scrapeWeb({ url: 'https://example.com' }, { baseUrl: 'http://crawler/', token: 'x', lookup: publicLookup, fetchFn: async () => ({ ok: false, status: 500 }) }), /HTTP 500/);
});
