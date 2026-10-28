import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePublicUrl, searchWeb, scrapeWeb } from '../src/logic.js';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const privateLookup = async () => [{ address: '192.168.1.1', family: 4 }];
test('rejects local, literal, malformed, private and credential-bearing URLs', async () => {
  for (const url of ['http://127.0.0.1/', 'http://localhost/', 'http://crawler.railway.internal/', 'http://user:pass@example.com/', 'file:///etc/passwd', 'https://example.com:8000/'])
    await assert.rejects(validatePublicUrl(url, publicLookup));
  await assert.rejects(validatePublicUrl('https://example.com', privateLookup));
  await assert.rejects(validatePublicUrl('https://example.com', async () => [{ address: '::ffff:127.0.0.1' }]));
  assert.equal(await validatePublicUrl('https://example.com', publicLookup), 'https://example.com/');
});
test('search passes bounded query and only returns structured result fields', async () => {
  const fetchFn = async (url, options) => {
    assert.equal(url.searchParams.get('q'), 'test query');
    assert.equal(url.searchParams.get('count'), '1');
    assert.equal(options.headers['X-Subscription-Token'], 'secret');
    return { ok: true, json: async () => ({ web: { results: [{ title: 'Title', url: 'https://example.com', description: 'Description', extra: 'ignored' }] } }) };
  };
  const result = await searchWeb({ query: 'test query', count: 1 }, { key: 'secret', fetchFn });
  assert.deepEqual(result.results, [{ title: 'Title', url: 'https://example.com', description: 'Description' }]);
});
test('search reports missing keys and upstream errors without disclosing secrets', async () => {
  await assert.rejects(searchWeb({ query: 'x' }, {}), /not configured/);
  await assert.rejects(searchWeb({ query: 'x' }, { key: 'secret', fetchFn: async () => ({ ok: false, status: 429 }) }), /HTTP 429/);
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
