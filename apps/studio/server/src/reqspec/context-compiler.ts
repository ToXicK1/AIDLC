export type AiTask =
  | "draft_requirements"
  | "find_ambiguities"
  | "suggest_acceptance"
  | "review_completeness"
  | "summarize_handoff";

export interface ReqSpec {
  schemaVersion: "1.0";
  project: {
    id: string; name: string; problem: string; goal: string;
    successMetrics?: string[]; scopeIn: string[]; scopeOut: string[];
    constraints?: string[]; assumptions?: string[];
  };
  personas: Persona[];
  requirements: Requirement[];
  stories: Story[];
  decisions: Decision[];
  openQuestions: OpenQuestion[];
  metadata?: { updatedAt?: string; updatedBy?: string; revision?: number };
}

export interface Persona { id: string; name: string; need: string; goals?: string[]; painPoints?: string[]; }
export interface Acceptance { given: string; when: string; then: string; }
export interface Requirement {
  id: string; kind: "functional" | "non-functional"; statement: string;
  rationale?: string; priority: string; status: string; personaRefs?: string[];
  sourceRefs: string[]; dependsOn?: string[]; acceptance: Acceptance[]; metric?: string; notes?: string;
}
export interface Story {
  id: string; personaRef: string; action: string; benefit: string;
  requirementRefs: string[]; acceptance: Acceptance[]; status: string; priority?: string;
}
export interface Decision { id: string; question: string; answer: string; status: string; rationale?: string; sourceRefs?: string[]; }
export interface OpenQuestion { id: string; question: string; status: string; relatedRefs?: string[]; answer?: string; }

export interface ContextOptions {
  task: AiTask;
  requirementIds?: string[];
  storyIds?: string[];
  includeDecisions?: boolean;
  includeOpenQuestions?: boolean;
  /** Hard bound on the JSON length of the whole envelope. Items are packed in priority order. */
  maxChars?: number;
}

export type Section = "requirements" | "stories" | "decisions" | "personas" | "openQuestions";

export interface OmittedItems {
  section: Section;
  ids: string[];
}

export interface AiContextEnvelope {
  protocol: "reqspec-context/1";
  task: AiTask;
  instructions: string[];
  context: Record<string, unknown>;
  output: { format: "json-patch" | "json"; allowedOperations: string[]; questionsPath?: string; shape?: string };
  /** Items that were eligible for this task but did not fit within maxChars. Empty when nothing was dropped. */
  omitted: OmittedItems[];
  estimatedTokens: number;
}

const taskInstructions: Record<AiTask, string[]> = {
  draft_requirements: ["Extract only confirmed facts.", "Mark unknowns as open questions.", "Do not invent constraints, users, metrics, or integrations."],
  find_ambiguities: ["Find vague, contradictory, or untestable statements.", "Return questions tied to exact IDs.", "Do not rewrite requirements."],
  suggest_acceptance: ["Suggest Given/When/Then criteria only for the selected requirements.", "Cover one happy path and one meaningful edge case.", "Do not change requirement intent."],
  review_completeness: ["Check traceability, testability, scope, and missing NFRs.", "Report findings with exact IDs.", "Do not introduce new requirements."],
  summarize_handoff: ["Summarize confirmed requirements for a coding agent.", "Include exclusions and unresolved questions.", "Do not include workflow instructions or unsupported assumptions."]
};

/**
 * Packing priority after the mandatory context (project, requirements the caller asked for,
 * stories the caller named). Earlier sections are kept first when the budget is tight.
 */
const PRIORITY: Section[] = ["decisions", "requirements", "stories", "personas", "openQuestions"];

/** Placeholder used while measuring, so the measured size never undercounts the final token estimate. */
const MEASURE_TOKENS = 99_999_999;

function compact<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (item === undefined || item === null || item === "") return undefined;
    if (Array.isArray(item) && item.length === 0) return undefined;
    return item;
  }));
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

/**
 * Checks every cross-reference in the spec. JSON Schema cannot do this, so the compiler does it.
 * Returns human-readable problems; an empty array means the references are consistent.
 */
