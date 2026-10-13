// The pages of the OAuth authorization step: sign in, consent, and an error page.
// Server-rendered on the API host in the site's colours, phone first. Every value is escaped.

const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// The authorization request travels with every form, so the SDK's handler validates it again on each POST
const AUTHORIZATION_FIELDS = [
    'response_type',
    'client_id',
    'redirect_uri',
    'code_challenge',
    'code_challenge_method',
    'scope',
    'state',
    'resource'
];

const hiddenFields = (params) => AUTHORIZATION_FIELDS
    .filter(name => typeof params[name] === 'string')
    .map(name => `<input type="hidden" name="${name}" value="${escapeHtml(params[name])}">`)
    .join('\n');

const STYLE = `
    * { box-sizing: border-box; }
    body {
        margin: 0;
        min-height: 100vh;
        font-family: Roboto, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        background: linear-gradient(180deg, #AFC97E 0%, #5F5B53 100%);
        color: #5F5B53;
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding: 32px 16px;
    }
    main {
        width: 100%;
        max-width: 420px;
        background: #F6FDEB;
        border-radius: 16px;
        padding: 24px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
    }
    h1 { font-size: 22px; margin: 0 0 8px; }
    p { line-height: 1.5; margin: 0 0 16px; }
    label { display: block; font-size: 14px; margin-bottom: 4px; }
    input[type=email], input[type=password] {
        width: 100%;
        font-size: 16px;
        padding: 12px;
        border: 1px solid #A7C76C;
        border-radius: 8px;
        background: #fff;
        margin-bottom: 16px;
    }
    .check { display: flex; gap: 10px; align-items: flex-start; margin-bottom: 20px; }
    .check input { width: 20px; height: 20px; margin: 2px 0 0; flex: none; }
    .check label { font-size: 16px; margin: 0; }
    button {
        width: 100%;
        font-size: 16px;
        font-weight: 500;
        padding: 12px;
        border: 0;
        border-radius: 8px;
        cursor: pointer;
        margin-bottom: 8px;
    }
    .primary { background: #FFDA4D; color: #5F5B53; }
    .secondary { background: transparent; color: #5F5B53; border: 1px solid #A7C76C; }
    .error { background: #fde2e2; color: #8a1f1f; border-radius: 8px; padding: 10px 12px; }
    .note { font-size: 14px; }
    .host { font-weight: 700; word-break: break-all; }
`;

const page = (title, body) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} · Wanna Track</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;

const clientLabel = (client) => client.client_name || 'An application';

const signInPage = ({ client, params, error, email }) => page('Sign in', `
<h1>Sign in to Wanna Track</h1>
<p><strong>${escapeHtml(clientLabel(client))}</strong> wants to connect to your Wanna Track account.</p>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="">
${hiddenFields(params)}
<input type="hidden" name="step" value="signin">
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(email)}">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<button class="primary" type="submit">Sign in</button>
</form>
`);

const consentPage = ({ client, params, nonce, redirectHost, isLoopback, offerWrite, username }) => page('Allow access', `
<h1>Allow ${escapeHtml(clientLabel(client))}?</h1>
<p>Signed in as <strong>${escapeHtml(username)}</strong>.</p>
<p><strong>${escapeHtml(clientLabel(client))}</strong> will be able to read your expenses, accounts, categories and tags.</p>
<p class="note">After you allow it, you are sent to <span class="host">${escapeHtml(redirectHost)}</span>.</p>
${isLoopback ? '<p class="note error">This address is on your own computer. Continue only if you started connecting from Claude Code on this machine.</p>' : ''}
<form method="post" action="">
${hiddenFields(params)}
<input type="hidden" name="step" value="consent">
<input type="hidden" name="nonce" value="${escapeHtml(nonce)}">
${offerWrite ? `<div class="check">
<input id="allow_write" name="allow_write" type="checkbox" value="on">
<label for="allow_write">Allow adding expenses and changing the active tag</label>
</div>` : ''}
<button class="primary" type="submit" name="decision" value="allow">Allow</button>
<button class="secondary" type="submit" name="decision" value="deny">Cancel</button>
</form>
`);

const errorPage = (message) => page('Something went wrong', `
<h1>Something went wrong</h1>
<p class="error" role="alert">${escapeHtml(message)}</p>
<p>Start connecting again from Claude.</p>
`);

module.exports = { escapeHtml, signInPage, consentPage, errorPage };
