/**
 * Exercises the plugin against feeds saved from the live catalogue on 2026-08-20, so the OPDS
 * reader is tested on the markup it actually has to survive rather than on fixtures written to
 * match it. That matters more here than usual: a plugin carries no dependencies and cannot import
 * an XML parser, so this one reads the feed itself.
 *
 * Run with: node verify.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import plugin from './index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');

// "Frankenstein Mary Shelley": nine entries, one of which (11659) has a download count where the
// byline goes, and one of which (6542) is a real record that offers no file at all.
const SEARCH = fixture('search.opds');
const RECORD_84 = fixture('record-84.opds');
const RECORD_NO_FILE = fixture('record-no-file.opds');

let pass = 0;
let fail = 0;
const ok = (name, condition, extra) => {
  if (condition) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}`, extra ?? '');
  }
};

/** Serves the search feed, then each record's own document by id. */
function catalogue(records = {}, fallback = RECORD_84) {
  return (url) => {
    const path = new URL(url).pathname;
    if (path.includes('search.opds')) return res(SEARCH);
    const id = /\/ebooks\/(\d+)\.opds/.exec(path)?.[1];
    return res(records[id] ?? fallback);
  };
}

function makeHost(responder) {
  const reqs = [];
  return {
    reqs,
    get calls() {
      return reqs.map((entry) => entry.url);
    },
    fetch: async (url, init) => {
      reqs.push({ url, init });
      return responder(url, init);
    },
    logger: { log: () => {}, warn: () => {} },
    // Mirrors server/src/modules/book-request/indexers/search-text.ts
    buildSearchText: (q) =>
      [q.title.replace(/[([{][^)\]}]*[)\]}]/g, ' ').replace(/\s+/g, ' ').trim() || q.title, q.author]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    saveCredential: async () => {},
    fail: (code, message) => Object.assign(new Error(message), { code }),
  };
}

const res = (body, init = {}) => new Response(body, { status: init.status ?? 200, headers: init.headers ?? {} });
const cfg = (over = {}) => ({
  id: 5,
  name: 'Project Gutenberg',
  priority: 1,
  baseUrl: 'https://www.gutenberg.org',
  credential: null,
  allowPrivateAddress: false,
  categories: { ebook: [], audiobook: [] },
  seedRatioGoal: null,
  seedTimeMinutes: null,
  settings: null,
  ...over,
});
const query = (over = {}) => ({ title: 'Frankenstein', author: 'Mary Shelley', isbn13: null, mediaKind: 'ebook', language: null, limit: 30, ...over });
const search = (host, over = {}, config = cfg()) => plugin.search(query(over), config, host, AbortSignal.timeout(5000));

console.log('declaration');
ok('needs no credential', plugin.requiresCredential === false && plugin.credentialKind === null);
ok('carries ebooks and nothing else', JSON.stringify(plugin.mediaKinds) === '["ebook"]');
ok('joins no swarm and uses no categories', plugin.seedsBack === false && plugin.usesCategories === false);
ok('targets the contract this build speaks', plugin.apiVersion === 1);
ok('plugin version', plugin.version === '1.0.1');
ok(
  'signed update channel',
  plugin.update?.manifestUrl.endsWith('/updates/project-gutenberg.json') && plugin.update.ed25519PublicKey.length === 43,
);
ok('offers the illustrated-edition toggle', plugin.settingsFields?.[0]?.key === 'preferIllustrated' && plugin.settingsFields[0].default === true);

console.log('search requests');
{
  const host = makeHost(catalogue());
  await search(host);
  const url = new URL(host.calls[0]);
  ok('searches the catalogue feed', url.pathname === '/ebooks/search.opds/');
  ok('sends the title and author as one query', /Frankenstein/.test(url.searchParams.get('query') ?? '') && /Shelley/.test(url.searchParams.get('query') ?? ''));
}