export function checkReferences(spec: ReqSpec): string[] {
  const problems: string[] = [];
  const kinds = new Map<string, string>();
  const declare = (id: string, kind: string) => {
    const existing = kinds.get(id);
    if (existing) problems.push(`duplicate id "${id}" (${existing} and ${kind})`);
    else kinds.set(id, kind);
  };
  spec.personas.forEach((p) => declare(p.id, "persona"));
  spec.requirements.forEach((r) => declare(r.id, "requirement"));
  spec.stories.forEach((s) => declare(s.id, "story"));
  spec.decisions.forEach((d) => declare(d.id, "decision"));
  spec.openQuestions.forEach((q) => declare(q.id, "openQuestion"));

  const expectKind = (owner: string, ref: string, kind: string) => {
    if (kinds.get(ref) !== kind) problems.push(`${owner} references unknown ${kind} "${ref}"`);
  };
  // sourceRefs may point at any declared item, or at a project field such as "project.goal".
  const expectSource = (owner: string, ref: string) => {
    if (ref.startsWith("project.") || kinds.has(ref)) return;
    problems.push(`${owner} has unknown source "${ref}"`);
  };

  spec.requirements.forEach((r) => {
    (r.personaRefs ?? []).forEach((ref) => expectKind(r.id, ref, "persona"));
    (r.dependsOn ?? []).forEach((ref) => expectKind(r.id, ref, "requirement"));
    r.sourceRefs.forEach((ref) => expectSource(r.id, ref));
  });
  spec.stories.forEach((s) => {
    expectKind(s.id, s.personaRef, "persona");
    s.requirementRefs.forEach((ref) => expectKind(s.id, ref, "requirement"));
  });
  spec.decisions.forEach((d) => (d.sourceRefs ?? []).forEach((ref) => expectSource(d.id, ref)));
  spec.openQuestions.forEach((q) => (q.relatedRefs ?? []).forEach((ref) => {
    if (!kinds.has(ref)) problems.push(`${q.id} references unknown item "${ref}"`);
  }));
  return problems;
}

