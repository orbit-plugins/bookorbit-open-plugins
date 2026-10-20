/**
 * LibriVox as a BookOrbit indexer plugin.
 *
 * Not a tracker: no account, no credential, no ratio. Every recording is a volunteer reading of a
 * public domain text, released into the public domain, and the catalogue is a published API with
 * documented parameters. Its robots.txt allows everything the plugin touches.
 *
 * A project arrives as one zip of per-chapter MP3s rather than as a single file. BookOrbit's import
 * path handles that: the zip is named as a container, extracted, and imported as one audiobook of
 * many ordered tracks.
 *
 * Dependency free and single file on purpose. A plugin runs inside the BookOrbit process with that
 * process's access, so it has to be something a person can read start to finish before trusting it.
 */

const SEARCH_PATH = '/api/feed/audiobooks/';

/** The catalogue is a donated service, not an API we are entitled to hammer. */
const MAX_RESULTS = 20;

/**
 * LibriVox packages a project as one zip of 64kbps MP3s and publishes no size for it, but it does
 * publish the exact duration, and a constant bitrate makes the size arithmetic rather than a guess.
 * Measured against the zip's own content-length on 2026-08-20: 238,560,130 bytes actual against
 * 238,464,000 predicted, and 230,720,914 against 230,040,000. It costs no request at all.
 */
const BITRATE_KBPS = 64;
const BYTES_PER_SECOND = (BITRATE_KBPS * 1000) / 8;

/** How many readers to name in a release title before the rest become a count. */
const NAMED_READERS = 2;

/** Named rather than left to Node, which announces itself as `node`. */
const USER_AGENT = 'BookOrbit';

/**
 * Leading articles LibriVox strips from its own stored titles, so a request has to strip them too.
 * Measured 2026-08-20: "The Time Machine" finds nothing where "Time Machine" finds seven, and the
 * same holds for "Le Comte de Monte-Cristo" and for "Die Verwandlung".
 *
 * Only the ones confirmed to be stripped. Italian is why this is not every article in every
 * language: "Il Principe" is stored with its article, and stripping it finds nothing.
 */
const LEADING_ARTICLES = new Set(['the', 'a', 'an', 'le', 'la', 'les', 'der', 'die', 'das']);

/** Where a decorated request title stops being the work's own name. */
const TITLE_SEPARATOR = /[:;,]\s|\s-\s/;

/**
 * LibriVox states a language as its English name rather than as a code, and the release matcher
 * compares codes. "Multilingual" is deliberately absent: it means a collection read in several
 * languages, and any code chosen for it would hard-filter the release out of a request for one of
 * the languages it actually contains.
 */
const LANGUAGE_BY_NAME = {
  'ancient greek': 'grc',
  arabic: 'ar',
  bulgarian: 'bg',
  catalan: 'ca',
  chinese: 'zh',
  'church slavonic': 'chu',
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
  indonesian: 'id',
  italian: 'it',
  japanese: 'ja',
  javanese: 'jv',
  latin: 'la',
  latvian: 'lv',
  'middle english': 'enm',
  norwegian: 'no',
  'old english': 'ang',
  polish: 'pl',
  portuguese: 'pt',
  romanian: 'ro',
  russian: 'ru',
  serbian: 'sr',
  spanish: 'es',
  swedish: 'sv',
  tagalog: 'tl',
  urdu: 'ur',
  welsh: 'cy',
};

