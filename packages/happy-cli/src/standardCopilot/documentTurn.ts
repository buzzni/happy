import { link, mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseDocumentInput } from '../documents/contracts';
import { createDocx, readDocx } from '../documents/docx';
import { createPptx, readPptx } from '../documents/pptx';
import { createXlsx, readXlsx } from '../documents/xlsx';

export type StandardCopilotDocumentFormat = 'docx' | 'xlsx' | 'pptx';

export type PreparedStandardCopilotTurn =
  | { kind: 'chat'; providerPrompt: string }
  | {
      kind: 'document';
      format: StandardCopilotDocumentFormat;
      providerPrompt: string;
    };

export type CompletedStandardCopilotTurn = {
  kind: 'chat' | 'document';
  text: string;
  providerPromptCharacters: number;
  providerResponseCharacters: number;
  format?: StandardCopilotDocumentFormat;
  artifactPath?: string;
};

export class StandardCopilotDocumentError extends Error {}

const CREATE_VERB = /(?:만들|작성|생성|제작|create|make|prepare)/i;
const NEGATED_CREATE_VERB = /(?:만들|작성|생성|제작)(?:지|하지)\s*(?:마|말)|\b(?:do not|don't)\s+(?:create|make|prepare)\b/i;
const formatPatterns: Array<[StandardCopilotDocumentFormat, RegExp]> = [
  ['docx', /(?:\.docx\b|\bdocx\b|워드\s*문서|word\s*document)/i],
  ['xlsx', /(?:\.xlsx\b|\bxlsx\b|엑셀|스프레드시트|spreadsheet|excel\s*(?:file|workbook)?)/i],
  ['pptx', /(?:\.pptx\b|\bpptx\b|\bppt\b|발표\s*자료|프레젠테이션|presentation|powerpoint)/i],
];

const examples: Record<StandardCopilotDocumentFormat, unknown> = {
  docx: {
    schemaVersion: '1.0',
    format: 'docx',
    title: '문서 제목',
    design: {
      audience: 'general',
      mood: 'refined',
      density: 'balanced',
      emphasis: 'conclusion',
      accessibility: 'standard',
    },
    blocks: [
      { type: 'heading', level: 1, text: '첫 번째 절' },
      { type: 'paragraph', text: '요청에 맞춘 구체적인 본문' },
      { type: 'bulletList', items: ['핵심 항목 1', '핵심 항목 2'] },
      { type: 'table', columns: ['구분', '내용'], rows: [['항목', '설명']] },
    ],
  },
  xlsx: {
    schemaVersion: '1.0',
    format: 'xlsx',
    title: '통합문서 제목',
    design: {
      audience: 'general',
      mood: 'neutral',
      density: 'balanced',
      emphasis: 'metrics',
      accessibility: 'standard',
    },
    sheets: [{
      name: '데이터',
      columns: ['항목', '수량', '단가', '합계'],
      rows: [['예시', 2, 1000, { formula: 'B2*C2' }]],
    }],
  },
  pptx: {
    schemaVersion: '1.0',
    format: 'pptx',
    title: '발표자료 제목',
    design: {
      audience: 'client',
      mood: 'refined',
      density: 'spacious',
      emphasis: 'conclusion',
      accessibility: 'standard',
    },
    slides: [
      { layout: 'title', title: '표지 제목', subtitle: '표지 부제' },
      { layout: 'title-and-content', title: '본문 제목', bullets: ['핵심 내용 1', '핵심 내용 2'] },
    ],
  },
};

function detectCreateFormat(prompt: string): StandardCopilotDocumentFormat | null {
  if (!CREATE_VERB.test(prompt) || NEGATED_CREATE_VERB.test(prompt)) return null;
  const matches = formatPatterns
    .filter(([, pattern]) => pattern.test(prompt))
    .map(([format]) => format);
  return matches.length === 1 ? matches[0] : null;
}

function buildDocumentPrompt(
  userPrompt: string,
  format: StandardCopilotDocumentFormat,
): string {
  return [
    `사용자의 요청을 실제 ${format.toUpperCase()} 파일로 만들기 위한 입력 JSON을 작성하세요.`,
    `사용자 요청: ${userPrompt}`,
    '파일·코드·도구를 실행하지 말고 Markdown 설명 없이 완전한 JSON 하나만 반환하세요.',
    '아래 예시와 정확히 같은 키 구조를 사용하되 제목과 내용은 사용자 요청에 맞게 바꾸세요.',
    'design의 audience는 general/executive/client/operator, mood는 neutral/refined/calm/bold/warm, density는 compact/balanced/spacious, emphasis는 balanced/conclusion/metrics/comparison/process, accessibility는 standard/high-contrast 중 하나입니다.',
    'DOCX heading level은 1 또는 2, 표는 최대 6열, XLSX는 최대 4시트·8열·100행, PPTX는 최대 10장이며 제목과 bullet은 짧게 작성하세요.',
    'XLSX 수식은 A~H 열의 같은 시트 셀 곱셈 또는 SUM 범위만 사용하고 = 기호를 붙이지 마세요.',
    JSON.stringify(examples[format]),
  ].join('\n');
}

export function prepareStandardCopilotTurn(userPrompt: string): PreparedStandardCopilotTurn {
  const format = detectCreateFormat(userPrompt);
  if (!format) return { kind: 'chat', providerPrompt: userPrompt };
  return {
    kind: 'document',
    format,
    providerPrompt: buildDocumentPrompt(userPrompt, format),
  };
}

function safeFilename(title: string): string {
  const normalized = title
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001F\u007F]/g, ' ')
    .replace(/\.+$/g, '')
    .trim()
    .replace(/\s+/g, '_');
  const limited = [...normalized].slice(0, 60).join('').replace(/^\.+/, '');
  return limited || 'document';
}

