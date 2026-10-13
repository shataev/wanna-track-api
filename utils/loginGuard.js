// Brute-force guard for the OAuth sign-in form: at most 10 failed attempts per IP and per email
// in 15 minutes. In memory: the API runs as a single process
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const SWEEP_SIZE = 10000;

const failures = new Map();

const recent = (key, now) => (failures.get(key) || []).filter(time => now - time < WINDOW_MS);

const keysFor = (ip, email) => [`ip:${ip}`, `email:${String(email).trim().toLowerCase()}`];

const isLocked = (ip, email, now = Date.now()) =>
    keysFor(ip, email).some(key => recent(key, now).length >= MAX_FAILURES);

const recordFailure = (ip, email, now = Date.now()) => {
    if (failures.size > SWEEP_SIZE) {
        for (const key of failures.keys()) {
            if (recent(key, now).length === 0) {
                failures.delete(key);
            }
        }
    }

    for (const key of keysFor(ip, email)) {
        failures.set(key, [...recent(key, now), now]);
    }
};

const reset = () => failures.clear();

module.exports = { isLocked, recordFailure, reset, MAX_FAILURES };
