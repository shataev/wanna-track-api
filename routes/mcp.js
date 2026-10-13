const express = require('express');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { authenticateMcp } = require('../middlewares/authenticateMcp');
const { createMcpServer } = require('../services/mcpServer');

// The MCP endpoint (Streamable HTTP, stateless): a fresh server and transport per request,
// acting as the user of the OAuth access token
const router = express.Router();

const MAX_BODY = '256kb';

const jsonRpcError = (res, status, code, message) => res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });

// The body is read only once the bearer token is valid
const parseBody = (req, res, next) => express.json({ limit: MAX_BODY })(req, res, (error) => {
    if (error) {
        return error.type === 'entity.too.large'
            ? jsonRpcError(res, 413, -32600, `The request must not be larger than ${MAX_BODY}`)
            : jsonRpcError(res, 400, -32700, 'Parse error');
    }

    next();
});

router.all('/mcp', authenticateMcp, parseBody, async (req, res) => {
    // Stateless: there is no session to stream to or to end
    if (req.method !== 'POST') {
        return jsonRpcError(res.set('Allow', 'POST'), 405, -32000, 'Method not allowed.');
    }

    const server = createMcpServer(req.user, req.auth.scopes);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });

    res.on('close', () => {
        transport.close();
        server.close();
    });

    try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    } catch (error) {
        console.error('[mcp] error', error);

        if (!res.headersSent) {
            jsonRpcError(res, 500, -32603, 'Internal server error');
        }
    }
});

module.exports = router;