async function writeUniqueArtifact(input: {
  workspaceDirectory: string;
  title: string;
  format: StandardCopilotDocumentFormat;
  bytes: Buffer;
}): Promise<string> {
  const documentsDirectory = path.resolve(input.workspaceDirectory, 'documents');
  const workspaceRoot = path.resolve(input.workspaceDirectory);
  if (!documentsDirectory.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new StandardCopilotDocumentError('문서 저장 경로를 확인해 주세요.');
  }
  await mkdir(documentsDirectory, { recursive: true, mode: 0o700 });
  const stem = safeFilename(input.title);
  const temporaryPath = path.join(documentsDirectory, `.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, input.bytes, { flag: 'wx', mode: 0o600 });
  try {
    for (let suffix = 1; suffix <= 100; suffix += 1) {
      const filename = `${stem}${suffix === 1 ? '' : `-${suffix}`}.${input.format}`;
      const target = path.join(documentsDirectory, filename);
      try {
        await link(temporaryPath, target);
        return path.posix.join('documents', filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    throw new StandardCopilotDocumentError('같은 이름의 문서가 너무 많습니다.');
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function createAndValidateDocument(
  document: ReturnType<typeof parseDocumentInput>,
): Promise<Buffer> {
  if (document.format === 'docx') {
    const bytes = await createDocx(document);
    await readDocx(bytes);
    return bytes;
  }
  if (document.format === 'xlsx') {
    const bytes = await createXlsx(document);
    await readXlsx(bytes);
    return bytes;
  }
  const bytes = await createPptx(document);
  await readPptx(bytes);
  return bytes;
}

export async function completeStandardCopilotTurn(input: {
  userPrompt: string;
  workspaceDirectory: string;
  generateText(providerPrompt: string): Promise<string>;
}): Promise<CompletedStandardCopilotTurn> {
  const prepared = prepareStandardCopilotTurn(input.userPrompt);
  const providerReply = await input.generateText(prepared.providerPrompt);
  if (prepared.kind === 'chat') {
    return {
      kind: 'chat',
      text: providerReply,
      providerPromptCharacters: prepared.providerPrompt.length,
      providerResponseCharacters: providerReply.length,
    };
  }

  let document: ReturnType<typeof parseDocumentInput>;
  try {
    document = parseDocumentInput(providerReply, prepared.format);
  } catch {
    throw new StandardCopilotDocumentError('Work IQ 문서 계획 형식이 올바르지 않습니다.');
  }

  let bytes: Buffer;
  try {
    bytes = await createAndValidateDocument(document);
  } catch {
    throw new StandardCopilotDocumentError('Work IQ 문서 생성 검증에 실패했습니다.');
  }
  const artifactPath = await writeUniqueArtifact({
    workspaceDirectory: input.workspaceDirectory,
    title: document.title,
    format: prepared.format,
    bytes,
  });
  const marker = JSON.stringify({
    kind: 'document',
    artifacts: [{ path: artifactPath, label: path.posix.basename(artifactPath) }],
  });
  return {
    kind: 'document',
    format: prepared.format,
    artifactPath,
    providerPromptCharacters: prepared.providerPrompt.length,
    providerResponseCharacters: providerReply.length,
    text: `문서를 생성하고 파일 구조를 확인했습니다.\n\n\`\`\`axstudio-work-complete\n${marker}\n\`\`\``,
  };
}
