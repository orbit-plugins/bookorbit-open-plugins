/**
 * Project Gutenberg as a BookOrbit indexer plugin.
 *
 * Around 75,000 public domain ebooks, each produced as a real EPUB rather than scanned. No account,
 * no credential, and everything it serves is public domain.
 *
 * Gutenberg asks not to be accessed by automated tools, and its robots.txt disallows `/ebooks/search`,
 * which is where the OPDS search this plugin uses lives. Running it is a choice about your own
 * address, so make it deliberately.
 *
 * Dependency free and single file on purpose. A plugin runs inside the BookOrbit process with that
 * process's access, so it has to be something a person can read start to finish before trusting it.
 */

const SEARCH_PATH = '/ebooks/search.opds/';

/**
 * The catalogue feed says nothing about what a record actually offers, and roughly a fifth of them
 * offer nothing: measured 2026-08-19, two of the nine "frankenstein shelley" hits carried no file,
 * and one of those was the top-ranked hit because its title matched exactly. So each result is
 * confirmed against its own document before it reaches the picker.
 *
 * Capped and rate-limited on purpose. Gutenberg is a donated public service, and the search cache
 * means a picker reopened inside its window costs nothing at all.
 */
const MAX_RESULTS = 20;
const MAX_CONCURRENT_DETAILS = 4;

/** Named rather than left to Node, which announces itself as `node`. */
const USER_AGENT = 'BookOrbit';

/** A book entry names itself `.../ebooks/<number>.opds`; the feed's own navigation entries do not. */
const BOOK_ID = /\/ebooks\/(\d+)\.opds$/;

/** Where an entry has no author, the archive puts the download count in the same element. */
const DOWNLOAD_COUNT = /^\d[\d,]*\s+downloads?$/i;

const ACQUISITION_REL = 'http://opds-spec.org/acquisition';

/**
 * What Gutenberg publishes against what a book request calls a format. It produces each edition
 * rather than scanning it, so there is no OCR derivative to sift out; the only real choice is which
 * packaging of the same text to take.
 */
const FORMAT_BY_MIME = {
  'application/epub+zip': 'epub',
  'application/x-mobipocket-ebook': 'mobi',
  'text/plain': 'txt',
  'text/plain; charset=utf-8': 'txt',
};

const FORMAT_PREFERENCE = ['epub', 'mobi', 'txt'];

/**
 * Gutenberg marks a non-English work by naming the language in its title, as in "Frankenstein, ou le
 * Promethee moderne Volume 1 (of 3) (French)", and leaves English unmarked. A closed list rather
 * than a pattern, because "(Illustrated)" sits in exactly the same position.
 *
 * An unmarked title is left with no language at all rather than assumed English, so the hard filter
 * skips it instead of rejecting a work over a guess.
 */
const LANGUAGE_BY_NAME = {
  arabic: 'ar',
  bulgarian: 'bg',
  catalan: 'ca',
  chinese: 'zh',
  czech: 'cs',
  danish: 'da',
  dutch: 'nl',
  english: 'en',
  esperanto: 'eo',
  finnish: 'fi',
  french: 'fr',
  german: 'de',
  greek: 'el',
  hebrew: 'he',
  hungarian: 'hu',
  icelandic: 'is',
  italian: 'it',
  japanese: 'ja',
  latin: 'la',
  norwegian: 'no',
  polish: 'pl',
  portuguese: 'pt',
  romanian: 'ro',
  russian: 'ru',
  serbian: 'sr',
  spanish: 'es',
  swedish: 'sv',
  tagalog: 'tl',
  welsh: 'cy',
};