console.log('reading the feed');
{
  const host = makeHost(catalogue());
  const out = await search(host);
  const byGuid = Object.fromEntries(out.map((r) => [r.guid, r]));
  // The feed carries nine entries. The ones naming `/ebooks/<n>.opds` are books; the rest are the
  // feed describing itself and carry no book id at all.
  ok('reads book ids out of the entry ids', Boolean(byGuid['84'] && byGuid['41445'] && byGuid['20038']));
  ok('skips the feed\'s own navigation entries', out.every((r) => /^\d+$/.test(r.guid)));
  ok('reads the title', byGuid['84'].title === 'Frankenstein; or, the modern prometheus', byGuid['84'].title);
  ok('reads the byline as the author', byGuid['84'].author === 'Mary Wollstonecraft Shelley');
  // Where an entry has no author, the archive puts the download count in the same element.
  ok('does not mistake a download count for an author', out.every((r) => !/^\d[\d,]*\s+downloads?$/i.test(r.author ?? '')));
  ok('keeps the undecorated title for scoring', byGuid['84'].bookTitle === byGuid['84'].title);
  ok('reports no swarm counts rather than zero', byGuid['84'].seeders === null && byGuid['84'].leechers === null);
  ok('is free in the sense the picker means', byGuid['84'].freeleech === true);
  ok('is never a split set', byGuid['84'].primaryFileCount === 1);
  // Unicode in a title has to survive the reader, which reads the feed itself rather than with an
  // XML parser. Entry 11659 carries U+2014, written escaped here because the character itself is
  // not allowed in this codebase.
  ok('carries non-ASCII in a title through intact', byGuid['11659']?.title.includes('\u2014') === true, byGuid['11659']?.title);
}
{
  // A real catalogue record can carry no file at all, and the search feed cannot say so in advance.
  const host = makeHost(catalogue({ 6542: RECORD_NO_FILE }));
  const out = await search(host);
  ok('drops a record that offers no file', out.every((r) => r.guid !== '6542'));
  ok('keeps the ones that do', out.length > 0);
}
{
  const host = makeHost(catalogue());
  const out = await search(host, { limit: 2 });
  ok('asks for no more records than the request wanted', out.length <= 2);
}

console.log('choosing an edition');
{
  const [first] = await search(makeHost(catalogue()));
  // Format first, then packaging: the illustrated EPUB3 is the best edition for a modern reader.
  ok('prefers the illustrated EPUB3 by default', first.downloadUrl.endsWith('84.epub3.images'), first.downloadUrl);
  ok('states the size the record gives', first.sizeBytes === 474401, first.sizeBytes);
  ok('states the format', first.format === 'epub');
  ok('reads the language off the record', first.language === 'en');
}
{
  const [first] = await search(makeHost(catalogue()), {}, cfg({ settings: { preferIllustrated: false } }));
  ok('takes the smaller plain edition when asked', first.downloadUrl.endsWith('84.epub.noimages'), first.downloadUrl);
  ok('and its size with it', first.sizeBytes === 356351, first.sizeBytes);
}
{
  // Gutenberg marks a non-English work by naming the language in the title, and leaves English
  // unmarked. "(Illustrated)" sits in the same position, which is why the names are a closed list.
  const record = RECORD_84.replace(/<dcterms:language>[^<]*<\/dcterms:language>/g, '');
  const feed = SEARCH.replace('Frankenstein; or, the modern prometheus', 'Frankenstein, ou le Promethee moderne (French)');
  const host = makeHost((url) => (new URL(url).pathname.includes('search.opds') ? res(feed) : res(record)));
  const [first] = await search(host);
  ok('falls back to a language named in the title', first.language === 'fr', first.language);
}
{
  const record = RECORD_84.replace(/<dcterms:language>[^<]*<\/dcterms:language>/g, '');
  const feed = SEARCH.replace('Frankenstein; or, the modern prometheus', 'Frankenstein (Illustrated)');
  const host = makeHost((url) => (new URL(url).pathname.includes('search.opds') ? res(feed) : res(record)));
  const [first] = await search(host);
  // An unmarked title is left with no language rather than assumed English, so the hard filter
  // skips it instead of rejecting a work over a guess.
  ok('does not read a parenthesis that is not a language', first.language === undefined, first.language);
}
{
  // The feed is machine-generated and carries no entities today, so this is the one case the saved
  // markup cannot cover. `&amp;lt;` is an escaped literal "&lt;": decoding it once yields "&lt;",
  // and decoding it twice yields "<". Order matters, and only a doubly-escaped value shows it.
  const feed = SEARCH.replace('Frankenstein; or, the modern prometheus', 'Frankenstein &amp;lt;1818&amp;gt;');
  const host = makeHost((url) => (new URL(url).pathname.includes('search.opds') ? res(feed) : res(RECORD_84)));
  const [first] = await search(host);
  ok('decodes XML entities exactly once', first.bookTitle === 'Frankenstein &lt;1818&gt;', first.bookTitle);
}
{
  // The same rule on an attribute, which is where an href would carry one.
  const record = RECORD_84.replace('84.epub3.images', '84.epub3.images?q=a&amp;amp;b');
  const host = makeHost(catalogue({ 84: record }));
  const [first] = await search(host);
  ok('decodes an attribute entity exactly once', first.downloadUrl.endsWith('?q=a&amp;b'), first.downloadUrl);
}