function assertKnown(kind: string, ids: string[], items: { id: string }[]): void {
  const known = new Set(items.map((item) => item.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new Error(`Unknown ${kind} id(s): ${unknown.join(", ")}`);
}

function outputFor(task: AiTask): AiContextEnvelope["output"] {
  if (task === "summarize_handoff") return { format: "json", shape: "handoff", allowedOperations: [] };
  return { format: "json-patch", allowedOperations: ["add", "replace", "remove"], questionsPath: "/openQuestions/-" };
}

type IdSets = Record<Section, Set<string>>;

function emptySets(): IdSets {
  return { requirements: new Set(), stories: new Set(), decisions: new Set(), personas: new Set(), openQuestions: new Set() };
}

function envelopeFor(
  spec: ReqSpec,
  task: AiTask,
  included: IdSets,
  omitted: OmittedItems[],
  estimatedTokens: number
): AiContextEnvelope {
  const context = compact({
    project: spec.project,
    personas: spec.personas.filter((item) => included.personas.has(item.id)),
    requirements: spec.requirements.filter((item) => included.requirements.has(item.id)),
    stories: spec.stories.filter((item) => included.stories.has(item.id)),
    decisions: spec.decisions.filter((item) => included.decisions.has(item.id)),
    openQuestions: spec.openQuestions.filter((item) => included.openQuestions.has(item.id))
  }) as Record<string, unknown>;
  return {
    protocol: "reqspec-context/1",
    task,
    instructions: taskInstructions[task],
    context,
    output: outputFor(task),
    omitted,
    estimatedTokens
  };
}

export function compileContext(spec: ReqSpec, options: ContextOptions): AiContextEnvelope {
  const problems = checkReferences(spec);
  if (problems.length > 0) throw new Error(`ReqSpec has invalid references:\n- ${problems.join("\n- ")}`);

  const requirementIds = options.requirementIds ?? [];
  const storyIds = options.storyIds ?? [];
  assertKnown("requirement", requirementIds, spec.requirements);
  assertKnown("story", storyIds, spec.stories);

  // No selection means the whole spec. Otherwise select the requested items and everything they reference.
  const selective = requirementIds.length > 0 || storyIds.length > 0;
  const reqById = new Map(spec.requirements.map((r) => [r.id, r]));

  // Stories: the ones named, else the ones that reference a requested requirement.
  const stories = !selective ? spec.stories
    : storyIds.length > 0 ? spec.stories.filter((s) => storyIds.includes(s.id))
    : spec.stories.filter((s) => s.requirementRefs.some((ref) => requirementIds.includes(ref)));

  // Seed requirements: the requested ones, plus any the selected stories reference.
  const seedReqIds = new Set(!selective
    ? spec.requirements.map((r) => r.id)
    : [...requirementIds, ...stories.flatMap((s) => s.requirementRefs)]);

  // Close over dependsOn so the model sees everything a selected requirement depends on.
  const reqIds = new Set(seedReqIds);
  const pending = [...seedReqIds];
  while (pending.length > 0) {
    const id = pending.pop() as string;
    for (const dep of reqById.get(id)?.dependsOn ?? []) {
      if (!reqIds.has(dep)) {
        reqIds.add(dep);
        pending.push(dep);
      }
    }
  }
  const requirements = spec.requirements.filter((r) => reqIds.has(r.id));

  const storyIdSet = new Set(stories.map((s) => s.id));
  const personaIds = new Set([
    ...requirements.flatMap((r) => r.personaRefs ?? []),
    ...stories.map((s) => s.personaRef)
  ]);
  const personas = !selective ? spec.personas : spec.personas.filter((p) => personaIds.has(p.id));

  // Decisions: confirmed ones that a selected requirement cites, or that cite a selected item.
  const citedByRequirement = new Set(requirements.flatMap((r) => r.sourceRefs));
  const scopeIds = new Set([...reqIds, ...storyIdSet]);
  const decisions = options.includeDecisions === false ? []
    : spec.decisions.filter((d) => d.status === "confirmed" && (!selective
      || citedByRequirement.has(d.id)
      || (d.sourceRefs ?? []).some((ref) => scopeIds.has(ref))));

  // Open questions: open ones that relate to something in the selection.
  const selectedIds = new Set<string>([
    ...scopeIds,
    ...personas.map((p) => p.id),
    ...decisions.map((d) => d.id)
  ]);
  const openQuestions = options.includeOpenQuestions === false ? []
    : spec.openQuestions.filter((q) => q.status === "open" && (!selective
      || (q.relatedRefs ?? []).some((ref) => selectedIds.has(ref))));

  // Universe: everything this task may see. Mandatory: the requirements and stories the caller named.
  const universe: IdSets = {
    requirements: new Set(requirements.map((r) => r.id)),
    stories: new Set(stories.map((s) => s.id)),
    decisions: new Set(decisions.map((d) => d.id)),
    personas: new Set(personas.map((p) => p.id)),
    openQuestions: new Set(openQuestions.map((q) => q.id))
  };
  const mandatory: IdSets = emptySets();
  seedReqIds.forEach((id) => mandatory.requirements.add(id));
  storyIds.forEach((id) => mandatory.stories.add(id));

  // Candidates in priority order: the mandatory set is never a candidate.
  const candidates: { section: Section; id: string }[] = [];
  for (const section of PRIORITY) {
    for (const id of universe[section]) {
      if (!mandatory[section].has(id)) candidates.push({ section, id });
    }
  }

  const included = emptySets();
  const omittedFrom = (start: number): OmittedItems[] => {
    const grouped = new Map<Section, string[]>();
    for (const item of candidates.slice(start)) {
      grouped.set(item.section, [...(grouped.get(item.section) ?? []), item.id]);
    }
    return [...grouped].map(([section, ids]) => ({ section, ids }));
  };
  const measure = (start: number, sets: IdSets) =>
    JSON.stringify(envelopeFor(spec, options.task, sets, omittedFrom(start), MEASURE_TOKENS)).length;

  if (options.maxChars === undefined) {
    (Object.keys(universe) as Section[]).forEach((section) => universe[section].forEach((id) => included[section].add(id)));
  } else {
    const budget = options.maxChars;
    (Object.keys(mandatory) as Section[]).forEach((section) => mandatory[section].forEach((id) => included[section].add(id)));
    const mandatorySize = measure(0, included);
    if (mandatorySize > budget) {
      throw new Error(`maxChars ${budget} is too small: the mandatory context alone needs ${mandatorySize} characters`);
    }
    let next = 0;
    for (; next < candidates.length; next++) {
      const { section, id } = candidates[next];
      included[section].add(id);
      if (measure(next + 1, included) > budget) {
        included[section].delete(id);
        break;
      }
    }
    // `next` is the first candidate that did not fit; everything from there on is omitted.
    const omitted = omittedFrom(next);
    const bounded = envelopeFor(spec, options.task, included, omitted, 0);
    return { ...bounded, estimatedTokens: estimateTokens(bounded) };
  }

  const complete = envelopeFor(spec, options.task, included, [], 0);
  return { ...complete, estimatedTokens: estimateTokens(complete) };
}

export function compileHandoff(spec: ReqSpec): AiContextEnvelope {
  return compileContext(spec, {
    task: "summarize_handoff",
    includeDecisions: true,
    includeOpenQuestions: true,
    maxChars: 30000
  });
}
