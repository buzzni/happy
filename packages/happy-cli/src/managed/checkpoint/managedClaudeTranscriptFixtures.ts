/**
 * The pinned Linux seed records, as a **selected projection**.
 *
 * Not the whole transcript and not byte-identical to it. Every field the
 * derivation reads is carried through unchanged - record `type`s,
 * `uuid`/`parentUuid`/`sessionId`, `isSidechain`/`agentId`, the `Agent`
 * `tool_use` and its `tool_result`, `sourceToolAssistantUUID`, and
 * `toolUseResult.{agentId, persistedOutputPath, persistedOutputSize}`, and each
 * `tool_use.input`'s **keys and flag values** (`run_in_background: false`,
 * `subagent_type`) - while prompt text, replies, attachment bodies, commands and
 * tool output become `[redacted]`.
 *
 * Measured, so the limit is stated rather than implied: the projection drops
 * `queue-operation.operation`, `queue-operation.content`, `user.promptId`,
 * `user.promptSource`, `user.permissionMode`, `assistant.apiBlockIndex`,
 * `assistant.perTurnEffort`, `atis-latch.atis`, `attachment.rendered`,
 * `last-prompt.lastPrompt` and `last-prompt.leafUuid`. None is read by the
 * derivation, and none of them can be cited as evidence about it either.
 *
 * Its own file because a test that invents record shapes tests the invention:
 * the guessed type set this module replaced admitted `summary`, which no
 * fixture contains, and refused `queue-operation`, `atis-latch` and
 * `last-prompt`, which every one of them contains.
 *
 * Source: `/tmp/pr3557-op2-resume-probe3` (image `sha256:2620ac92...`, CLI
 * 2.1.268) and `/tmp/pr3557-op2-tool-artifact`, both hash-pinned. Root has
 * separately run the derivation against the **raw, unredacted** seed with the
 * same results for both positive cases.
 */
import type { ClaudeTranscriptRecord } from './managedClaudeTranscriptDerivation';

