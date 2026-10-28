import dns from 'node:dns/promises';
import net from 'node:net';
import ipaddr from 'ipaddr.js';

// Windows are based on the day the session starts, not the day after midnight.
export function inResearchHours(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit',
    minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value;
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  if (day < 0 || !Number.isFinite(minutes)) throw new Error('Could not determine research hours.');
  const weekend = d => d === 0 || d === 6;
  if (minutes >= (weekend(day) ? 16 : 17) * 60) return true;
  const previousDay = (day + 6) % 7;
  return minutes < (weekend(previousDay) ? 3 : 2) * 60;
}

export async function validatePublicUrl(input, lookup = dns.lookup) {
  let url;
  try { url = new URL(input); } catch { throw new Error('Provide a valid absolute HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !['', '80', '443'].includes(url.port))
    throw new Error('Only public HTTP/HTTPS URLs on standard ports are supported.');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (net.isIP(host.replace(/^\[|\]$/g, '')) || host === 'localhost' || !host.includes('.') || /\.(local|internal|localhost|home|lan|test|invalid)$/.test(host))
    throw new Error('Private, local and IP-literal destinations are not allowed.');
  let addresses;
  try { addresses = await lookup(host, { all: true, verbatim: true }); } catch { throw new Error('Could not resolve the requested host.'); }
  if (!addresses.length || addresses.some(({ address }) => {
    try { return ipaddr.process(address).range() !== 'unicast'; } catch { return true; }
  })) throw new Error('Destination resolves to a non-public address.');
  return url.toString();
}

export async function searchWeb({ query, count = 5 }, { baseUrl, fetchFn = fetch }) {
  if (!baseUrl) throw new Error('Web search is not configured: set SEARCH_URL on Railway.');
  const endpoint = new URL('/search', baseUrl);
  endpoint.searchParams.set('q', query);
  endpoint.searchParams.set('format', 'json');
  endpoint.searchParams.set('categories', 'general');
  const response = await fetchFn(endpoint, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30000), redirect: 'error' });
  if (!response.ok) throw new Error(`Search provider returned HTTP ${response.status}.`);
  const body = await response.json();
  if (!Array.isArray(body.results)) throw new Error('Search provider returned an invalid response.');
  const results = body.results.filter(x => {
    try { return ['http:', 'https:'].includes(new URL(x.url).protocol); } catch { return false; }
  }).slice(0, count).map(x => ({ title: x.title ?? '', url: x.url, description: x.content ?? '', engines: x.engines ?? [] }));
  if (!results.length) throw new Error('No search results were returned. Search engines may be temporarily blocked or unavailable.');
  return { query, provider: 'Self-hosted SearXNG', results, unavailable_engines: body.unresponsive_engines ?? [] };
}

export async function scrapeWeb({ url, max_chars = 30000 }, { baseUrl, token, fetchFn = fetch, lookup }) {
  if (!baseUrl || !token) throw new Error('Crawler backend is not configured.');
  const safeUrl = await validatePublicUrl(url, lookup);
  const response = await fetchFn(new URL('/md', baseUrl), {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: safeUrl, f: 'raw' }), signal: AbortSignal.timeout(90000), redirect: 'error'
  });
  if (!response.ok) throw new Error(`Crawler backend returned HTTP ${response.status}.`);
  const body = await response.json();
  if (!body.success || typeof body.markdown !== 'string') throw new Error('Crawler did not return successful Markdown.');
  return { url: safeUrl, markdown: body.markdown.slice(0, max_chars), truncated: body.markdown.length > max_chars };
}
