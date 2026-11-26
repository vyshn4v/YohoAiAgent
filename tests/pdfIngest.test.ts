import { describe, it, expect } from 'vitest';
import {
  chunkResumeText,
  ingestResumePdf,
  parseArgs,
} from '../src/scripts/ingestResumePdf.js';

describe('Resume PDF Ingestion Pipeline', () => {
  it('should parse command-line arguments for custom file paths', () => {
    const args = parseArgs(['node', 'script.js', '--file', 'custom/my_resume.pdf']);
    expect(args.filePath).toContain('my_resume.pdf');
  });

  it('should default to data/resume.pdf when no arguments provided', () => {
    const args = parseArgs(['node', 'script.js']);
    expect(args.filePath).toContain('data');
    expect(args.filePath).toContain('resume.pdf');
  });

  it('should segment structured resume text by major section headers', () => {
    const sampleResume = `
Vyshnav P C
Full-Stack & AI Engineer

SUMMARY
Passionate engineer building agentic AI architectures and scalable backend workflows.

TECHNICAL SKILLS
Languages: TypeScript, JavaScript, Python
Frameworks: Node.js, Express, LangGraph, React

EXPERIENCE
Software Engineer at Neutrinos
Built enterprise AI applications and distributed workflows.

EDUCATION
Brototype Institute of Technology
    `.trim();

    const chunks = chunkResumeText(sampleResume);

    expect(chunks.length).toBeGreaterThanOrEqual(4);
    const titles = chunks.map((c) => c.title);
    expect(titles).toContain('SUMMARY');
    expect(titles).toContain('TECHNICAL SKILLS');
    expect(titles).toContain('EXPERIENCE');
    expect(titles).toContain('EDUCATION');

    const skillsChunk = chunks.find((c) => c.title === 'TECHNICAL SKILLS');
    expect(skillsChunk?.content).toContain('LangGraph');
  });

  it('should return a friendly notice and exit safely when PDF is not yet present', async () => {
    const result = await ingestResumePdf('data/non_existent_resume_file.pdf');

    expect(result.success).toBe(false);
    expect(result.count).toBe(0);
    expect(result.message).toContain('No resume PDF found');
    expect(result.message).toContain('Please place your resume file');
  });
});
