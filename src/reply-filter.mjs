// Emoji can span several code points (UTS #51): https://www.unicode.org/reports/tr51/
// Grapheme segmentation keeps flags, modifiers, keycaps and ZWJ sequences whole.
const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });
const emoji = /^(?:[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}]|[0-9#*][\uFE0E\uFE0F]?\u20E3)/u;
// An orphan skin-tone modifier can attach to an ordinary letter's grapheme.
// Preserve that letter rather than deleting the entire cluster.
const clean = segment => emoji.test(segment) ? '' : segment.replace(/\p{Emoji_Modifier}[\uFE0E\uFE0F]*/gu, '');

export function filterAIReply(text, config, { partial = false } = {}) {
  if (config.ai.stripEmoji === false) return text;
  let result = '', previous;
  for (const item of graphemes.segment(text)) {
    if (previous !== undefined) result += clean(previous);
    previous = item.segment;
  }
  // A trailing keycap base or high surrogate may become an emoji in the next delta:
  // e.g. "1" + "\uFE0F\u20E3", or half of a UTF-16 surrogate pair.
  const pending = partial && previous !== undefined && (/^[0-9#*]/u.test(previous) || /[\uD800-\uDBFF]$/u.test(previous));
  if (!pending && previous !== undefined) result += clean(previous);
  return result;
}
