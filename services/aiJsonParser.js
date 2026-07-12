/**
 * Tolerant JSON parsing for AI model output.
 *
 * Models occasionally emit almost-JSON: markdown code fences, // or block
 * comments ("Lemon-Pepper Seasoning", // Assuming this is a blend...), or
 * trailing commas — all of which JSON.parse rejects. This helper strips the
 * noise (string-aware, so content inside quoted values is never touched)
 * and retries.
 */

/**
 * Remove // line comments, block comments, and trailing commas that sit
 * OUTSIDE string literals. Tracks in-string state and escape sequences.
 */
function sanitizeJsonLike(text) {
  let out = '';
  let inString = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (inString) {
      out += ch;
      if (ch === '\\') {
        // Copy the escaped character verbatim so \" doesn't end the string
        if (i + 1 < text.length) {
          out += text[i + 1];
          i += 2;
          continue;
        }
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }

    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    out += ch;
    i++;
  }

  // Trailing commas: `, }` / `, ]` (whitespace-tolerant), outside strings.
  // Re-scan the comment-free output with the same string tracking.
  let result = '';
  inString = false;
  for (let j = 0; j < out.length; j++) {
    const ch = out[j];
    if (inString) {
      result += ch;
      if (ch === '\\' && j + 1 < out.length) {
        result += out[j + 1];
        j++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }
    if (ch === ',') {
      let k = j + 1;
      while (k < out.length && /\s/.test(out[k])) k++;
      if (out[k] === '}' || out[k] === ']') continue; // drop trailing comma
    }
    result += ch;
  }

  return result;
}

/**
 * Parse JSON from raw AI output. Strips code fences, extracts the outermost
 * object, and falls back to comment/trailing-comma sanitization.
 * Throws the original parse error if the content is still unparseable.
 */
function parseAIJson(content) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('Empty AI response');
  }

  let text = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON found in response');
  }
  text = text.slice(start, end + 1);

  try {
    return JSON.parse(text);
  } catch (originalError) {
    try {
      return JSON.parse(sanitizeJsonLike(text));
    } catch (_) {
      throw originalError;
    }
  }
}

module.exports = { parseAIJson };
