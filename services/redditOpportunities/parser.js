/**
 * Parse an F5Bot alert email into Reddit hits.
 *
 * F5Bot's body is plain text: a "Keyword:" line, then one or more matches,
 * each a title line followed by the Reddit URL (comments carry a snippet of
 * the comment text after the link). The exact layout has shifted over the
 * years, so this parser only assumes two things — a reddit.com /comments/
 * URL marks a hit, and the nearest preceding "Keyword:" line names what
 * matched. Everything else (title, excerpt, kind) is best-effort, and the
 * raw block is stored on the row so hits can be re-parsed if F5Bot changes
 * format again.
 *
 * check it by hand: node scripts/parseRedditAlert.js <saved-email.txt>
 */

const URL_RE = /https?:\/\/(?:[a-z]+\.)?reddit\.com\/r\/([\w-]+)\/comments\/([a-z0-9]+)(?:\/[^\s/]*(?:\/([a-z0-9]+))?)?\S*/i;
const KEYWORD_RE = /^\s*keyword:\s*['"“]?(.+?)['"”]?\s*$/i;
// "Reddit Post (r/Cooking):" / "Reddit Comment:" — prefix on F5Bot title lines.
const TITLE_PREFIX_RE = /^\s*reddit\s+(post|comment)\s*(?:\(r\/[\w-]+\))?\s*:\s*/i;

/** Canonical dedup key: scheme/host normalized, query and fragment dropped. */
function canonicalUrl(raw) {
  const m = String(raw).match(URL_RE);
  if (!m) return null;
  const [, subreddit, postId, commentId] = m;
  const base = `https://www.reddit.com/r/${subreddit}/comments/${postId}`;
  return commentId ? `${base}/comment/${commentId}` : `${base}`;
}

function cleanTitle(line) {
  return line
    .replace(TITLE_PREFIX_RE, '')
    .replace(/\s*\(r\/[\w-]+\)\s*:?\s*$/i, '')
    .trim();
}

const isNoise = (line) =>
  !line
  || KEYWORD_RE.test(line)
  || URL_RE.test(line)
  || /^(hello|hi there|f5bot (found|here)|you can|to stop|unsubscribe|manage (your )?keywords|https?:\/\/f5bot\.com)/i.test(line.trim())
  || /^[-=_*]{3,}$/.test(line.trim());

/**
 * @param {string} text plain-text email body
 * @returns {Array<{reddit_url, post_id, comment_id, kind, subreddit, title, excerpt, keyword, raw_block}>}
 */
function parseAlertEmail(text) {
  const lines = String(text || '').split(/\r?\n/);
  const hits = [];
  let keyword = null;

  for (let i = 0; i < lines.length; i++) {
    const kw = lines[i].match(KEYWORD_RE);
    if (kw) { keyword = kw[1].trim(); continue; }

    const url = lines[i].match(URL_RE);
    if (!url) continue;

    const [, subreddit, postId, commentId] = url;
    const reddit_url = canonicalUrl(url[0]);

    // Title: the nearest meaningful line above the URL.
    let title = null;
    let kind = commentId ? 'comment' : 'post';
    for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
      const prev = lines[j].trim();
      if (!prev || KEYWORD_RE.test(prev) || URL_RE.test(prev)) continue;
      const prefix = prev.match(TITLE_PREFIX_RE);
      if (prefix) kind = prefix[1].toLowerCase();
      title = cleanTitle(prev);
      break;
    }

    // Excerpt: text between this URL and the next keyword/URL/blank gap —
    // for comments F5Bot puts the matched snippet here.
    const excerptLines = [];
    for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
      const next = lines[j].trim();
      if (isNoise(lines[j])) break;
      excerptLines.push(next);
    }

    hits.push({
      reddit_url,
      post_id: postId,
      comment_id: commentId || null,
      kind,
      subreddit,
      title: title || null,
      excerpt: excerptLines.join(' ').slice(0, 1000) || null,
      keyword,
      raw_block: lines.slice(Math.max(0, i - 3), i + 6).join('\n').slice(0, 2000),
    });
  }

  // One email can repeat a URL (same post matching two keywords) — keep the first.
  const seen = new Set();
  return hits.filter((h) => h.reddit_url && !seen.has(h.reddit_url) && seen.add(h.reddit_url));
}

module.exports = { parseAlertEmail, canonicalUrl };
