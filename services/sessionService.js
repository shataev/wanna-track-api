const crypto = require('crypto');
const Session = require('../models/Session');
const { getUserFromDatabaseById, getUserFromRefreshToken } = require('../utils/auth.utils');
const { parseObjectId } = require('../utils/id.utils');

const DAY_MS = 24 * 60 * 60 * 1000;

// Every refresh moves the end of a session to 90 days later, but never past 180 days after sign-in
const SLIDING_LIFETIME_MS = 90 * DAY_MS;
const ABSOLUTE_LIFETIME_MS = 180 * DAY_MS;

// The secret just replaced still gets in for a while: two tabs refreshing at once send the same one, and a
// phone on a bad connection can lose the refresh response and retry minutes later with the old secret
const ROTATION_GRACE_MS = 5 * 60 * 1000;

const USER_AGENT_MAX_LENGTH = 200;

const newSecret = () => crypto.randomBytes(32).toString('base64url');

const hashSecret = (secret) => crypto.createHash('sha256').update(secret).digest('hex');

const isActive = (session, now) =>
    !session.revokedAt && session.expiresAt > now && session.absoluteExpiresAt > now;

const slidingExpiry = (session, now) =>
    new Date(Math.min(now.getTime() + SLIDING_LIFETIME_MS, session.absoluteExpiresAt.getTime()));

// "iPhone · Safari", "Mac · Chrome": enough to tell one's own devices apart
const describeDevice = (userAgent) => {
    const ua = String(userAgent || '');

    const os = /iPhone/.test(ua) ? 'iPhone'
        : /iPad/.test(ua) ? 'iPad'
        : /Android/.test(ua) ? 'Android'
        : /CrOS/.test(ua) ? 'ChromeOS'
        : /Macintosh|Mac OS X/.test(ua) ? 'Mac'
        : /Windows/.test(ua) ? 'Windows'
        : /Linux/.test(ua) ? 'Linux'
        : null;

    // Most browsers name Chrome and Safari as well: the specific ones first
    const browser = /Edg(e|A|iOS)?\//.test(ua) ? 'Edge'
        : /OPR\/|Opera/.test(ua) ? 'Opera'
        : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
        : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
        : /Chrome\/|CriOS/.test(ua) ? 'Chrome'
        : /Safari\//.test(ua) ? 'Safari'
        : null;

    return [os, browser].filter(Boolean).join(' · ') || 'Unknown device';
};

// A new session for a sign-in; the secret goes into the cookie and is never stored
const createSession = async (userId, { userAgent, ip } = {}, { previousHash = null } = {}) => {
    const now = new Date();
    const secret = newSecret();

    const session = await Session.create({
        user: userId,
        tokenHash: hashSecret(secret),
        family: crypto.randomBytes(16).toString('hex'),
        previousHash,
        userAgent: String(userAgent || '').trim().slice(0, USER_AGENT_MAX_LENGTH),
        ip: ip || null,
        lastUsedAt: now,
        expiresAt: new Date(now.getTime() + SLIDING_LIFETIME_MS),
        absoluteExpiresAt: new Date(now.getTime() + ABSOLUTE_LIFETIME_MS)
    });

    return { session, secret };
};

/**
 * Exchanges the refresh cookie for the user, or null when it opens nothing:
 * - the current secret of an active session → rotated: { session, user, secret } with the new secret
 * - the secret just replaced, within the grace → { session, user, secret: null }: the cookie stays as the
 *   concurrent refresh that won the race set it
 * - the secret just replaced, after the grace → somebody holds a copy of it: the session is revoked
 * - a refresh JWT from before sessions existed → a new session, see below
 */