console.log('failures');
{
  const err = await search(makeHost(() => res('', { status: 429 }))).catch((e) => e);
  ok('reports rate limiting as its own failure', err.code === 'throttled', err.message);
}
{
  // A 403 is what a block looks like, and is worth saying plainly rather than as a generic failure.
  const err = await search(makeHost(() => res('', { status: 403 }))).catch((e) => e);
  ok('reports a refusal as unauthorized rather than a generic error', err.code === 'unauthorized', err.message);
}
{
  const err = await search(makeHost(() => res('', { status: 503 }))).catch((e) => e);
  ok('reports any other refusal as an error', err.code === 'error', err.message);
}
{
  const err = await search(
    makeHost(() => Promise.reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))),
  ).catch((e) => e);
  ok('reports a timeout as a timeout', err.code === 'timeout', err.message);
}
{
  const err = await search(makeHost(() => Promise.reject(new Error('getaddrinfo ENOTFOUND')))).catch((e) => e);
  ok('reports an unreachable source as unreachable', err.code === 'unreachable', err.message);
}
{
  const out = await search(makeHost(() => res('<html>not a catalogue</html>')));
  ok('finds nothing in a page that is not a feed', out.length === 0);
}

console.log('resolveFile()');
{
  const host = makeHost(catalogue());
  const [release] = await search(host);
  const before = host.calls.length;
  const file = await plugin.resolveFile(release, cfg(), host, AbortSignal.timeout(5000));
  ok('reuses what the search already resolved, with no further request', host.calls.length === before);
  ok('names the file after the work', file.fileName === 'Frankenstein or the modern prometheus.epub', file.fileName);
  ok('carries the format and size through', file.format === 'epub' && file.sizeBytes === 474401);
}
{
  const host = makeHost(catalogue({ 84: RECORD_NO_FILE }));
  const err = await plugin
    .resolveFile({ guid: '84', title: 'Frankenstein' }, cfg(), host, AbortSignal.timeout(5000))
    .catch((e) => e);
  ok('refuses a record that offers no file', err.code === 'error', err.message);
}

console.log('test()');
{
  const host = makeHost(catalogue());
  const out = await plugin.test(cfg(), host);
  ok('passes when the URL answers with a catalogue', out.success === true && out.indexerName === 'Project Gutenberg');
}
{
  const out = await plugin.test(cfg(), makeHost(() => res('<html>hello</html>')));
  ok('fails when the URL is not a catalogue', out.success === false, out.error);
}
{
  const out = await plugin.test(cfg(), makeHost(() => Promise.reject(new Error('ENOTFOUND'))));
  ok('fails rather than throwing when unreachable', out.success === false, out.error);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
