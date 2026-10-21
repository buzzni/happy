#!/usr/bin/env node
/**
 * Minimal stdio MCP server for the real-CLI policy test: one tool, `send_mail`, which appends a
 * line to $FAKE_MCP_MARKER when it actually runs. A missing line means the call never ran.
 */
const fs = require('fs');

let buffer = '';
process.stdin.on('data', (data) => {
    buffer += data;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) handle(JSON.parse(line));
    }
});

function send(message) {
    process.stdout.write(JSON.stringify(message) + '\n');
}

function handle(message) {
    if (message.method === 'initialize') {
        return send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: process.env.FAKE_MCP_NAME || 'fake', version: '1' } } });
    }
    if (message.method === 'tools/list') {
        return send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'send_mail', description: 'Send an email', inputSchema: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] } }] } });
    }
    if (message.method === 'tools/call') {
        fs.appendFileSync(process.env.FAKE_MCP_MARKER, `${process.env.FAKE_MCP_NAME || 'fake'} ${JSON.stringify(message.params.arguments)}\n`);
        return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'mail sent OK' }] } });
    }
    if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: {} });
}
