import { z } from "zod";
import { Fastify } from "../types";
import { Context } from "@/context";
import { workspaceCreate } from "@/app/project/workspaceCreate";
import { workspaceList } from "@/app/project/workspaceList";
import { workspaceUpdateStatus } from "@/app/project/workspaceUpdateStatus";
import { workspaceDelete } from "@/app/project/workspaceDelete";
import { ProjectError } from "@/app/project/types";

export function workspaceRoutes(app: Fastify) {

    app.post('/v1/projects/:id/workspaces', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
            body: z.object({
                name: z.string(),
                branchName: z.string()
            })
        }
    }, async (request, reply) => {
        const ctx = Context.create(request.userId);
        const result = await workspaceCreate(ctx, request.params.id, request.body);
        if (!result.ok) {
            return reply.code(errorToStatus(result.error)).send({ error: result.error });
        }
        return reply.send({ workspace: formatWorkspace(result.value) });
    });

    app.get('/v1/projects/:id/workspaces', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() })
        }
    }, async (request, reply) => {
        const ctx = Context.create(request.userId);
        const result = await workspaceList(ctx, request.params.id);
        if (!result.ok) {
            return reply.code(errorToStatus(result.error)).send({ error: result.error });
        }
        return reply.send({ workspaces: result.value });
    });

    app.post('/v1/workspaces/:id/status', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
            body: z.object({
                status: z.enum(['active', 'merged', 'closed'])
            })
        }
    }, async (request, reply) => {
        const ctx = Context.create(request.userId);
        const result = await workspaceUpdateStatus(ctx, request.params.id, request.body.status);
        if (!result.ok) {
            return reply.code(errorToStatus(result.error)).send({ error: result.error });
        }
        return reply.send(result.value);
    });

    app.delete('/v1/workspaces/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() })
        }
    }, async (request, reply) => {
        const ctx = Context.create(request.userId);
        const result = await workspaceDelete(ctx, request.params.id);
        if (!result.ok) {
            return reply.code(errorToStatus(result.error)).send({ error: result.error });
        }
        return reply.send(result.value);
    });
}

function formatWorkspace(ws: {
    id: string;
    name: string;
    projectId: string;
    accountId: string;
    branchName: string;
    status: string;
    createdAt: Date;
    updatedAt: Date;
}) {
    return {
        id: ws.id,
        name: ws.name,
        projectId: ws.projectId,
        accountId: ws.accountId,
        branchName: ws.branchName,
        status: ws.status,
        createdAt: ws.createdAt.getTime(),
        updatedAt: ws.updatedAt.getTime()
    };
}

function errorToStatus(error: ProjectError): number {
    switch (error) {
        case 'project-not-found':
        case 'workspace-not-found':
            return 404;
        case 'access-denied':
        case 'not-owner':
            return 403;
        case 'branch-exists':
            return 409;
        default:
            return 400;
    }
}
