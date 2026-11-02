import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Saycode 는 upstream 의 ElevenLabs 음성 비서(`/v1/voice/*`)를 쓰지 않는다.
 * 음성 입력은 web-ui 의 Soniox 경로다. 이 경로가 남아 있으면 키가 없는 서버가
 * 설정 변수 이름을 담은 500 을 돌려주므로(CASA 점검 발견), 등록 자체를 막는다.
 * upstream 동기화로 다시 들어오면 여기서 실패한다.
 */
const API_DIR = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return sourceFiles(path);
        return path.endsWith('.ts') && !/\.(spec|test)\.ts$/.test(path) ? [path] : [];
    });
}

describe('unused voice routes', () => {
    it('registers no /v1/voice route on the API server', () => {
        const registrations = sourceFiles(API_DIR).filter((file) =>
            /\.(get|post|put|patch|delete|route)\(\s*['"`]\/v1\/voice\b/.test(readFileSync(file, 'utf8')),
        );
        expect(registrations).toEqual([]);
    });
});
