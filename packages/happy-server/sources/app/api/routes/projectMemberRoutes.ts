import { z } from "zod";
import { Fastify } from "../types";
import { Context } from "@/context";
import { projectMemberInvite } from "@/app/project/projectMemberInvite";
import { projectMemberList } from "@/app/project/projectMemberList";
import { projectMemberListBatch } from "@/app/project/projectMemberListBatch";
import { projectMemberRespond } from "@/app/project/projectMemberRespond";
import { projectMemberUpdate } from "@/app/project/projectMemberUpdate";
import { projectMemberRemove } from "@/app/project/projectMemberRemove";
import { projectMemberPending } from "@/app/project/projectMemberPending";
import { ProjectError } from "@/app/project/types";

const ProjectRoleSchema = z.enum(['owner', 'editor', 'viewer']);

export function projectMemberRoutes(app: Fastify) {

    app.post('/v1/projects/:projectId/members', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ projectId: z.string() }),
            // Either { username, role } (legacy) or { accountId, role }
            // (preferred — web-ui orchestrates by happy accountId to avoid
            // username-collision bugs).
            body: z.union([
                z.object({
                    username: z.string(),
                    role: ProjectRoleSchema.default('editor')
                }),
                z.object({
                    accountId: z.string(),
                    role: ProjectRoleSchema.default('editor')
                })
            ])
        }
    }, async (request, reply) => {
        const { projectId } = request.params;
        const body = request.body;
        const role = body.role;
        const target = 'accountId' in body
            ? { accountId: body.accountId }
            : { username: body.username };
        const ctx = Context.create(request.userId);

        const result = await projectMemberInvite(ctx, projectId, target, role);
        if (!result.ok) {
            return reply.code(errorToStatus(result.error)).send({ error: result.error });
        }
        return reply.send({ member: result.value });
    });

    app.get('/v1/projects/:projectId/members', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ projectId: z.string() })
        }
    }, async (request, reply) => {
        const ctx = Context.create(request.userId);
        const result = await projectMemberList(ctx, request.params.projectId);
        if (!result.ok) {
            return reply.code(errorToStatus(result.error)).send({ error: result.error });
        }
        return reply.send({ members: result.value });
    });

    /**
     * 여러 프로젝트의 멤버를 한 번에 조회한다.
     *
     * 위 단건 엔드포인트를 프로젝트마다 부르면 (web-ui 목록 화면이 그랬다)
     * 224개 × 3쿼리 ≈ 672쿼리가 동시에 Prisma pool 을 잡아 P2024 로
     * 넘어간다 — 2026-08-06 장애의 1차 경로.
     *
     * GET 이 아니라 POST 인 이유는 id 배열이 URL 길이 제한에 걸리기
     * 때문이다. 상태를 바꾸지 않는 조회다.
     *
     * specs/project-members-batch-lookup
     */
    app.post('/v1/projects/members/batch', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({ ids: z.array(z.string()) })
        }
    }, async (request, reply) => {
        const ctx = Context.create(request.userId);
        const result = await projectMemberListBatch(ctx, request.body.ids);
        if (!result.ok) {
            // too-many-ids 는 호출자가 배열을 쪼개면 되는 문제라 400.
            return reply.code(400).send({ error: result.error });
        }
        return reply.send({ members: result.value });
    });

    app.post('/v1/project-members/:memberId/respond', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ memberId: z.string() }),
            body: z.object({
                response: z.enum(['accepted', 'rejected'])
            })
        }
    }, async (request, reply) => {
        const ctx = Context.create(request.userId);
        const result = await projectMemberRespond(ctx, request.params.memberId, request.body.response);
        if (!result.ok) {
            return reply.code(errorToStatus(result.error)).send({ error: result.error });
        }
        return reply.send({ member: result.value });
    });

    app.post('/v1/projects/:projectId/members/:memberId/role', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                projectId: z.string(),
                memberId: z.string()
            }),
            body: z.object({ role: ProjectRoleSchema })
        }
    }, async (request, reply) => {
        const { projectId, memberId } = request.params;
        const ctx = Context.create(request.userId);
        const result = await projectMemberUpdate(ctx, projectId, memberId, request.body.role);
        if (!result.ok) {
            return reply.code(errorToStatus(result.error)).send({ error: result.error });
        }
        return reply.send({ member: result.value });
    });

    app.delete('/v1/projects/:projectId/members/:memberId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                projectId: z.string(),
                memberId: z.string()
            })
        }
    }, async (request, reply) => {
        const { projectId, memberId } = request.params;
        const ctx = Context.create(request.userId);
        const result = await projectMemberRemove(ctx, projectId, memberId);
        if (!result.ok) {
            return reply.code(errorToStatus(result.error)).send({ error: result.error });
        }
        return reply.send({ success: true });
    });

    app.get('/v1/project-members/pending', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const ctx = Context.create(request.userId);
        const invitations = await projectMemberPending(ctx);
        return reply.send({ invitations });
    });
}

function errorToStatus(error: ProjectError): number {
    switch (error) {
        case 'project-not-found':
        case 'member-not-found':
        case 'user-not-found':
            return 404;
        case 'access-denied':
        case 'not-owner':
            return 403;
        default:
            return 400;
    }
}
