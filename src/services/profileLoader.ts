import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ProfilePersonal {
  name: string;
  headline: string;
  assistantName: string;
  location: string;
  experienceYears: string;
  heroStatement: string;
  corePhilosophy: string;
  keyMetrics: { metric: string; description: string }[];
  summary: string;
}

export interface ProfileContact {
  email: string;
  phone: string;
  portfolio: string;
  agency: string;
  github: string;
  linkedin: string;
  leetcode: string;
  resumeUrl: string;
}

export interface ProfileSkills {
  coreStack: string[];
  generativeAI: string[];
  backendArchitecture: string[];
  databasesAndDataModeling: string[];
  messagingAndQueues: string[];
  thirdPartyIntegrations: string[];
  devopsAndCloud: string[];
  frontend: string[];
  toolsAndMethodologies: string[];
}

export interface ProfileExperience {
  role: string;
  company: string;
  period: string;
  domain: string;
  responsibilities: string[];
  awards?: string[];
}

export interface ProfileProject {
  name: string;
  tagline: string;
  status: string;
  url?: string;
  techStack: string[];
  overview: string;
  architecturalHighlights: string[];
}

export interface ProfileAgencyService {
  name: string;
  description: string;
}

export interface ProfileAgency {
  name: string;
  url: string;
  scope: string;
  services: ProfileAgencyService[];
}

export interface ProfilePhilosophy {
  principle: string;
  description: string;
}

export interface ProfileCertification {
  name: string;
  issuer: string;
  type: string;
}

export interface ProfileEducation {
  qualification: string;
  institution: string;
  period: string;
}

export interface ProfileLanguage {
  language: string;
  proficiency: string;
}

export interface ProfileSchedulingPolicy {
  assistantRepresentation: string;
  meetingPolicy: string;
  requiredDetails: string[];
  otpEmailVerification: string;
  responseCommitment: string;
}

export interface ProfileData {
  personal: ProfilePersonal;
  contact: ProfileContact;
  skills: ProfileSkills;
  experience: ProfileExperience[];
  projects: ProfileProject[];
  agency: ProfileAgency;
  engineeringPhilosophy: ProfilePhilosophy[];
  certifications: ProfileCertification[];
  education: ProfileEducation[];
  languages: ProfileLanguage[];
  schedulingPolicy: ProfileSchedulingPolicy;
  metadata?: {
    sourceUrl?: string;
    updatedAt?: string;
  };
}

export interface ProfileSectionChunk {
  id: string;
  title: string;
  text: string;
  metadata?: Record<string, any>;
}

/**
 * Resolves the primary profile path, preferring profile.json, falling back to profile.md.
 */
export function getProfileFilePath(): { path: string; format: 'json' | 'md' } {
  const jsonPath = path.resolve(__dirname, '../data/profile.json');
  if (fs.existsSync(jsonPath)) {
    return { path: jsonPath, format: 'json' };
  }

  const rootJsonPath = path.resolve(__dirname, '../../data/profile.json');
  if (fs.existsSync(rootJsonPath)) {
    return { path: rootJsonPath, format: 'json' };
  }

  const mdPath = path.resolve(__dirname, '../data/profile.md');
  if (fs.existsSync(mdPath)) {
    return { path: mdPath, format: 'md' };
  }

  const rootMdPath = path.resolve(__dirname, '../../data/profile.md');
  if (fs.existsSync(rootMdPath)) {
    return { path: rootMdPath, format: 'md' };
  }

  // Default to expected json path even if not yet created
  return { path: jsonPath, format: 'json' };
}

/**
 * Loads the raw parsed ProfileData object from profile.json.
 */
export function loadProfileData(): ProfileData {
  const fileInfo = getProfileFilePath();
  if (fileInfo.format === 'json' && fs.existsSync(fileInfo.path)) {
    const raw = fs.readFileSync(fileInfo.path, 'utf-8');
    return JSON.parse(raw) as ProfileData;
  }
  throw new Error(`Profile JSON file not found at ${fileInfo.path}`);
}

/**
 * Converts a structured ProfileData object into semantic markdown chunks suitable for vector embeddings and RAG.
 */
