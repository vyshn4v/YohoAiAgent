import fs from 'fs';
import path from 'path';
import { PDFParse } from 'pdf-parse';
import { generateTextEmbedding } from '../services/embeddingService.js';
import {
  initPgVectorTable,
  replaceResumeChunks,
  ChunkInput,
  closePgPool,
} from '../services/pgVectorService.js';

export function parseArgs(argv: string[]): { filePath: string } {
  const fileArgIndex = argv.indexOf('--file');
  if (fileArgIndex !== -1 && argv[fileArgIndex + 1]) {
    return { filePath: path.resolve(process.cwd(), argv[fileArgIndex + 1]) };
  }
  return { filePath: path.resolve(process.cwd(), 'data/resume.pdf') };
}

/**
 * Extracts raw text from a PDF buffer using PDFParse.
 */
export async function extractPdfText(buffer: Buffer): Promise<{ text: string; pages: number }> {
  const parser = new PDFParse({ data: buffer });
  const textResult = await parser.getText();
  const info = await parser.getInfo();
  return {
    text: typeof textResult === 'string' ? textResult : (textResult as any)?.text || '',
    pages: (info as any)?.numPages || 1,
  };
}

/**
 * Splits raw resume text into logical, structured semantic chunks.
 */
export function chunkResumeText(text: string): Array<{ title: string; content: string }> {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  // Common resume section headers
  const sectionHeaders = [
    'SUMMARY',
    'PROFESSIONAL SUMMARY',
    'EXPERIENCE',
    'WORK EXPERIENCE',
    'PROJECTS',
    'TECHNICAL SKILLS',
    'SKILLS',
    'EDUCATION',
    'CERTIFICATIONS',
    'LANGUAGES',
    'CONTACT',
  ];

  const lines = normalized.split('\n');
  const chunks: Array<{ title: string; content: string }> = [];
  let currentTitle = 'Overview';
  let currentLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const upper = trimmed.toUpperCase();

    // Check if line matches a known section header
    const matchedHeader = sectionHeaders.find(
      (h) => upper === h || upper === `${h}:` || upper.startsWith(`${h} —`) || upper.startsWith(`${h} -`)
    );

    if (matchedHeader && currentLines.length > 0) {
      chunks.push({
        title: currentTitle,
        content: currentLines.join('\n').trim(),
      });
      currentTitle = matchedHeader;
      currentLines = [];
    } else if (trimmed) {
      currentLines.push(trimmed);
    }
  }

  if (currentLines.length > 0) {
    chunks.push({
      title: currentTitle,
      content: currentLines.join('\n').trim(),
    });
  }

  // If text didn't match known headers, break into ~500-word sliding chunks
  if (chunks.length <= 1 && normalized.length > 1500) {
    const paragraphs = normalized.split(/\n\s*\n/);
    const subChunks: Array<{ title: string; content: string }> = [];
    let buffer = '';
    let idx = 1;

    for (const p of paragraphs) {
      if ((buffer + '\n' + p).length > 1200) {
        subChunks.push({ title: `Resume Section ${idx++}`, content: buffer.trim() });
        buffer = p;
      } else {
        buffer = buffer ? `${buffer}\n\n${p}` : p;
      }
    }
    if (buffer) {
      subChunks.push({ title: `Resume Section ${idx}`, content: buffer.trim() });
    }
    return subChunks;
  }

  return chunks;
}

/**
 * Main PDF Ingestion runner.
 */
export async function ingestResumePdf(customPath?: string): Promise<{ success: boolean; count: number; message: string }> {
  const hasCliFile = process.argv.includes('--file');
  let targetPath = customPath || parseArgs(process.argv).filePath;

  if (!customPath && !hasCliFile && !fs.existsSync(targetPath) && process.env.RESUME_PDF_PATH) {
    targetPath = path.resolve(process.cwd(), process.env.RESUME_PDF_PATH);
  }

  console.log(`=======================================================`);
  console.log(`📄 Resume PDF Ingestion Pipeline`);
  console.log(`🔍 Checking path: ${targetPath}`);
  console.log(`=======================================================`);

  if (!fs.existsSync(targetPath)) {
    const message = `No resume PDF found at '${targetPath}'. Please place your resume file at 'data/resume.pdf' and run 'npm run ingest:pdf'.`;
    console.warn(`[Resume Ingest Warning] ${message}`);
    return { success: false, count: 0, message };
  }

  try {
    const buffer = fs.readFileSync(targetPath);
    const pdfData = await extractPdfText(buffer);
    const rawText = pdfData.text || '';

    if (!rawText.trim()) {
      const message = `PDF at '${targetPath}' contains no readable text.`;
      console.warn(`[Resume Ingest Warning] ${message}`);
      return { success: false, count: 0, message };
    }

    console.log(`📖 Extracted ${pdfData.pages} page(s) and ${rawText.length} characters.`);
    const textChunks = chunkResumeText(rawText);
    console.log(`🧩 Segmented into ${textChunks.length} logical chunk(s).`);

    // Ensure table exists in PostgreSQL
    await initPgVectorTable();

    // Generate vector embeddings using gemini-embedding-2
    console.log(`🧠 Generating vector embeddings using gemini-embedding-2...`);
    const chunkInputs: ChunkInput[] = [];

    for (let i = 0; i < textChunks.length; i++) {
      const c = textChunks[i];
      const embedding = await generateTextEmbedding(`${c.title}\n${c.content}`);
      chunkInputs.push({
        chunkIndex: i,
        title: c.title,
        content: c.content,
        embedding,
        metadata: {
          source: path.basename(targetPath),
          pages: pdfData.pages,
          ingestedAt: new Date().toISOString(),
        },
      });
    }

    // Atomically replace old chunks with new ones
    console.log(`💾 Replacing old chunks in PostgreSQL table 'resume_chunks'...`);
    const count = await replaceResumeChunks(chunkInputs);

    const message = `Successfully parsed '${path.basename(targetPath)}' and updated ${count} chunk(s) in PostgreSQL pgvector.`;
    console.log(`✅ ${message}`);
    return { success: true, count, message };
  } catch (error: any) {
    const message = `PDF ingestion error: ${error.message}`;
    console.error(`❌ [Resume Ingest Error] ${message}`);
    return { success: false, count: 0, message };
  }
}

// Execute script directly if called from CLI
if (process.argv[1] && process.argv[1].endsWith('ingestResumePdf.ts')) {
  ingestResumePdf()
    .then(() => closePgPool())
    .catch((err) => {
      console.error(err);
      closePgPool();
    });
}