/** `home-seed/.claude/projects/-fixture-work/<id>.jsonl` - one `Agent` call. */
export const PINNED_PARENT_WITH_AGENT = [
    {
        "type": "queue-operation",
        "timestamp": "2026-09-11T03:08:19.732Z",
        "sessionId": "330a1f93-cda9-4080-89a3-c780c9ade479"
    },
    {
        "type": "queue-operation",
        "timestamp": "2026-09-11T03:08:19.732Z",
        "sessionId": "330a1f93-cda9-4080-89a3-c780c9ade479"
    },
    {
        "parentUuid": null,
        "isSidechain": false,
        "type": "user",
        "uuid": "255410cd-c548-4bdc-8f4d-1248f33d2972",
        "timestamp": "2026-09-11T03:08:19.748Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "330a1f93-cda9-4080-89a3-c780c9ade479",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "message": {
            "role": "user",
            "content": "[redacted]"
        }
    },
    {
        "parentUuid": "255410cd-c548-4bdc-8f4d-1248f33d2972",
        "isSidechain": false,
        "type": "attachment",
        "uuid": "1dc43464-d5b8-49f8-8b75-998028f5827d",
        "timestamp": "2026-09-11T03:08:19.747Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "330a1f93-cda9-4080-89a3-c780c9ade479",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "attachment": {
            "redacted": true
        }
    },
    {
        "parentUuid": "1dc43464-d5b8-49f8-8b75-998028f5827d",
        "isSidechain": false,
        "type": "attachment",
        "uuid": "ce968a45-e3bb-4bd3-b0aa-58acea1782cc",
        "timestamp": "2026-09-11T03:08:19.747Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "330a1f93-cda9-4080-89a3-c780c9ade479",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "attachment": {
            "redacted": true
        }
    },
    {
        "parentUuid": "ce968a45-e3bb-4bd3-b0aa-58acea1782cc",
        "isSidechain": false,
        "type": "attachment",
        "uuid": "9dad7dbb-f7d4-43cc-b877-2178d2fba349",
        "timestamp": "2026-09-11T03:08:19.747Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "330a1f93-cda9-4080-89a3-c780c9ade479",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "attachment": {
            "redacted": true
        }
    },
    {
        "parentUuid": "9dad7dbb-f7d4-43cc-b877-2178d2fba349",
        "isSidechain": false,
        "type": "attachment",
        "uuid": "f2b08574-55a1-4c23-9fbb-1822fe846fee",
        "timestamp": "2026-09-11T03:08:19.747Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "330a1f93-cda9-4080-89a3-c780c9ade479",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "attachment": {
            "redacted": true
        }
    },
    {
        "parentUuid": "f2b08574-55a1-4c23-9fbb-1822fe846fee",
        "isSidechain": false,
        "type": "attachment",
        "uuid": "e30bdef8-dfea-41f1-b2d3-7daab6ea305d",
        "timestamp": "2026-09-11T03:08:19.747Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "330a1f93-cda9-4080-89a3-c780c9ade479",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "attachment": {
            "redacted": true
        }
    },
    {
        "type": "atis-latch",
        "sessionId": "330a1f93-cda9-4080-89a3-c780c9ade479"
    },
    {
        "parentUuid": "e30bdef8-dfea-41f1-b2d3-7daab6ea305d",
        "isSidechain": false,
        "type": "attachment",
        "uuid": "777a55a8-c742-430d-aee8-fabce6749027",
        "timestamp": "2026-09-11T03:08:19.754Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "330a1f93-cda9-4080-89a3-c780c9ade479",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "attachment": {
            "redacted": true
        }
    },
    {
        "parentUuid": "777a55a8-c742-430d-aee8-fabce6749027",
        "isSidechain": false,
        "type": "attachment",
        "uuid": "61ceb716-41d4-4856-88bf-739d73229597",
        "timestamp": "2026-09-11T03:08:19.754Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "330a1f93-cda9-4080-89a3-c780c9ade479",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "attachment": {
            "redacted": true
        }
    },
    {
        "parentUuid": "61ceb716-41d4-4856-88bf-739d73229597",
        "isSidechain": false,
        "type": "attachment",
        "uuid": "8b16f5c0-97ec-409e-b2a6-a2c8fdc208c2",
        "timestamp": "2026-09-11T03:08:19.754Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "330a1f93-cda9-4080-89a3-c780c9ade479",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "attachment": {
            "redacted": true
        }
    },
    {
        "parentUuid": "8b16f5c0-97ec-409e-b2a6-a2c8fdc208c2",
        "isSidechain": false,
        "type": "assistant",
        "uuid": "a8a65a11-72f4-46e5-86d3-ffd76469b66f",
        "timestamp": "2026-09-11T03:08:19.772Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "330a1f93-cda9-4080-89a3-c780c9ade479",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "message": {
            "role": "assistant",
            "content": [
                {
                    "type": "tool_use",
                    "id": "toolu_agent_1",
                    "name": "Agent",
                    "input": {
                        "description": "[redacted]",
                        "prompt": "[redacted]",
                        "subagent_type": "general-purpose",
                        "run_in_background": false
                    }
                }
            ]
        }
    },
    {
        "parentUuid": "a8a65a11-72f4-46e5-86d3-ffd76469b66f",
        "isSidechain": false,
        "type": "user",
        "uuid": "b2ce9716-dd13-45b5-aad7-9199cceaa500",
        "timestamp": "2026-09-11T03:08:19.802Z",
        "toolUseResult": {
            "status": "completed",
            "agentId": "a4ec78d2c4e3608ba",
            "agentType": "general-purpose"
        },
        "sourceToolAssistantUUID": "a8a65a11-72f4-46e5-86d3-ffd76469b66f",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "330a1f93-cda9-4080-89a3-c780c9ade479",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "message": {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "toolu_agent_1",
                    "content": "[redacted]"
                }
            ]
        }
    },
    {
        "parentUuid": "b2ce9716-dd13-45b5-aad7-9199cceaa500",
        "isSidechain": false,
        "type": "attachment",
        "uuid": "ccf5a725-d802-4547-870c-74c9af55332b",
        "timestamp": "2026-09-11T03:08:19.803Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "330a1f93-cda9-4080-89a3-c780c9ade479",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "attachment": {
            "redacted": true
        }
    },
    {
        "parentUuid": "ccf5a725-d802-4547-870c-74c9af55332b",
        "isSidechain": false,
        "type": "attachment",
        "uuid": "a30e0b38-9b82-4e06-b32b-b2ffcdc6814a",
        "timestamp": "2026-09-11T03:08:19.803Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "330a1f93-cda9-4080-89a3-c780c9ade479",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "attachment": {
            "redacted": true
        }
    },
    {
        "parentUuid": "a30e0b38-9b82-4e06-b32b-b2ffcdc6814a",
        "isSidechain": false,
        "type": "assistant",
        "uuid": "93a63013-6b76-453f-8a4b-175ef2c85382",
        "timestamp": "2026-09-11T03:08:19.810Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "330a1f93-cda9-4080-89a3-c780c9ade479",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "message": {
            "role": "assistant",
            "content": [
                {
                    "type": "text",
                    "text": "[redacted]"
                }
            ]
        }
    },
    {
        "type": "last-prompt",
        "sessionId": "330a1f93-cda9-4080-89a3-c780c9ade479"
    },
    {
        "type": "atis-latch",
        "sessionId": "330a1f93-cda9-4080-89a3-c780c9ade479"
    }
] as unknown as ClaudeTranscriptRecord[];

