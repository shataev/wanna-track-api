const MAX_TAG_LENGTH = 32;
const MAX_TAGS_PER_COST = 10;

/**
 * A tag as it is stored: trimmed, lowercased, inner whitespace turned into '-',
 * only letters (any script, with their combining marks), digits, '-' and '_' kept,
 * at most 32 characters. null when nothing is left or the value is not a string.
 */
function normalizeTag(value) {
    if (typeof value !== 'string') {
        return null;
    }

    const tag = value
        .normalize('NFC')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^\p{L}\p{M}\p{N}_-]/gu, '');

    if (!tag) {
        return null;
    }

    // By code points, so a character outside the BMP is never cut in half
    return Array.from(tag).slice(0, MAX_TAG_LENGTH).join('');
}

/**
 * The tags of one cost: each normalised, invalid ones dropped, duplicates removed
 * keeping the first occurrence, at most 10.
 */
function normalizeTags(values) {
    const tags = [];

    for (const value of values) {
        const tag = normalizeTag(value);

        if (tag && !tags.includes(tag)) {
            tags.push(tag);
        }
    }

    return tags.slice(0, MAX_TAGS_PER_COST);
}

module.exports = {
    MAX_TAG_LENGTH,
    MAX_TAGS_PER_COST,
    normalizeTag,
    normalizeTags
};
