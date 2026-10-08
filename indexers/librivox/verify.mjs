/**
 * Exercises the plugin against responses saved from the live API on 2026-08-20, so the mapping is
 * tested on the shapes it actually has to survive rather than on fixtures written to match it.
 *
 * Run with: node verify.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import plugin from './index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');

// "^Frankenstein", extended=1, limit=3: 381 read by twelve, 2030 and 5668 each read by one.
const SEARCH = fixture('frankenstein.json');
const NO_MATCH = fixture('no-match.json');

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

function makeHost(responder) {
  const reqs = [];
  return {
    reqs,
    get calls() {
      return reqs.map((entry) => entry.url);
    },
    get titles() {
      return reqs.map((entry) => new URL(entry.url).searchParams.get('title'));
    },
    fetch: async (url, init) => {
      reqs.push({ url, init });
      return responder(url, init);
    },
    logger: { log: () => {}, warn: () => {} },
    // Mirrors server/src/modules/book-request/indexers/search-text.ts
    buildSearchText: (q) => [q.title, q.author].filter(Boolean).join(' '),
    saveCredential: async () => {},
    fail: (code, message) => Object.assign(new Error(message), { code }),
  };
}

const res = (body, init = {}) => new Response(body, { status: init.status ?? 200, headers: init.headers ?? {} });
const notFound = () => res(NO_MATCH, { status: 404 });
const cfg = (over = {}) => ({
  id: 4,
  name: 'LibriVox',
  priority: 1,
  baseUrl: 'https://librivox.org',
  credential: null,
  allowPrivateAddress: false,
  categories: { ebook: [], audiobook: [] },
  seedRatioGoal: null,
  seedTimeMinutes: null,
  settings: null,
  ...over,
});
const query = (over = {}) => ({ title: 'Frankenstein', author: 'Mary Shelley', isbn13: null, mediaKind: 'audiobook', language: null, limit: 30, ...over });
const search = (host, over = {}) => plugin.search(query(over), cfg(), host, AbortSignal.timeout(5000));

console.log('declaration');
ok('needs no credential', plugin.requiresCredential === false && plugin.credentialKind === null);
ok('carries audiobooks and nothing else', JSON.stringify(plugin.mediaKinds) === '["audiobook"]');
ok('joins no swarm and uses no categories', plugin.seedsBack === false && plugin.usesCategories === false);
ok('targets the contract this build speaks', plugin.apiVersion === 1);
ok('plugin version', plugin.version === '1.0.1');
ok('signed update channel', plugin.update?.manifestUrl.endsWith('/updates/librivox.json') && plugin.update.ed25519PublicKey.length === 43);

console.log('search requests');
{
  const host = makeHost(() => res(SEARCH));
  await search(host);
  const url = new URL(host.calls[0]);
  ok('asks the audiobook feed for JSON', url.pathname === '/api/feed/audiobooks/' && url.searchParams.get('format') === 'json');
  // Without this there are no readers, and nine recordings of one book look identical.
  ok('asks for the section list', url.searchParams.get('extended') === '1');
  // Plain `title=` is an exact match, so every attempt has to be a prefix search.
  ok('searches by prefix rather than by exact title', host.titles[0] === '^Frankenstein');
  // `title` and `author` together answer 500, so the author is left to scoring.
  ok('never sends the author', url.searchParams.get('author') === null);
}
{
  const host = makeHost(() => res(SEARCH));
  await search(host, { limit: 300 });
  ok('caps what it asks for', new URL(host.calls[0]).searchParams.get('limit') === '20');
}
{
  const host = makeHost(() => res(SEARCH));
  await search(host, { limit: 5 });
  ok('asks for no more than the request wanted', new URL(host.calls[0]).searchParams.get('limit') === '5');
}

console.log('title attempts');
{
  // LibriVox stores titles without a leading article: "The Time Machine" finds nothing.
  const host = makeHost(() => res(SEARCH));
  await search(host, { title: 'The Time Machine' });
  ok('drops a leading article and finds it in one request', host.titles.length === 1 && host.titles[0] === '^Time Machine');
}
{
  const host = makeHost(() => res(SEARCH));
  await search(host, { title: 'Frankenstein' });
  ok('asks once for a title with no article and no qualifier', host.calls.length === 1);
}
{
  // Not every language has its article stripped, so the title as it stands is worth an ask.
  let n = 0;
  const host = makeHost(() => (++n === 1 ? notFound() : res(SEARCH)));
  const out = await search(host, { title: 'The Republic' });
  ok('asks again with the article left on', JSON.stringify(host.titles) === '["^Republic","^The Republic"]', host.titles);
  ok('and returns what the second attempt found', out.length === 3);
}
{
  // A request title decorated past the work's own name matches no stored title at all.
  let n = 0;
  const host = makeHost(() => (++n === 1 ? notFound() : res(SEARCH)));
  await search(host, { title: 'Frankenstein: The 1818 Text' });
  ok('shortens at the first separator once fuller forms miss', JSON.stringify(host.titles) === '["^Frankenstein: The 1818 Text","^Frankenstein"]', host.titles);
}
{
  const host = makeHost(() => res(SEARCH));
  await search(host, { title: 'Project Hail Mary (Unabridged)' });
  ok('drops the edition qualifier a provider appended', host.titles[0] === '^Project Hail Mary');
}
{
  const host = makeHost(() => notFound());
  const out = await search(host, { title: 'Frankenstein: The 1818 Text' });
  ok('gives up quietly when no attempt matches', out.length === 0);
}
{
  const host = makeHost(() => res(SEARCH));
  await search(host, { title: 'The' });
  ok('leaves a title alone when it is only an article', host.titles[0] === '^The');
}

console.log('releases');
{
  const host = makeHost(() => res(SEARCH));
  const [first, solo] = await search(host);
  ok('names the project by its LibriVox id', first.guid === '381');
  ok('keeps the undecorated title for scoring', first.bookTitle === 'Frankenstein, or The Modern Prometheus');
  ok('reads the author off the record', first.author === 'Mary Wollstonecraft Shelley');
  ok('carries the format the zip holds', first.format === 'mp3');
  // Zero seeders is a hard filter, so a source with no swarm must report none, not zero.
  ok('reports no swarm counts rather than zero', first.seeders === null && first.leechers === null);
  ok('is free in the sense the picker means', first.freeleech === true);
  ok('turns the language name into a code', first.language === 'en');
  // 29808s at a constant 64kbps. The real zip is 238,560,130 bytes.
  ok('works the size out from the duration', first.sizeBytes === 238_464_000, first.sizeBytes);
  ok('states the audio the packaging fixes', first.audio.bitrateKbps === 64 && first.audio.bitrateMode === 'CBR' && first.audio.durationSeconds === 29808 && first.audio.chapterCount === 22);
  // The section list is a real file list, so this is the strong signal, not `fileCount`.
  ok('counts the tracks the zip holds', first.primaryFileCount === 22 && first.fileCount === undefined);
  // The URL is published with a raw space in it, which some clients reject outright.
  ok('encodes the archive URL published unencoded', first.downloadUrl.includes('%20') && !first.downloadUrl.includes(' '));
  ok('costs one request for all of it', host.calls.length === 1);

  // Who read it is the one thing separating recordings of the same book.
  ok('names the busiest readers and counts the rest', /^Frankenstein, or The Modern Prometheus \(.+ \+10\)$/.test(first.title), first.title);
  ok('names the reader of a solo recording', solo.title === 'Frankenstein; or The Modern Prometheus (1818) (Cori Samuel)', solo.title);
}
{
  const books = JSON.parse(SEARCH).books.map((b) => ({ ...b, sections: undefined }));
  const host = makeHost(() => res(JSON.stringify({ books })));
  const [first] = await search(host);
  ok('falls back to the stated section count with no section list', first.primaryFileCount === 22);
  ok('leaves the title undecorated where no reader is named', first.title === 'Frankenstein, or The Modern Prometheus');
}
{
  const books = JSON.parse(SEARCH).books.map((b) => ({ ...b, language: 'Multilingual' }));
  const host = makeHost(() => res(JSON.stringify({ books })));
  const [first] = await search(host);
  // Any code chosen for a multilingual collection would hard-filter it out of a request for one
  // of the languages it actually contains.
  ok('states no language for a multilingual collection', first.language === undefined);
}
for (const [name, patch] of [
  ['no id', { id: '' }],
  ['no title', { title: '' }],
  ['no packaged download', { url_zip_file: '' }],
  ['a download that is not a URL', { url_zip_file: 'not a url' }],
  ['a download on a protocol nothing can fetch', { url_zip_file: 'file:///etc/passwd' }],
]) {
  const books = JSON.parse(SEARCH).books.map((b) => ({ ...b, ...patch }));
  const host = makeHost(() => res(JSON.stringify({ books })));
  ok(`skips a record with ${name}`, (await search(host)).length === 0);
}

console.log('failures');
{
  // A 404 is how a search that matched nothing answers, and must not read as a broken source.
  ok('treats a 404 as no results', (await search(makeHost(() => notFound()))).length === 0);
}
{
  const err = await search(makeHost(() => res('', { status: 429 }))).catch((e) => e);
  ok('reports rate limiting as its own failure', err.code === 'throttled', err.message);
}
{
  const err = await search(makeHost(() => res('', { status: 503 }))).catch((e) => e);
  ok('reports any other refusal as an error', err.code === 'error', err.message);
}
{
  const err = await search(makeHost(() => res('<html>not librivox</html>'))).catch((e) => e);
  ok('reports a body that is not a catalogue', err.code === 'error', err.message);
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
  ok('accepts a catalogue with no books key', (await search(makeHost(() => res('{}')))).length === 0);
}

console.log('resolveFile()');
{
  const host = makeHost(() => res(SEARCH));
  const [release] = await search(host);
  const before = host.calls.length;
  const file = await plugin.resolveFile(release, cfg(), host, AbortSignal.timeout(5000));
  ok('hands back the archive the search resolved, with no further request', host.calls.length === before);
  // The download is a zip of tracks, not a track. Saying so is what makes the picker report the
  // contents as unknown until it is extracted, rather than claim one ready book file.
  ok('names the download a zip', file.format === 'zip' && file.fileName.endsWith('.zip'));
  ok('names the file after the work, not the decorated release', file.fileName === 'Frankenstein or The Modern Prometheus.zip', file.fileName);
  ok('carries the size the search worked out', file.sizeBytes === 238_464_000);

  const err = await plugin.resolveFile({ ...release, downloadUrl: undefined }, cfg(), host).catch((e) => e);
  ok('refuses a release carrying no download', err.code === 'error', err.message);
}

console.log('test()');
{
  const host = makeHost(() => res(SEARCH));
  const out = await plugin.test(cfg(), host);
  const url = new URL(host.calls[0]);
  // Asked without a title, so the check does not depend on any one work still being catalogued.
  ok('asks for the catalogue itself, not a particular book', url.searchParams.get('title') === null && url.searchParams.get('limit') === '1');
  ok('passes when the catalogue answers with a book', out.success === true && out.indexerName === 'LibriVox');
}
{
  const out = await plugin.test(cfg(), makeHost(() => res('<html>hello</html>')));
  ok('fails when the URL is not a LibriVox catalogue', out.success === false, out.error);
}
{
  const out = await plugin.test(cfg(), makeHost(() => Promise.reject(new Error('ENOTFOUND'))));
  ok('fails rather than throwing when unreachable', out.success === false, out.error);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