/** `<id>/subagents/agent-a4ec78d2c4e3608ba.jsonl`. */
export const PINNED_CHILD = [
    {
        "parentUuid": null,
        "isSidechain": true,
        "agentId": "a4ec78d2c4e3608ba",
        "type": "user",
        "uuid": "bccf00c8-1caf-4920-817d-28011a666b88",
        "timestamp": "2026-09-11T03:08:19.775Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "330a1f93-cda9-4080-89a3-c780c9ade479",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "message": {
            "role": "user",
            "content": "[redacted]"
        }
    },
    {
        "parentUuid": "bccf00c8-1caf-4920-817d-28011a666b88",
        "isSidechain": true,
        "agentId": "a4ec78d2c4e3608ba",
        "type": "attachment",
        "uuid": "1640b4f8-2b2f-4f52-b62d-d687e83ffb59",
        "timestamp": "2026-09-11T03:08:19.778Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "330a1f93-cda9-4080-89a3-c780c9ade479",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "attachment": {
            "redacted": true
        }
    },
    {
        "parentUuid": "1640b4f8-2b2f-4f52-b62d-d687e83ffb59",
        "isSidechain": true,
        "agentId": "a4ec78d2c4e3608ba",
        "type": "attachment",
        "uuid": "ea278df1-c69b-4cb7-a4a8-da13d4776f55",
        "timestamp": "2026-09-11T03:08:19.778Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "330a1f93-cda9-4080-89a3-c780c9ade479",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "attachment": {
            "redacted": true
        }
    },
    {
        "parentUuid": "ea278df1-c69b-4cb7-a4a8-da13d4776f55",
        "isSidechain": true,
        "agentId": "a4ec78d2c4e3608ba",
        "type": "attachment",
        "uuid": "00785fea-71c1-4bff-98b5-99a3ad674e0e",
        "timestamp": "2026-09-11T03:08:19.778Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "330a1f93-cda9-4080-89a3-c780c9ade479",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "attachment": {
            "redacted": true
        }
    },
    {
        "parentUuid": "00785fea-71c1-4bff-98b5-99a3ad674e0e",
        "isSidechain": true,
        "agentId": "a4ec78d2c4e3608ba",
        "type": "attachment",
        "uuid": "723c8fe3-bef5-4893-9f6f-297534218608",
        "timestamp": "2026-09-11T03:08:19.779Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "330a1f93-cda9-4080-89a3-c780c9ade479",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "attachment": {
            "redacted": true
        }
    },
    {
        "parentUuid": "723c8fe3-bef5-4893-9f6f-297534218608",
        "isSidechain": true,
        "agentId": "a4ec78d2c4e3608ba",
        "type": "attachment",
        "uuid": "0a8e129d-dfa8-4d70-9a34-1018825e6243",
        "timestamp": "2026-09-11T03:08:19.779Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "330a1f93-cda9-4080-89a3-c780c9ade479",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "attachment": {
            "redacted": true
        }
    },
    {
        "parentUuid": "0a8e129d-dfa8-4d70-9a34-1018825e6243",
        "isSidechain": true,
        "agentId": "a4ec78d2c4e3608ba",
        "type": "attachment",
        "uuid": "9ce9660d-f121-4a34-ba97-1542697b5921",
        "timestamp": "2026-09-11T03:08:19.780Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "330a1f93-cda9-4080-89a3-c780c9ade479",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "attachment": {
            "redacted": true
        }
    },
    {
        "parentUuid": "9ce9660d-f121-4a34-ba97-1542697b5921",
        "isSidechain": true,
        "agentId": "a4ec78d2c4e3608ba",
        "type": "assistant",
        "uuid": "e103dd76-9100-4258-98ae-92b87bccc83a",
        "timestamp": "2026-09-11T03:08:19.786Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "330a1f93-cda9-4080-89a3-c780c9ade479",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "message": {
            "role": "assistant",
            "content": [
                {
                    "type": "text",
                    "text": "[redacted]"
                }
            ]
        }
    },
    {
        "parentUuid": "e103dd76-9100-4258-98ae-92b87bccc83a",
        "isSidechain": true,
        "agentId": "a4ec78d2c4e3608ba",
        "type": "attachment",
        "uuid": "a0a6f61f-0bb6-47de-a76c-b61cacd57532",
        "timestamp": "2026-09-11T03:08:19.787Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "330a1f93-cda9-4080-89a3-c780c9ade479",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "attachment": {
            "redacted": true
        }
    }
] as unknown as ClaudeTranscriptRecord[];

