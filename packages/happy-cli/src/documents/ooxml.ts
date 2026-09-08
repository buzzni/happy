import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { GENERATOR, textValue } from './contracts';

const MAX_OFFICE_BYTES = 10 * 1024 * 1024;
const MAX_OFFICE_ENTRIES = 2_000;
const mainParts = {
  docx: 'word/document.xml',
  xlsx: 'xl/workbook.xml',
  pptx: 'ppt/presentation.xml',
} as const;

export async function openGeneratedOffice(
  bytes: Buffer,
  format: keyof typeof mainParts,
): Promise<JSZip> {
  if (
    bytes.byteLength === 0
    || bytes.byteLength > MAX_OFFICE_BYTES
    || bytes.subarray(0, 2).toString('ascii') !== 'PK'
  ) {
    throw new Error('Office 문서 크기 또는 signature를 확인해 주세요.');
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new Error('OOXML 문서 구조를 확인해 주세요.');
  }
  const entries = Object.keys(zip.files);
  if (
    entries.length === 0
    || entries.length > MAX_OFFICE_ENTRIES
    || !zip.file('[Content_Types].xml')
    || !zip.file(mainParts[format])
  ) {
    throw new Error('OOXML 문서 구조를 확인해 주세요.');
  }
  if (entries.some((name) => (
    !zip.files[name].dir
    && /vbaProject|externalLinks|embeddings/i.test(name)
  ))) {
    throw new Error('매크로·외부 연결·내장 실행 개체는 지원하지 않습니다.');
  }
  const core = await zip.file('docProps/core.xml')?.async('string');
  if (!core || !core.includes(`<dc:subject>${GENERATOR}</dc:subject>`)) {
    throw new Error('이번 모듈이 생성한 파일만 읽기·편집을 지원합니다.');
  }
  return zip;
}

export function xmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function textRuns(xml: string, tag: 'w:t' | 'a:t'): Array<{ source: string; text: string }> {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('외부 XML 선언은 지원하지 않습니다.');
  const parser = new XMLParser({ parseTagValue: false, trimValues: false });
  return [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'g'))]
    .map((match) => ({
      source: match[0],
      text: String(parser.parse(`<value>${match[1]}</value>`).value ?? ''),
    }));
}

export async function replaceOneText(input: {
  bytes: Buffer;
  format: 'docx' | 'pptx';
  parts: string[];
  tag: 'w:t' | 'a:t';
  from: string;
  to: string;
}): Promise<Buffer> {
  textValue.parse(input.from);
  textValue.parse(input.to);
  const zip = await openGeneratedOffice(input.bytes, input.format);
  const matches: Array<{ part: string; xml: string; source: string }> = [];
  for (const part of input.parts) {
    const xml = await zip.file(part)?.async('string');
    if (!xml) throw new Error('문서 본문이 없습니다.');
    for (const run of textRuns(xml, input.tag)) {
      if (run.text === input.from) matches.push({ part, xml, source: run.source });
    }
  }
  if (matches.length !== 1) {
    throw new Error('편집 대상은 완전한 텍스트 run으로 정확히 1개여야 합니다.');
  }
  const match = matches[0];
  zip.file(
    match.part,
    match.xml.replace(
      match.source,
      () => `<${input.tag} xml:space="preserve">${xmlText(input.to)}</${input.tag}>`,
    ),
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
