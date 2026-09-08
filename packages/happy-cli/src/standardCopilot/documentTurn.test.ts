import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readDocx } from '../documents/docx';
import { readPptx } from '../documents/pptx';
import { readXlsx } from '../documents/xlsx';
import {
  completeStandardCopilotTurn,
  prepareStandardCopilotTurn,
} from './documentTurn';

const fixtures = {
  docx: {
    schemaVersion: '1.0',
    format: 'docx',
    title: '신규 서비스 제안서',
    design: {
      audience: 'client', mood: 'refined', density: 'spacious',
      emphasis: 'conclusion', accessibility: 'high-contrast',
    },
    blocks: [
      { type: 'heading', level: 1, text: '추진 배경' },
      { type: 'paragraph', text: '반복 문서 작업을 줄이는 신규 서비스 도입안입니다.' },
      { type: 'bulletList', items: ['작성 시간 단축', '형식 일관성 향상'] },
      { type: 'table', columns: ['구분', '기대 효과'], rows: [['작성', '초안 자동화']] },
    ],
  },
  xlsx: {
    schemaVersion: '1.0',
    format: 'xlsx',
    title: '월간 매출 분석',
    sheets: [{
      name: '매출현황',
      columns: ['제품', '수량', '단가', '매출'],
      rows: [
        ['A 제품', 10, 100000, { formula: 'B2*C2' }],
        ['B 제품', 20, 120000, { formula: 'B3*C3' }],
      ],
    }],
  },
  pptx: {
    schemaVersion: '1.0',
    format: 'pptx',
    title: '신규 서비스 발표자료',
    slides: [
      { layout: 'title', title: '신규 서비스 제안', subtitle: '2026년 사업계획' },
      { layout: 'title-and-content', title: '추진 배경', bullets: ['고객 요구 증가', '작성 시간 단축'] },
    ],
  },
} as const;

describe('Standard Copilot document turn', () => {
  it('keeps ordinary chat and existing-file edit requests as chat turns', () => {
    expect(prepareStandardCopilotTurn('오늘 일정 알려줘')).toEqual({
      kind: 'chat',
      providerPrompt: '오늘 일정 알려줘',
    });
    expect(prepareStandardCopilotTurn('workiq-workload-analysis.xlsx 정렬 좀 맞혀줘')).toEqual({
      kind: 'chat',
      providerPrompt: 'workiq-workload-analysis.xlsx 정렬 좀 맞혀줘',
    });
    expect(prepareStandardCopilotTurn('XLSX 파일은 만들지 마. 위반 키만 알려줘')).toEqual({
      kind: 'chat',
      providerPrompt: 'XLSX 파일은 만들지 마. 위반 키만 알려줘',
    });
  });

  it.each([
    ['세련된 제안서를 DOCX로 만들어줘', 'docx'],
    ['월간 매출표를 엑셀로 생성해줘', 'xlsx'],
    ['신규 서비스 PPT 발표자료를 작성해줘', 'pptx'],
  ] as const)('prepares a constrained %s document request', (prompt, format) => {
    const prepared = prepareStandardCopilotTurn(prompt);

    expect(prepared.kind).toBe('document');
    expect(prepared).toMatchObject({ format });
    expect(prepared.providerPrompt).toContain('완전한 JSON 하나만 반환');
    expect(prepared.providerPrompt).toContain(`"format":"${format}"`);
    expect(prepared.providerPrompt).toContain(prompt);
  });

  it.each([
    ['docx', fixtures.docx, readDocx],
    ['xlsx', fixtures.xlsx, readXlsx],
    ['pptx', fixtures.pptx, readPptx],
  ] as const)('creates and validates a %s artifact in the chat workspace', async (format, fixture, readBack) => {
    const workspaceDirectory = await mkdtemp(path.join(tmpdir(), 'workiq-document-turn-'));
    const generateText = vi.fn(async () => JSON.stringify(fixture));

    const result = await completeStandardCopilotTurn({
      userPrompt: `${fixture.title}를 ${format}로 만들어줘`,
      workspaceDirectory,
      generateText,
    });

    expect(result).toMatchObject({ kind: 'document', format });
    expect(result.artifactPath).toMatch(new RegExp(`^documents/.+\\.${format}$`));
    expect(result.text).toContain('```axstudio-work-complete');
    expect(result.text).toContain(`"path":"${result.artifactPath}"`);
    const absolutePath = path.join(workspaceDirectory, result.artifactPath!);
    const bytes = await readFile(absolutePath);
    await expect(readBack(bytes)).resolves.toBeTruthy();
    expect((await stat(absolutePath)).mode & 0o777).toBe(0o600);
    expect(generateText).toHaveBeenCalledOnce();
  });

  it('uses a collision-free filename and never overwrites an existing artifact', async () => {
    const workspaceDirectory = await mkdtemp(path.join(tmpdir(), 'workiq-document-turn-'));
    const input = {
      userPrompt: '제안서를 docx로 만들어줘',
      workspaceDirectory,
      generateText: async () => JSON.stringify(fixtures.docx),
    };

    const first = await completeStandardCopilotTurn(input);
    const second = await completeStandardCopilotTurn(input);

    expect(first.artifactPath).toBe('documents/신규_서비스_제안서.docx');
    expect(second.artifactPath).toBe('documents/신규_서비스_제안서-2.docx');
  });

  it('allows empty spreadsheet cells used by summary rows', async () => {
    const workspaceDirectory = await mkdtemp(path.join(tmpdir(), 'workiq-document-turn-'));
    const spreadsheet = {
      ...fixtures.xlsx,
      sheets: [{
        ...fixtures.xlsx.sheets[0],
        rows: [
          ...fixtures.xlsx.sheets[0].rows,
          ['합계', '', '', { formula: 'SUM(D2:D3)' }],
        ],
      }],
    };

    const result = await completeStandardCopilotTurn({
      userPrompt: '월간 매출표를 xlsx로 만들어줘',
      workspaceDirectory,
      generateText: async () => JSON.stringify(spreadsheet),
    });

    expect(result).toMatchObject({ kind: 'document', format: 'xlsx' });
  });

  it('rejects an invalid provider plan without leaving a document behind', async () => {
    const workspaceDirectory = await mkdtemp(path.join(tmpdir(), 'workiq-document-turn-'));

    await expect(completeStandardCopilotTurn({
      userPrompt: '제안서를 docx로 만들어줘',
      workspaceDirectory,
      generateText: async () => '{"format":"docx"}',
    })).rejects.toThrow('Work IQ 문서 계획');

    await expect(readFile(path.join(workspaceDirectory, 'documents', 'document.docx')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});