const refreshSession = async (cookieValue, meta) => {
    if (typeof cookieValue !== 'string' || !cookieValue) {
        return null;
    }

    const hash = hashSecret(cookieValue);
    const now = new Date();

    const current = await Session.findOne({ tokenHash: hash });

    if (current) {
        if (!isActive(current, now)) {
            return null;
        }

        const user = await getUserFromDatabaseById(current.user);

        if (!user) {
            return null;
        }

        const secret = newSecret();
        const rotated = await Session.findOneAndUpdate(
            { _id: current._id, tokenHash: hash, revokedAt: null },
            {
                $set: {
                    tokenHash: hashSecret(secret),
                    previousHash: hash,
                    lastUsedAt: now,
                    expiresAt: slidingExpiry(current, now)
                }
            },
            { new: true }
        );

        if (rotated) {
            return { session: rotated, user, secret };
        }

        // A concurrent refresh rotated it in the meantime: the secret is the previous one now
    }

    const rotatedAway = await Session.findOne({ previousHash: hash });

    if (rotatedAway) {
        if (!isActive(rotatedAway, now)) {
            return null;
        }

        if (now.getTime() - rotatedAway.lastUsedAt.getTime() <= ROTATION_GRACE_MS) {
            const user = await getUserFromDatabaseById(rotatedAway.user);

            return user ? { session: rotatedAway, user, secret: null } : null;
        }

        await Session.updateOne({ _id: rotatedAway._id, revokedAt: null }, { $set: { revokedAt: now } });
        console.warn('[sessions] a replaced refresh secret was used again, session revoked', rotatedAway._id.toString());

        return null;
    }

    // Migration (2026-10-13): a cookie set before sessions existed is a refresh JWT living 2 hours. It becomes a
    // session, recorded as that session's previous secret, so it migrates once and is a reuse after the grace.
    // No such JWT is valid two hours after the deploy: remove this branch in the post-trip cleanup
    const legacyUser = await getUserFromRefreshToken(cookieValue);

    if (!legacyUser) {
        return null;
    }

    const { session, secret } = await createSession(legacyUser.id, meta, { previousHash: hash });

    return { session, user: legacyUser, secret };
};

// Who the refresh cookie names, without rotating it: the legacy cookie fallback of authenticate
const findSessionUser = async (cookieValue) => {
    if (typeof cookieValue !== 'string' || !cookieValue) {
        return null;
    }

    const session = await Session.findOne({ tokenHash: hashSecret(cookieValue) });

    if (session) {
        if (!isActive(session, new Date())) {
            return null;
        }

        const user = await getUserFromDatabaseById(session.user);

        return user ? { user, sessionId: session._id.toString() } : null;
    }

    // Migration (2026-10-13): a refresh JWT from before sessions; remove with the branch in refreshSession
    const legacyUser = await getUserFromRefreshToken(cookieValue);

    return legacyUser ? { user: legacyUser, sessionId: null } : null;
};

// Sign-out: ends the session the cookie belongs to, whether it holds the current secret or the one before
const revokeByCookie = async (cookieValue) => {
    if (typeof cookieValue !== 'string' || !cookieValue) {
        return;
    }

    const hash = hashSecret(cookieValue);

    await Session.updateOne(
        { $or: [{ tokenHash: hash }, { previousHash: hash }], revokedAt: null },
        { $set: { revokedAt: new Date() } }
    );
};

// The user's sessions that can still be used: the current one first, then the most recently used
const listSessions = async (userId, currentSessionId) => {
    const now = new Date();
    const sessions = await Session.find({
        user: userId,
        revokedAt: null,
        expiresAt: { $gt: now },
        absoluteExpiresAt: { $gt: now }
    }).lean();

    return sessions
        .map(session => ({
            id: session._id.toString(),
            current: session._id.toString() === currentSessionId,
            device: describeDevice(session.userAgent),
            createdAt: session.createdAt,
            lastUsedAt: session.lastUsedAt,
            expiresAt: session.expiresAt
        }))
        .sort((a, b) => (b.current - a.current) || (b.lastUsedAt - a.lastUsedAt));
};

// Whether one of the user's own active sessions was revoked; anybody else's id or a malformed one is false
const revokeSession = async (userId, sessionId) => {
    const id = parseObjectId(sessionId);

    if (!id) {
        return false;
    }

    const { matchedCount } = await Session.updateOne(
        { _id: id, user: userId, revokedAt: null },
        { $set: { revokedAt: new Date() } }
    );

    return matchedCount === 1;
};

const revokeOtherSessions = async (userId, currentSessionId) => {
    const { modifiedCount } = await Session.updateMany(
        { user: userId, _id: { $ne: parseObjectId(currentSessionId) }, revokedAt: null },
        { $set: { revokedAt: new Date() } }
    );

    return modifiedCount;
};

module.exports = {
    SLIDING_LIFETIME_MS,
    ABSOLUTE_LIFETIME_MS,
    ROTATION_GRACE_MS,
    hashSecret,
    describeDevice,
    createSession,
    refreshSession,
    findSessionUser,
    revokeByCookie,
    listSessions,
    revokeSession,
    revokeOtherSessions
};
