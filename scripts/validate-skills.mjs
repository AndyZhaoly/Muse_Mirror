import fs from 'node:fs';
import path from 'node:path';

const roots = [path.resolve('.agents/skills'), path.resolve('skills')];
const names = new Set();
let count = 0;

function parse(markdown, file) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) throw new Error(`${file}: missing YAML front matter`);
  const fields = new Map();
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index > 0) fields.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  const name = fields.get('name');
  const description = fields.get('description');
  if (!name || !description) throw new Error(`${file}: name and description are required`);
  if (description.length < 30) throw new Error(`${file}: description is too vague`);
  return { name, description };
}

for (const root of roots) {
  if (!fs.existsSync(root)) throw new Error(`Missing skills root: ${root}`);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, 'SKILL.md');
    if (!fs.existsSync(file)) throw new Error(`${entry.name}: missing SKILL.md`);
    const parsed = parse(fs.readFileSync(file, 'utf8'), file);
    if (parsed.name !== entry.name) {
      throw new Error(`${file}: name ${parsed.name} must match directory ${entry.name}`);
    }
    const scoped = `${path.basename(path.dirname(root))}/${parsed.name}`;
    if (names.has(scoped)) throw new Error(`Duplicate skill: ${scoped}`);
    names.add(scoped);
    count += 1;
  }
}

console.log(`Validated ${count} Skill manifests across Codex and runtime skill roots.`);
