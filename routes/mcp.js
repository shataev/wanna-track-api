const express = require('express');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { authenticateMcp } = require('../middlewares/authenticateMcp');
const { createMcpServer } = require('../services/mcpServer');

// The MCP endpoint (Streamable HTTP, stateless): a fresh server and transport per request,
// acting as the user of the OAuth access token
const router = express.Router();

router.all('/mcp', express.json({ limit: '1mb' }), authenticateMcp, async (req, res) => {
    // Stateless: there is no session to stream to or to end
    if (req.method !== 'POST') {
        return res.status(405).set('Allow', 'POST').json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Method not allowed.' },
            id: null
        });
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
            res.status(500).json({
                jsonrpc: '2.0',
                error: { code: -32603, message: 'Internal server error' },
                id: null
            });
        }
    }
});

module.exports = router;