export function convertProfileToSections(profile: ProfileData): ProfileSectionChunk[] {
  const chunks: ProfileSectionChunk[] = [];

  // 1. Overview & Executive Summary
  const { personal } = profile;
  const overviewText = [
    `# Professional Profile & Knowledge Base: ${personal.name}`,
    '',
    `## Overview & Executive Summary`,
    `- **Name:** ${personal.name}`,
    `- **Headline / Title:** ${personal.headline}`,
    `- **AI Assistant Name:** ${personal.assistantName} (exclusive portfolio & scheduling AI assistant)`,
    `- **Location:** ${personal.location}`,
    `- **Experience Stat:** ${personal.experienceYears} of production experience in backend, distributed systems, and agentic AI`,
    `- **Hero Statement:** "${personal.heroStatement}"`,
    `- **Core Philosophy:** "${personal.corePhilosophy}"`,
    `- **Key Metrics:**`,
    ...personal.keyMetrics.map((km) => `  - \`${km.metric}\`: ${km.description}`),
    `- **Summary:** ${personal.summary}`,
  ].join('\n');

  chunks.push({
    id: 'profile-overview',
    title: 'Overview & Executive Summary',
    text: overviewText,
    metadata: { section: 'overview', title: 'Overview & Executive Summary' },
  });

  // 2. Contact Details & Professional Links
  const { contact } = profile;
  const contactText = [
    `## Contact Details & Professional Links`,
    `- **Email Direct:** [${contact.email}](mailto:${contact.email})`,
    `- **Phone Direct:** [${contact.phone}](tel:${contact.phone.replace(/\s+/g, '')})`,
    `- **Live Portfolio:** [${contact.portfolio}](${contact.portfolio})`,
    `- **Digital Agency:** [${profile.agency?.name || 'LixerLab'} (${contact.agency})](${contact.agency})`,
    `- **GitHub:** [${contact.github}](${contact.github})`,
    `- **LinkedIn:** [${contact.linkedin}](${contact.linkedin})`,
    `- **LeetCode:** [${contact.leetcode}](${contact.leetcode})`,
    `- **Resume (PDF):** [Download Resume](${contact.resumeUrl})`,
  ].join('\n');

  chunks.push({
    id: 'profile-contact',
    title: 'Contact Details & Professional Links',
    text: contactText,
    metadata: { section: 'contact', title: 'Contact Details & Professional Links' },
  });

  // 3. Core Technical Skills & Competencies
  const { skills } = profile;
  const skillsText = [
    `## Core Technical Skills & Competencies`,
    `- **Core Stack (Marquee):** ${skills.coreStack.join(', ')}.`,
    `- **Generative AI & Agentic Systems:** ${skills.generativeAI.join(', ')}.`,
    `- **Backend Architecture & APIs:** ${skills.backendArchitecture.join(', ')}.`,
    `- **Databases & Data Modeling:** ${skills.databasesAndDataModeling.join(', ')}.`,
    `- **Messaging & Event Pipelines:** ${skills.messagingAndQueues.join(', ')}.`,
    `- **Third-Party Integrations:** ${skills.thirdPartyIntegrations.join(', ')}.`,
    `- **DevOps, Cloud & Infrastructure:** ${skills.devopsAndCloud.join(', ')}.`,
    `- **Frontend Development:** ${skills.frontend.join(', ')}.`,
    `- **Engineering Tools & Methodologies:** ${skills.toolsAndMethodologies.join(', ')}.`,
  ].join('\n');

  chunks.push({
    id: 'profile-skills',
    title: 'Core Technical Skills & Competencies',
    text: skillsText,
    metadata: { section: 'skills', title: 'Core Technical Skills & Competencies' },
  });

  // 4. Professional Experience
  profile.experience.forEach((exp, idx) => {
    const expLines = [
      `## Professional Experience: ${exp.role} — ${exp.company}`,
      `- **Period:** ${exp.period}`,
      `- **Domain:** ${exp.domain}`,
      `- **Production Ownership & Responsibilities:**`,
      ...exp.responsibilities.map((r) => `  - ${r}`),
    ];
    if (exp.awards && exp.awards.length > 0) {
      expLines.push(`- **Awards & Recognitions:**`);
      exp.awards.forEach((award) => expLines.push(`  - *${award}*`));
    }

    chunks.push({
      id: `profile-experience-${idx + 1}`,
      title: `Professional Experience: ${exp.role} (${exp.company})`,
      text: expLines.join('\n'),
      metadata: { section: 'experience', company: exp.company, role: exp.role },
    });
  });

  // 5. Featured Engineering Projects
  profile.projects.forEach((proj, idx) => {
    const projLines = [
      `## Featured Project: ${proj.name} — ${proj.tagline}`,
      `- **Status:** ${proj.status}${proj.url ? ` ([${proj.url}](${proj.url}))` : ''}`,
      `- **Tech Stack:** ${proj.techStack.join(', ')}`,
      `- **Overview:** ${proj.overview}`,
      `- **Architectural Highlights:**`,
      ...proj.architecturalHighlights.map((h) => `  - ${h}`),
    ];

    chunks.push({
      id: `profile-project-${idx + 1}`,
      title: `Featured Project: ${proj.name} (${proj.tagline})`,
      text: projLines.join('\n'),
      metadata: { section: 'projects', project: proj.name },
    });
  });

  // 6. Agency & Consulting Services
  if (profile.agency) {
    const agencyLines = [
      `## Agency & Consulting Services (${profile.agency.name})`,
      `- **Digital Agency Initiative:** [${profile.agency.name}](${profile.agency.url})`,
      `- **Scope:** ${profile.agency.scope}`,
      `- **Specialized Services:**`,
      ...profile.agency.services.map((s, i) => `  ${i + 1}. **${s.name}:** ${s.description}`),
    ];

    chunks.push({
      id: 'profile-agency',
      title: `Agency & Consulting Services (${profile.agency.name})`,
      text: agencyLines.join('\n'),
      metadata: { section: 'agency', agency: profile.agency.name },
    });
  }

  // 7. Engineering Philosophy & Principles
  if (profile.engineeringPhilosophy?.length) {
    const philoLines = [
      `## Engineering Philosophy & Principles`,
      ...profile.engineeringPhilosophy.map((p) => `- **${p.principle}:** ${p.description}`),
    ];

    chunks.push({
      id: 'profile-philosophy',
      title: 'Engineering Philosophy & Principles',
      text: philoLines.join('\n'),
      metadata: { section: 'philosophy', title: 'Engineering Philosophy & Principles' },
    });
  }

  // 8. Certifications & Specialized Training
  if (profile.certifications?.length) {
    const certLines = [
      `## Certifications & Specialized Training`,
      ...profile.certifications.map((c) => `- **${c.name}** — Issued by ${c.issuer} *(${c.type})*`),
    ];

    chunks.push({
      id: 'profile-certifications',
      title: 'Certifications & Specialized Training',
      text: certLines.join('\n'),
      metadata: { section: 'certifications', title: 'Certifications & Specialized Training' },
    });
  }

  // 9. Education & Academic Foundation
  if (profile.education?.length) {
    const eduLines = [
      `## Education & Academic Foundation`,
      ...profile.education.map(
        (e) => `- **${e.qualification}**  \n  *Institution:* ${e.institution}  \n  *Period:* ${e.period}`
      ),
    ];

    chunks.push({
      id: 'profile-education',
      title: 'Education & Academic Foundation',
      text: eduLines.join('\n'),
      metadata: { section: 'education', title: 'Education & Academic Foundation' },
    });
  }

  // 10. Languages
  if (profile.languages?.length) {
    const langLines = [
      `## Languages`,
      ...profile.languages.map((l) => `- **${l.language}:** ${l.proficiency}`),
    ];

    chunks.push({
      id: 'profile-languages',
      title: 'Languages',
      text: langLines.join('\n'),
      metadata: { section: 'languages', title: 'Languages' },
    });
  }

  // 11. Scheduling, Consultation & Contact Policy
  if (profile.schedulingPolicy) {
    const sp = profile.schedulingPolicy;
    const schedLines = [
      `## Scheduling, Consultation & Contact Policy`,
      `- **AI Assistant Representation:** ${sp.assistantRepresentation}`,
      `- **Meeting & Enquiry Policy:** ${sp.meetingPolicy}`,
      `- **Required Details:** Users must provide their ${sp.requiredDetails.map((d) => `\`${d}\``).join(', ')}.`,
      `- **OTP Email Verification:** ${sp.otpEmailVerification}`,
      `- **Response Commitment:** ${sp.responseCommitment}`,
    ];

    chunks.push({
      id: 'profile-scheduling',
      title: 'Scheduling, Consultation & Contact Policy',
      text: schedLines.join('\n'),
      metadata: { section: 'schedulingPolicy', title: 'Scheduling, Consultation & Contact Policy' },
    });
  }

  return chunks;
}

/**
 * Loads sections either from profile.json (preferred) or parses profile.md as fallback.
 */
export function loadProfileSections(): ProfileSectionChunk[] {
  const fileInfo = getProfileFilePath();

  if (fileInfo.format === 'json' && fs.existsSync(fileInfo.path)) {
    try {
      const data = JSON.parse(fs.readFileSync(fileInfo.path, 'utf-8')) as ProfileData;
      return convertProfileToSections(data);
    } catch (err) {
      console.warn('[ProfileLoader] Error parsing profile.json, attempting fallback', err);
    }
  }

  // Markdown fallback: check both candidate paths
  const mdCandidates = [
    path.resolve(__dirname, '../data/profile.md'),
    path.resolve(__dirname, '../../data/profile.md'),
  ];
  const foundMdPath = mdCandidates.find((p) => fs.existsSync(p));
  if (foundMdPath) {
    const content = fs.readFileSync(foundMdPath, 'utf-8');
    const sections = content.split(/\n(?=## )/g).map((s) => s.trim()).filter(Boolean);
    return sections.map((sec, idx) => {
      const titleMatch = sec.match(/^##\s+(.*)/m);
      const title = titleMatch ? titleMatch[1] : `Section ${idx + 1}`;
      return {
        id: `chunk-md-${idx + 1}`,
        title,
        text: sec,
        metadata: { source: 'profile.md', section: idx },
      };
    });
  }

  return [];
}