export default {
  apiVersion: 1,
  version: '1.1.0',
  update: {
    manifestUrl: 'https://raw.githubusercontent.com/orbit-plugins/bookorbit-open-plugins/main/updates/project-gutenberg.json',
    ed25519PublicKey: 'xifEwwGulukbjKtXn-ArR6BgJaOk6BUzfO97cZMt6gA',
  },
  type: 'project-gutenberg',
  label: 'Project Gutenberg',
  requiresCredential: false,
  credentialKind: null,
  /**
   * Text only. Gutenberg holds some recordings, but its spoken word is dozens of files per book with
   * no packaged download, which this plugin has no way to hand to a download client.
   */
  mediaKinds: ['ebook'],
  usesCategories: false,
  seedsBack: false,
  defaultBaseUrl: 'https://www.gutenberg.org',
  baseUrlHint: "Project Gutenberg's own address. Leave it as https://www.gutenberg.org unless you run a mirror.",
  settingsFields: [
    {
      key: 'preferIllustrated',
      type: 'boolean',
      label: 'Prefer the illustrated edition',
      hint: 'Gutenberg publishes each work as an illustrated EPUB3 and as a smaller plain one. Turn this off where the extra size is a problem.',
      default: true,
    },
  ],

  async search(query, config, host, signal) {
    const feed = await call(config, host, SEARCH_PATH, { query: host.buildSearchText(query) });

    const found = [];
    for (const entry of entriesOf(feed)) {
      const id = BOOK_ID.exec(tagText(entry, 'id') ?? '')?.[1];
      const title = tagText(entry, 'title');
      // Navigation entries carry no book id, and are the feed describing itself.
      if (!id || !title) continue;
      if (found.length >= Math.min(query.limit, MAX_RESULTS)) break;

      const byline = tagText(entry, 'content');
      found.push({ id, title, ...(byline && !DOWNLOAD_COUNT.test(byline) ? { author: byline } : {}) });
    }

    const releases = [];
    const queue = [...found];
    const worker = async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        if (signal.aborted) return;
        const edition = await bestEdition(next.id, config, host).catch(() => null);
        // A record that offers no file is not a worse choice, it is not a choice.
        if (!edition) continue;

        const language = edition.language ?? languageFromTitle(next.title);
        releases.push({
          guid: next.id,
          title: next.title,
          // Gutenberg titles an entry with the work's own name, undecorated.
          bookTitle: next.title,
          // Its own document states one, so the picker shows a real figure and size scoring works.
          sizeBytes: edition.file.sizeBytes,
          // No swarm exists. Null, never zero, or the zero-seeder hard filter drops everything.
          seeders: null,
          leechers: null,
          format: edition.file.format,
          // Resolved here, so a grab costs no further request.
          downloadUrl: edition.file.url,
          // The book's page on the configured site, which lists every packaging and the credits.
          // A host older than the field ignores it.
          infoUrl: bookPageUrl(config, next.id),
          ...(language ? { language } : {}),
          ...(next.author ? { author: next.author } : {}),
          // Free in the sense the picker means: it costs the requester nothing to take.
          freeleech: true,
          // One work, one file. Nothing here is ever a split set.
          primaryFileCount: 1,
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_DETAILS, found.length) }, worker));

    // Workers drain a shared queue, so completion order is arbitrary; the feed's own relevance order
    // is a better starting point for scoring to work from.
    return releases.sort((a, b) => found.findIndex((f) => f.id === a.guid) - found.findIndex((f) => f.id === b.guid));
  },

  async test(config, host) {
    try {
      const feed = await call(config, host, SEARCH_PATH, { query: 'dickens' });
      if (!/<feed\b/.test(feed)) return { success: false, error: 'That URL did not answer with a Project Gutenberg catalogue' };
      return { success: true, indexerName: 'Project Gutenberg' };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /**
   * Gutenberg offers one work in several packagings, so the per-book document is fetched only for
   * the release an approver actually picked and one acquisition link is chosen from it.
   */
  async resolveFile(release, config, host) {
    // Already chosen during the search, which is where an undownloadable record is filtered out.
    if (release.downloadUrl && release.format) {
      return {
        url: release.downloadUrl,
        fileName: `${sanitizeName(release.title)}.${release.format}`,
        sizeBytes: release.sizeBytes,
        format: release.format,
      };
    }

    const edition = await bestEdition(release.guid, config, host);
    if (!edition) {
      throw host.fail('error', `lists "${release.title}" but offers no file for it. Pick another release.`);
    }
    return { ...edition.file, fileName: `${sanitizeName(release.title)}.${edition.file.format}` };
  },
};

/** The one downloadable edition worth taking, or null where the record offers none at all. */
async function bestEdition(id, config, host) {
  const feed = await call(config, host, `/ebooks/${encodeURIComponent(id)}.opds`, {});
  const entries = entriesOf(feed);

  const illustrated = config.settings?.preferIllustrated !== false;
  const candidates = entries
    .flatMap((entry) => linksOf(entry))
    .filter((link) => link.rel === ACQUISITION_REL && link.href)
    .map((link) => ({ link, format: FORMAT_BY_MIME[(link.type ?? '').toLowerCase().split(';')[0].trim()] }))
    .filter((entry) => Boolean(entry.format));

  // A real catalogue entry can carry no file at all: record 6542 is Frankenstein with zero
  // acquisition links, and the search feed gives no way to tell before asking.
  if (candidates.length === 0) return null;

  const best = candidates.sort((a, b) => rank(a, illustrated) - rank(b, illustrated))[0];
  // The href is absolute in the feed, so it is resolved against the configured base rather than
  // trusted as written. BookOrbit checks the address again before a download client sees it.
  const url = new URL(best.link.href, config.baseUrl);

  const language = entries.map((entry) => tagText(entry, 'dcterms:language')).find(Boolean);
  return {
    file: { url: url.href, fileName: '', sizeBytes: toNumber(best.link.length), format: best.format },
    ...(language ? { language } : {}),
  };
}

/** Under the base's own path, the way `call` builds its requests, so a mirror links to itself. */
function bookPageUrl(config, id) {
  const base = new URL(config.baseUrl);
  return new URL(`${base.pathname.replace(/\/+$/, '')}/ebooks/${id}`, base).href;
}

async function call(config, host, path, params) {
  const base = new URL(config.baseUrl);
  const url = new URL(`${base.pathname.replace(/\/+$/, '')}${path}`, base);
  url.search = new URLSearchParams(params).toString();

  let response;
  try {
    response = await host.fetch(url.href, { headers: { Accept: 'application/atom+xml', 'User-Agent': USER_AGENT } });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'AbortError' || name === 'TimeoutError') throw host.fail('timeout', 'did not answer in time');
    throw host.fail('unreachable', `could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Gutenberg throttles a client that hammers it, and a 429 read as an empty result would look
  // exactly like the book not being there. A 403 is what a block looks like, and it is worth saying
  // plainly rather than reporting as a generic failure.
  if (response.status === 429) throw host.fail('throttled', 'is rate limiting us');
  if (response.status === 403) throw host.fail('unauthorized', 'refused the request, which is what a Gutenberg block looks like');
  if (!response.ok) throw host.fail('error', `answered ${response.status}`);

  return response.text();
}

/**
 * Just enough OPDS to read this feed, because a plugin carries no dependencies and cannot import an
 * XML parser. Gutenberg's Atom is machine-generated and regular: flat entries, no mixed content, no
 * CDATA. This is not a general XML parser and would be the wrong thing to reuse as one.
 */
function entriesOf(xml) {
  return [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)].map((match) => match[1]);
}

function tagText(entry, name) {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(entry);
  return match ? decodeXml(match[1]).trim() : undefined;
}

function linksOf(entry) {
  return [...entry.matchAll(/<link\b([^>]*?)\/?>/g)].map((match) => {
    const attributes = {};
    for (const attribute of match[1].matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) {
      attributes[attribute[1]] = decodeXml(attribute[2]);
    }
    return attributes;
  });
}

/** `&amp;` last, or an escaped entity in the source decodes twice. */
function decodeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

/**
 * Format first, then packaging. Gutenberg publishes the same text as EPUB3, as older EPUB and
 * without images; the illustrated EPUB3 is the best edition for a modern reader, which is why it is
 * the default rather than the smallest file.
 */
function rank(entry, illustrated) {
  const byFormat = FORMAT_PREFERENCE.indexOf(entry.format);
  const title = (entry.link.title ?? '').toLowerCase();
  const href = (entry.link.href ?? '').toLowerCase();
  const hasImages = !href.includes('noimages') && !title.includes('no images');

  let packaging = 2;
  if (href.includes('epub3') || title.includes('epub3')) packaging = 0;
  else if (hasImages) packaging = 1;

  const wanted = hasImages === illustrated ? 0 : 4;
  return (byFormat === -1 ? FORMAT_PREFERENCE.length : byFormat) * 10 + packaging + wanted;
}

/** Only a parenthesised language name, which is where Gutenberg puts it. */
function languageFromTitle(title) {
  for (const match of title.matchAll(/\(([^)]+)\)/g)) {
    const code = LANGUAGE_BY_NAME[match[1].trim().toLowerCase()];
    if (code) return code;
  }
  return undefined;
}

/** The title reaches a filesystem path, so it is reduced to something a filename can hold. */
function sanitizeName(title) {
  return (
    title
      .replace(/[^\p{L}\p{N}\s.-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'book'
  );
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