export default {
  apiVersion: 1,
  version: '1.1.0',
  update: {
    manifestUrl: 'https://raw.githubusercontent.com/orbit-plugins/bookorbit-open-plugins/main/updates/librivox.json',
    ed25519PublicKey: 'xifEwwGulukbjKtXn-ArR6BgJaOk6BUzfO97cZMt6gA',
  },
  type: 'librivox',
  label: 'LibriVox',
  requiresCredential: false,
  credentialKind: null,
  /** Spoken word only. LibriVox publishes no ebooks; it links out to the text it read from. */
  mediaKinds: ['audiobook'],
  usesCategories: false,
  seedsBack: false,
  defaultBaseUrl: 'https://librivox.org',
  baseUrlHint: "LibriVox's own address. Leave it as https://librivox.org unless you run a mirror.",

  /**
   * Title only, and one attempt at a time.
   *
   * `title` and `author` together answer 500, so the author cannot narrow the search here and is
   * left to scoring, which weighs it anyway. `title` on its own is an exact match and only `^` gives
   * starts-with, so there is no substring search to fall back on and a prefix that is wrong finds
   * nothing rather than something worse. Hence attempts in order, stopping at the first that
   * matched: the ordinary title costs exactly one request and only a miss pays for another.
   */
  async search(query, config, host, signal) {
    const limit = Math.min(query.limit, MAX_RESULTS);

    for (const title of searchTitles(query.title)) {
      if (signal.aborted) break;

      const books = await call(config, host, { title: `^${title}`, limit: String(limit) });
      if (books.length === 0) continue;

      const releases = [];
      for (const book of books) {
        const release = toRelease(book);
        if (release) releases.push(release);
      }
      if (releases.length > 0) return releases;
    }

    return [];
  },

  /**
   * Asked without a title, so the check does not depend on any one work still being catalogued.
   * The whole feed's first page is as good an answer as a search and costs the same.
   */
  async test(config, host) {
    try {
      const books = await call(config, host, { limit: '1' });
      if (books.length === 0) return { success: false, error: 'That URL answered, but not with a LibriVox catalogue' };
      return { success: true, indexerName: 'LibriVox' };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /**
   * The URL was published by the search, so this costs no request. BookOrbit re-checks the address
   * itself before a download client is pointed at it.
   */
  async resolveFile(release, config, host) {
    const url = safeHttpUrl(release.downloadUrl);
    if (!url) {
      throw host.fail('error', `lists "${release.title}" but published no download for it. Pick another release.`);
    }

    return {
      url,
      fileName: `${sanitizeName(release.bookTitle ?? release.title)}.zip`,
      sizeBytes: release.sizeBytes,
      // The download is a zip of tracks, not a track. Saying so is what makes the picker report the
      // contents as unknown until it is extracted, rather than claim one ready book file.
      format: 'zip',
    };
  },
};

async function call(config, host, params) {
  const base = new URL(config.baseUrl);
  const url = new URL(`${base.pathname.replace(/\/+$/, '')}${SEARCH_PATH}`, base);
  // `extended` is what carries the section list, and with it the readers. It is the difference
  // between nine indistinguishable recordings of one book and nine an approver can choose from.
  url.search = new URLSearchParams({ ...params, format: 'json', extended: '1' }).toString();

  let response;
  try {
    response = await host.fetch(url.href, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'AbortError' || name === 'TimeoutError') throw host.fail('timeout', 'did not answer in time');
    throw host.fail('unreachable', `could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  }

  // A search that matched nothing answers 404, not an empty list. Read as a failure it would put a
  // broken-indexer state in the picker on every request for a book LibriVox has not recorded.
  if (response.status === 404) return [];
  if (response.status === 429) throw host.fail('throttled', 'is rate limiting us');
  if (!response.ok) throw host.fail('error', `answered ${response.status}`);

  let body;
  try {
    body = await response.json();
  } catch {
    throw host.fail('error', 'answered with something that is not a LibriVox catalogue');
  }
  return Array.isArray(body.books) ? body.books : [];
}

/**
 * What to ask LibriVox, in the order worth asking, deduplicated.
 *
 * The article-stripped form leads because LibriVox stores the great majority of its catalogue that
 * way. The title as it stands follows, for the languages it does not strip. The shortened form is
 * last because it is a deliberate broadening, worth a request only once the other two found
 * nothing: "Frankenstein: The 1818 Text" matches no stored title, and "Frankenstein" matches nine.
 */
function searchTitles(rawTitle) {
  const base = stripEditionQualifiers(rawTitle);
  const attempts = [stripLeadingArticle(base), base, stripLeadingArticle(untilFirstSeparator(base))];
  return [...new Set(attempts)].filter((title) => title.length > 0);
}

/**
 * A metadata provider routinely appends an edition qualifier: "Project Hail Mary (Unabridged)". No
 * stored title carries one, and a prefix search against one matches nothing at all. `buildSearchText`
 * cannot be used for this, because it appends the author and LibriVox answers that pairing with 500.
 */
function stripEditionQualifiers(title) {
  const stripped = title
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > 0 ? stripped : title.trim();
}

function stripLeadingArticle(title) {
  const [first, ...rest] = title.split(/\s+/);
  // A title that is only its article is left alone, rather than reduced to nothing.
  if (rest.length === 0 || !LEADING_ARTICLES.has(first.toLowerCase())) return title;
  return rest.join(' ');
}

function untilFirstSeparator(title) {
  const match = TITLE_SEPARATOR.exec(title);
  return match ? title.slice(0, match.index).trim() : title;
}

function toRelease(book) {
  const guid = book.id === undefined || book.id === null ? '' : String(book.id).trim();
  const title = typeof book.title === 'string' ? book.title.trim() : '';
  const downloadUrl = safeHttpUrl(book.url_zip_file);
  const infoUrl = safeHttpUrl(book.url_librivox);
  // A project with no id, no title or no packaged download is not a worse choice, it is not a
  // choice: nothing downstream could grab it.
  if (!guid || !title || !downloadUrl) return null;

  const durationSeconds = toNumber(book.totaltimesecs);
  const chapterCount = toNumber(book.num_sections);
  const language = languageCodeFromName(book.language ?? '');
  const author = authorName(book.authors);
  const readers = namedReaders(book.sections);
  const trackCount = (Array.isArray(book.sections) && book.sections.length) || chapterCount;

  return {
    guid,
    // Decorated the way a tracker decorates a release name, because that is what an approver reads
    // in the picker, and who read it is the one thing separating nine recordings of one book.
    title: readers ? `${title} (${readers})` : title,
    bookTitle: title,
    downloadUrl,
    // The project page lists the readers, the source text and the section list. A host older than
    // the field ignores it.
    ...(infoUrl ? { infoUrl } : {}),
    sizeBytes: durationSeconds === null ? null : Math.round(durationSeconds * BYTES_PER_SECOND),
    // No swarm exists. Null, never zero, or the zero-seeder hard filter drops every release.
    seeders: null,
    leechers: null,
    // What the zip holds, which is what scoring judges. The zip itself is named as a container when
    // the grab resolves it.
    format: 'mp3',
    ...(language ? { language } : {}),
    ...(author ? { author } : {}),
    // Free in the sense the picker means: it costs the requester nothing to take.
    freeleech: true,
    audio: {
      bitrateKbps: BITRATE_KBPS,
      bitrateMode: 'CBR',
      channels: null,
      samplingRateHz: null,
      durationSeconds,
      chapterCount,
    },
    // The section list is a real file list, so this is the strong signal rather than `fileCount`,
    // which would read a 29-track audiobook as a release holding 29 books.
    ...(trackCount ? { primaryFileCount: trackCount } : {}),
  };
}

/**
 * Who read it, as bare names rather than a sentence: the release title is data from a source, and
 * application copy put there would be untranslatable everywhere it is shown.
 *
 * Ordered by how much of the book each one read, so the reader a listener would recognise leads and
 * a project with one reader throughout reads as exactly that.
 */
function namedReaders(sections) {
  const sectionsPerReader = new Map();
  for (const section of Array.isArray(sections) ? sections : []) {
    for (const reader of Array.isArray(section.readers) ? section.readers : []) {
      const name = typeof reader.display_name === 'string' ? reader.display_name.trim() : '';
      if (name) sectionsPerReader.set(name, (sectionsPerReader.get(name) ?? 0) + 1);
    }
  }
  if (sectionsPerReader.size === 0) return null;

  const ordered = [...sectionsPerReader].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
  const named = ordered.slice(0, NAMED_READERS).join(', ');
  return ordered.length > NAMED_READERS ? `${named} +${ordered.length - NAMED_READERS}` : named;
}

function authorName(authors) {
  const author = Array.isArray(authors) ? authors[0] : undefined;
  const name = [author?.first_name, author?.last_name]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join(' ');
  return name || undefined;
}

/**
 * LibriVox publishes the zip URL with a raw space in it, as `.../formats=64KBPS MP3&file=/x.zip`,
 * which some clients reject outright. Normalised here so the encoded form is what is stored and what
 * a download client is eventually handed. The project page goes through the same check.
 */
function safeHttpUrl(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function languageCodeFromName(name) {
  return LANGUAGE_BY_NAME[String(name).trim().toLowerCase()];
}

/** The title reaches a filesystem path, so it is reduced to something a filename can hold. */
function sanitizeName(title) {
  return (
    title
      .replace(/[^\p{L}\p{N}\s.-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'audiobook'
  );
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