/** `<id>/subagents/agent-a4ec78d2c4e3608ba.meta.json`, verbatim. */
export const PINNED_CHILD_META = {
    "agentType": "general-purpose",
    "description": "probe subagent",
    "toolUseId": "toolu_agent_1",
    "spawnDepth": 1,
    "requestShape": "foreground",
    "requestNonInteractive": true
};

/** The tool-artifact seed: a `Bash` call whose output was persisted to a file. */
export const PINNED_PARENT_WITH_ARTIFACTS = [
    {
        "type": "queue-operation",
        "timestamp": "2026-09-11T03:11:37.943Z",
        "sessionId": "d6da1867-afd5-4637-bd7e-52a3e28c2fb8"
    },
    {
        "type": "queue-operation",
        "timestamp": "2026-09-11T03:11:37.944Z",
        "sessionId": "d6da1867-afd5-4637-bd7e-52a3e28c2fb8"
    },
    {
        "parentUuid": null,
        "isSidechain": false,
        "type": "user",
        "uuid": "c70ddd1d-d945-4336-8045-479ad7db223c",
        "timestamp": "2026-09-11T03:11:37.960Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "d6da1867-afd5-4637-bd7e-52a3e28c2fb8",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "message": {
            "role": "user",
            "content": "[redacted]"
        }
    },
    {
        "parentUuid": "c70ddd1d-d945-4336-8045-479ad7db223c",
        "isSidechain": false,
        "type": "attachment",
        "uuid": "c2d80d2c-20fd-4d7f-bf82-12abfedfba80",
        "timestamp": "2026-09-11T03:11:37.959Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "d6da1867-afd5-4637-bd7e-52a3e28c2fb8",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "attachment": {
            "redacted": true
        }
    },
    {
        "parentUuid": "c2d80d2c-20fd-4d7f-bf82-12abfedfba80",
        "isSidechain": false,
        "type": "attachment",
        "uuid": "167c21df-6fb2-43cf-9e33-19ac270f3c70",
        "timestamp": "2026-09-11T03:11:37.959Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "d6da1867-afd5-4637-bd7e-52a3e28c2fb8",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "attachment": {
            "redacted": true
        }
    },
    {
        "parentUuid": "167c21df-6fb2-43cf-9e33-19ac270f3c70",
        "isSidechain": false,
        "type": "attachment",
        "uuid": "0d7f1815-967a-48cf-8812-890dfc90f218",
        "timestamp": "2026-09-11T03:11:37.959Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "d6da1867-afd5-4637-bd7e-52a3e28c2fb8",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "attachment": {
            "redacted": true
        }
    },
    {
        "parentUuid": "0d7f1815-967a-48cf-8812-890dfc90f218",
        "isSidechain": false,
        "type": "attachment",
        "uuid": "38e4c1ab-e3b1-44f5-8479-ffbce62701a7",
        "timestamp": "2026-09-11T03:11:37.959Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "d6da1867-afd5-4637-bd7e-52a3e28c2fb8",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "attachment": {
            "redacted": true
        }
    },
    {
        "parentUuid": "38e4c1ab-e3b1-44f5-8479-ffbce62701a7",
        "isSidechain": false,
        "type": "attachment",
        "uuid": "f7541a0f-cf87-4801-b61c-27a8e50e741a",
        "timestamp": "2026-09-11T03:11:37.959Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "d6da1867-afd5-4637-bd7e-52a3e28c2fb8",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "attachment": {
            "redacted": true
        }
    },
    {
        "type": "atis-latch",
        "sessionId": "d6da1867-afd5-4637-bd7e-52a3e28c2fb8"
    },
    {
        "parentUuid": "f7541a0f-cf87-4801-b61c-27a8e50e741a",
        "isSidechain": false,
        "type": "attachment",
        "uuid": "48cb6973-70c7-4961-b33a-2069d502775e",
        "timestamp": "2026-09-11T03:11:37.966Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "d6da1867-afd5-4637-bd7e-52a3e28c2fb8",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "attachment": {
            "redacted": true
        }
    },
    {
        "parentUuid": "48cb6973-70c7-4961-b33a-2069d502775e",
        "isSidechain": false,
        "type": "attachment",
        "uuid": "2db26b86-8ab0-417b-92e1-55a378f278f2",
        "timestamp": "2026-09-11T03:11:37.967Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "d6da1867-afd5-4637-bd7e-52a3e28c2fb8",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "attachment": {
            "redacted": true
        }
    },
    {
        "parentUuid": "2db26b86-8ab0-417b-92e1-55a378f278f2",
        "isSidechain": false,
        "type": "attachment",
        "uuid": "d4f437fe-9312-4c80-ad1a-cdbd92580f27",
        "timestamp": "2026-09-11T03:11:37.967Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "d6da1867-afd5-4637-bd7e-52a3e28c2fb8",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "attachment": {
            "redacted": true
        }
    },
    {
        "parentUuid": "d4f437fe-9312-4c80-ad1a-cdbd92580f27",
        "isSidechain": false,
        "type": "assistant",
        "uuid": "c1d45d01-3cdd-46b6-b643-d7a9ae70f81a",
        "timestamp": "2026-09-11T03:11:37.984Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "d6da1867-afd5-4637-bd7e-52a3e28c2fb8",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "message": {
            "role": "assistant",
            "content": [
                {
                    "type": "tool_use",
                    "id": "toolu_big_1",
                    "name": "Bash",
                    "input": {
                        "command": "[redacted]",
                        "description": "[redacted]"
                    }
                }
            ]
        }
    },
    {
        "parentUuid": "c1d45d01-3cdd-46b6-b643-d7a9ae70f81a",
        "isSidechain": false,
        "type": "user",
        "uuid": "8ead035b-3f63-4aaa-b25d-cad8583d3dae",
        "timestamp": "2026-09-11T03:11:38.024Z",
        "toolUseResult": {
            "interrupted": false,
            "isImage": false,
            "noOutputExpected": false,
            "persistedOutputPath": "/fixture/home/.claude/projects/-fixture-work/d6da1867-afd5-4637-bd7e-52a3e28c2fb8/tool-results/bwmc1gbmg.txt",
            "persistedOutputSize": 214893
        },
        "sourceToolAssistantUUID": "c1d45d01-3cdd-46b6-b643-d7a9ae70f81a",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "d6da1867-afd5-4637-bd7e-52a3e28c2fb8",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "message": {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "toolu_big_1",
                    "content": "[redacted]"
                }
            ]
        }
    },
    {
        "parentUuid": "8ead035b-3f63-4aaa-b25d-cad8583d3dae",
        "isSidechain": false,
        "type": "attachment",
        "uuid": "278ff32b-6144-4010-b32f-ef3c6ccdf47d",
        "timestamp": "2026-09-11T03:11:38.025Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "d6da1867-afd5-4637-bd7e-52a3e28c2fb8",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "attachment": {
            "redacted": true
        }
    },
    {
        "parentUuid": "278ff32b-6144-4010-b32f-ef3c6ccdf47d",
        "isSidechain": false,
        "type": "attachment",
        "uuid": "a7fe3b01-a689-4422-b5b8-cc25833a1a75",
        "timestamp": "2026-09-11T03:11:38.026Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "d6da1867-afd5-4637-bd7e-52a3e28c2fb8",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "attachment": {
            "redacted": true
        }
    },
    {
        "parentUuid": "a7fe3b01-a689-4422-b5b8-cc25833a1a75",
        "isSidechain": false,
        "type": "assistant",
        "uuid": "dfd907a0-cb9d-4fea-98a6-e9da39ccc493",
        "timestamp": "2026-09-11T03:11:38.032Z",
        "userType": "external",
        "entrypoint": "sdk-cli",
        "cwd": "/fixture/work",
        "sessionId": "d6da1867-afd5-4637-bd7e-52a3e28c2fb8",
        "version": "2.1.268",
        "gitBranch": "HEAD",
        "message": {
            "role": "assistant",
            "content": [
                {
                    "type": "text",
                    "text": "[redacted]"
                }
            ]
        }
    },
    {
        "type": "last-prompt",
        "sessionId": "d6da1867-afd5-4637-bd7e-52a3e28c2fb8"
    },
    {
        "type": "atis-latch",
        "sessionId": "d6da1867-afd5-4637-bd7e-52a3e28c2fb8"
    }
] as unknown as ClaudeTranscriptRecord[];
