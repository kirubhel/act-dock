import type { AiSkillCategory } from "../shared/contracts";

/**
 * Sorts a skill into one working area from its name and description, so a long list can be browsed and installed by area.
 * It is a keyword score, not a model: the name counts three times as much as the description, and ties go to the
 * area listed first. Anything with no clear signal stays in "Other".
 */
const RULES: [AiSkillCategory, RegExp][] = [
  ["CI/CD & DevOps", /\b(ci[\s/_-]?cd|cicd|pipelines?|deploy\w*|docker\w*|kubernetes|k8s|terraform|helm|ansible|github actions|gitlab[\s-]ci|release|bump[\s-]version|build[\s-]image|infrastructure|devops|containers?|observability|monitoring|runbook)\b/gi],
  ["Mobile", /\b(mobile|ios|android|swift|swiftui|kotlin|flutter|react[\s-]native|expo|xcode|jetpack|app[\s-]store|play[\s-]store|testflight)\b/gi],
  ["Frontend & Design", /\b(front[\s-]?end|react|vue|svelte|angular|next\.?js|css|tailwind|html|ui|ux|design|components?|accessibility|a11y|figma|animation|responsive|storybook|typography|layout|landing[\s-]page)\b/gi],
  ["Backend & API", /\b(back[\s-]?end|apis?|endpoints?|rest|graphql|grpc|database|sql|postgres\w*|mysql|mongo\w*|redis|orm|servers?|micro[\s-]?services?|nestjs|express|django|fastapi|spring|prisma|migrations?|queues?|kafka|rabbitmq|websockets?)\b/gi],
  ["Security", /\b(security|vulnerabilit\w*|secrets?|owasp|pentest\w*|threat|auth\w*|encryption|cve|sast|dast|compliance|permissions?)\b/gi],
  ["Testing & Quality", /\b(tests?|testing|qa|e2e|playwright|cypress|jest|vitest|pytest|coverage|lint\w*|code[\s-]quality|quality|refactor\w*|debug\w*|bugs?)\b/gi],
  ["Git & Code Review", /\b(git|commits?|pull[\s-]requests?|prs?|merge|branch(?:es)?|code[\s-]review|reviews?|diff)\b/gi],
  ["Data & AI", /\b(data|ml|machine[\s-]learning|llm|prompts?|models?|embeddings?|rag|notebooks?|pandas|analytics|etl|agents?|ai|mcp|whisper|speech|voice)\b/gi],
  ["Docs & Writing", /\b(docs?|documentation|readme|writing|specs?|markdown|changelog|translat\w*|presentations?|pdf|slides?|docx|xlsx|pptx|spreadsheets?|summar\w*)\b/gi],
];

const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

/** Skills that are part of your own Matrix standards, by where they live or what they are called. */
export const isMatrixSkill = (name: string, folder: string) => /(^|[\\/])Matrix[\\/]/.test(folder) || /^matrix[\s-]/i.test(name) || /(^|[\\/])matrix-[^\\/]*$/i.test(folder);

export function categorizeSkill(name: string, description: string): AiSkillCategory {
  let best: AiSkillCategory = "Other", bestScore = 0;
  for (const [category, re] of RULES) {
    // The name is split on dashes and underscores so "check-cicd" and "build_image" read as words.
    const score = count(name.replace(/[_]+/g, " "), re) * 3 + count(description, re);
    if (score > bestScore) { best = category; bestScore = score; }
  }
  return best;
}
