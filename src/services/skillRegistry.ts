import fs from 'node:fs';
import path from 'node:path';
import { resolveWithin } from '../utils/pathSafety.js';

export const runtimeFashionSkillNames = [
  'style-diagnosis',
  'occasion-styling',
  'outfit-review',
  'try-on-preparation',
] as const;

export type RuntimeFashionSkillName = (typeof runtimeFashionSkillNames)[number];

export interface FashionSkillMetadata {
  name: RuntimeFashionSkillName;
  description: string;
  references: string[];
}

export interface LoadedFashionSkill extends FashionSkillMetadata {
  instructions?: string;
  reference?: {
    name: string;
    content: string;
  };
}

function parseSkillMarkdown(markdown: string): {
  name: string;
  description: string;
  body: string;
} {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error('SKILL.md is missing YAML front matter.');

  const frontMatter = match[1] ?? '';
  const body = (match[2] ?? '').trim();
  const fields = new Map<string, string>();
  for (const rawLine of frontMatter.split(/\r?\n/)) {
    const index = rawLine.indexOf(':');
    if (index <= 0) continue;
    fields.set(rawLine.slice(0, index).trim(), rawLine.slice(index + 1).trim());
  }

  const name = fields.get('name');
  const description = fields.get('description');
  if (!name || !description) {
    throw new Error('SKILL.md front matter requires name and description.');
  }
  return { name, description, body };
}

export class FashionSkillRegistry {
  private readonly metadata = new Map<RuntimeFashionSkillName, FashionSkillMetadata>();

  constructor(private readonly skillsDir = path.resolve('./skills')) {
    for (const name of runtimeFashionSkillNames) {
      const directory = resolveWithin(this.skillsDir, path.join(this.skillsDir, name));
      const markdown = fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8');
      const parsed = parseSkillMarkdown(markdown);
      if (parsed.name !== name) {
        throw new Error(`Skill directory ${name} declares mismatched name ${parsed.name}.`);
      }
      const referencesDir = path.join(directory, 'references');
      const references = fs.existsSync(referencesDir)
        ? fs
            .readdirSync(referencesDir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
            .map((entry) => entry.name)
            .sort()
        : [];
      this.metadata.set(name, { name, description: parsed.description, references });
    }
  }

  catalog(): FashionSkillMetadata[] {
    return runtimeFashionSkillNames.map((name) => {
      const value = this.metadata.get(name);
      if (!value) throw new Error(`Missing registered fashion skill: ${name}`);
      return { ...value, references: [...value.references] };
    });
  }

  load(name: RuntimeFashionSkillName, reference?: string): LoadedFashionSkill {
    const metadata = this.metadata.get(name);
    if (!metadata) throw new Error(`Unknown fashion skill: ${name}`);
    const directory = resolveWithin(this.skillsDir, path.join(this.skillsDir, name));

    if (reference) {
      if (!metadata.references.includes(reference)) {
        throw new Error(`Unknown reference ${reference} for skill ${name}.`);
      }
      const referencesDir = path.join(directory, 'references');
      const referencePath = resolveWithin(referencesDir, path.join(referencesDir, reference));
      return {
        ...metadata,
        references: [...metadata.references],
        reference: {
          name: reference,
          content: fs.readFileSync(referencePath, 'utf8'),
        },
      };
    }

    const parsed = parseSkillMarkdown(
      fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8'),
    );
    return {
      ...metadata,
      references: [...metadata.references],
      instructions: parsed.body,
    };
  }
}
