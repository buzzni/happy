#!/usr/bin/env node
/**
 * Stand-in for cua-driver behind the shadow proxy test. Lists a few real cua-driver tools plus one
 * the policy table does not know, answers `get_window_state` with one element token per pid, and
 * appends `<tool> <args>` to $FAKE_CUA_MARKER for every call that actually reaches it. The tool
 * `crash` exits the process, as a cua-driver crash would.
 */
const fs = require('fs');

const TOOLS = ['get_window_state', 'click', 'type_text', 'list_apps', 'teleport_window', 'crash'];
// Typed like cua-driver's own schemas, so a model sends `pid` as an integer.
const SCHEMA = {
    type: 'object',
    properties: {
        pid: { type: 'integer' },
        window_id: { type: 'integer' },
        element_token: { type: 'string' },
        text: { type: 'string' },
    },
};
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
        return send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-cua', version: '1' } } });
    }
    if (message.method === 'tools/list') {
        return send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS.map((name) => ({ name, inputSchema: SCHEMA, annotations: { readOnlyHint: name === 'get_window_state' } })) } });
    }
    if (message.method === 'tools/call') {
        const { name, arguments: args = {} } = message.params;
        if (process.env.FAKE_CUA_MARKER) fs.appendFileSync(process.env.FAKE_CUA_MARKER, `${name} ${JSON.stringify(args)}\n`);
        if (name === 'crash') process.exit(3);
        if (name === 'get_window_state') {
            return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }], structuredContent: { pid: args.pid, window_id: args.window_id, elements: [{ element_token: `tok-${args.pid}` }] } } });
        }
        return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `${name} done` }] } });
    }
    if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: {} });
}
