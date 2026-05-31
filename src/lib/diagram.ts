/**
 * Deterministic renderers for a playbook's control flow.
 *
 *  - `ascii`   : a top-to-bottom column of boxed "cards", one per step. A `▼`
 *                connector means control falls through to the next card; a `⋮`
 *                means the next card is reached only via a labelled `▶` arrow
 *                (a gate branch, router route, loop exit, or explicit jump).
 *                No 2-D edge routing, so it stays correct for any playbook.
 *  - `mermaid` : a `flowchart` graph (renders on GitHub/docs). Explicit edges are
 *                solid+labelled; implicit fall-through is dotted.
 *
 * Primitive `kind`s are abbreviated for display only (`actor_call` → `actor`,
 * etc. — see `KIND_LABEL`); the schema/vocabulary keep the full names.
 */

export type DiagramFormat = 'ascii' | 'mermaid';

interface Step {
  id?: unknown;
  kind?: unknown;
  actor?: unknown;
  tool?: unknown;
  over?: unknown;
  output?: unknown;
  condition?: unknown;
  prompt?: unknown;
  next?: unknown;
  on_pass?: unknown;
  on_fail?: unknown;
  on_approve?: unknown;
  on_reject?: unknown;
  on_exhausted?: unknown;
  default?: unknown;
  body?: unknown;
  routes?: unknown;
  max_iterations?: unknown;
  until?: unknown;
  [key: string]: unknown;
}

interface Playbook {
  name?: unknown;
  description?: unknown;
  roles?: unknown;
  flow?: unknown;
}

/** Display-only short labels for verbose primitive kinds (schema keeps the full names). */
const KIND_LABEL: Record<string, string> = {
  actor_call: 'actor',
  tool_call: 'tool',
  evaluator: 'eval',
  human_gate: 'ask',
  artifact_op: 'artifact',
  subworkflow: 'subflow',
};

function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function steps(playbook: Playbook): Step[] {
  return Array.isArray(playbook.flow) ? (playbook.flow as Step[]) : [];
}

/** The "what this step does" annotation (role / tool / condition / list). */
function detail(step: Step): string {
  switch (step.kind) {
    case 'actor_call':
    case 'evaluator':
    case 'reduce':
    case 'replicate':
      return str(step.actor) ?? '';
    case 'tool_call':
      return str(step.tool) ?? '';
    case 'map': {
      if (Array.isArray(step.over)) return `over [${step.over.join(', ')}]`;
      const over = str(step.over);
      return over ? `over ${over}` : '';
    }
    case 'gate':
      return str(step.condition) ?? '';
    case 'human_gate':
      return str(step.prompt) ?? '';
    case 'loop': {
      const parts: string[] = [];
      if (typeof step.max_iterations === 'number') parts.push(`max ${step.max_iterations}`);
      const until = str(step.until);
      if (until) parts.push(`until ${until}`);
      return parts.join(' · ');
    }
    case 'subworkflow':
      return str(step.playbook) ?? '';
    default:
      return '';
  }
}

/** Explicit single-target edges, as `[label, target]` (used by the mermaid renderer). */
function edges(step: Step): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const push = (label: string, value: unknown): void => {
    const target = str(value);
    if (target) out.push([label, target]);
  };
  switch (step.kind) {
    case 'gate':
      push('✓', step.on_pass);
      push('✗', step.on_fail);
      break;
    case 'human_gate':
      push('approve', step.on_approve);
      push('reject', step.on_reject);
      break;
    case 'router':
      if (step.routes && typeof step.routes === 'object' && !Array.isArray(step.routes)) {
        for (const [label, target] of Object.entries(step.routes as Record<string, unknown>)) {
          push(label, target);
        }
      }
      push('default', step.default);
      break;
    default:
      break;
  }
  push('→', step.next);
  return out;
}

/** Labelled `▶` branch lines to show inside an ASCII card (gate / human_gate / router). */
function branchLines(step: Step): string[] {
  const out: string[] = [];
  const arrow = (mark: string, value: unknown): void => {
    const target = str(value);
    if (target) out.push(`${mark} ▶ ${target}`);
  };
  switch (step.kind) {
    case 'gate':
      arrow('✓ pass', step.on_pass);
      arrow('✗ fail', step.on_fail);
      break;
    case 'human_gate':
      arrow('✓ approve', step.on_approve);
      arrow('✗ reject', step.on_reject);
      break;
    case 'router':
      if (step.routes && typeof step.routes === 'object' && !Array.isArray(step.routes)) {
        for (const [label, target] of Object.entries(step.routes as Record<string, unknown>)) {
          arrow(label, target);
        }
      }
      arrow('default', step.default);
      break;
    default:
      break;
  }
  return out;
}

function bodySteps(step: Step): string[] {
  return Array.isArray(step.body) ? step.body.filter((b): b is string => typeof b === 'string') : [];
}

function header(playbook: Playbook): string[] {
  const lines: string[] = [];
  const name = str(playbook.name) ?? '(unnamed playbook)';
  lines.push(name);
  const desc = str(playbook.description);
  if (desc) {
    const oneLine = desc.replace(/\s+/g, ' ').trim();
    lines.push(oneLine.length > 96 ? `${oneLine.slice(0, 95)}…` : oneLine);
  }
  if (playbook.roles && typeof playbook.roles === 'object') {
    lines.push(`roles: ${Object.keys(playbook.roles as object).join(', ')}`);
  }
  return lines;
}

interface Card {
  id: string;
  kindLabel: string;
  body: string[];
  /** Whether a `▼` fall-through connector (and a `┬` in the bottom border) follows. */
  fallsThrough: boolean;
}

const MIN_INNER = 26;
const MAX_INNER = 60;

/** Pad or ellipsis-truncate `s` to exactly `width` characters. */
function fit(s: string, width: number): string {
  if (s.length === width) return s;
  if (s.length < width) return s + ' '.repeat(width - s.length);
  if (width <= 1) return s.slice(0, width);
  return `${s.slice(0, width - 1)}…`;
}

function buildCards(flow: Step[]): Card[] {
  // Steps that belong to a loop body are shown inside their loop's card (as a
  // `body:` line), not as standalone cards.
  const bodyMembers = new Set<string>();
  for (const s of flow) for (const b of bodySteps(s)) bodyMembers.add(b);
  const rendered = flow.filter((s) => {
    const id = str(s.id);
    return id === undefined || !bodyMembers.has(id);
  });

  return rendered.map((step, i) => {
    const id = str(step.id) ?? `?${i}`;
    const kind = str(step.kind) ?? '?';
    const nextRenderedId = str(rendered[i + 1]?.id);
    const hasNextCard = nextRenderedId !== undefined;

    const content: string[] = [];
    const det = detail(step);
    if (det) content.push(det);

    const body = bodySteps(step);
    if (body.length > 0) content.push(`body: ${body.join(' ▶ ')}`);
    const exhausted = str(step.on_exhausted);
    if (exhausted) content.push(`⤓ exhausted ▶ ${exhausted}`);
    for (const line of branchLines(step)) content.push(line);

    const hasOtherOut = branchLines(step).length > 0 || body.length > 0 || exhausted !== undefined;
    const nextTarget = str(step.next);
    let fallsThrough = false;
    if (nextTarget !== undefined) {
      if (nextTarget === nextRenderedId && !hasOtherOut) {
        fallsThrough = true; // plain sequential flow to the next card
      } else {
        content.push(`▶ ${nextTarget}`); // a jump elsewhere
      }
    } else if (!hasOtherOut) {
      if (hasNextCard) fallsThrough = true; // implicit top-to-bottom fall-through
      else content.push('■ end'); // terminal
    }

    return { id, kindLabel: kindLabel(kind), body: content, fallsThrough: fallsThrough && hasNextCard };
  });
}

function renderCard(card: Card, inner: number): string[] {
  const out: string[] = [];
  const left = `─ ${card.id} `;
  const right = ` ${card.kindLabel} ─`;
  const dashes = Math.max(1, inner - left.length - right.length);
  out.push(`┌${left}${'─'.repeat(dashes)}${right}┐`);

  const lines = card.body.length > 0 ? card.body : [''];
  for (const line of lines) out.push(`│${fit(` ${line}`, inner)}│`);

  const center = Math.floor(inner / 2);
  out.push(
    card.fallsThrough
      ? `└${'─'.repeat(center)}┬${'─'.repeat(inner - center - 1)}┘`
      : `└${'─'.repeat(inner)}┘`,
  );
  return out;
}

function connector(inner: number, marker: '▼' | '⋮'): string {
  return `${' '.repeat(1 + Math.floor(inner / 2))}${marker}`;
}

function renderAscii(playbook: Playbook): string {
  const flow = steps(playbook);
  const lines = header(playbook);
  const entry = str(flow[0]?.id);
  lines.push(`flow runs top-to-bottom; ▶ redirects${entry ? ` · entry: ${entry}` : ''}`);
  lines.push('');

  const cards = buildCards(flow);

  let inner = MIN_INNER;
  for (const c of cards) {
    inner = Math.max(inner, `─ ${c.id} `.length + ` ${c.kindLabel} ─`.length + 1);
    for (const line of c.body) inner = Math.max(inner, line.length + 2);
  }
  inner = Math.min(inner, MAX_INNER);

  cards.forEach((card, i) => {
    for (const line of renderCard(card, inner)) lines.push(line);
    if (i < cards.length - 1) lines.push(connector(inner, card.fallsThrough ? '▼' : '⋮'));
  });

  return lines.join('\n');
}

function mermaidLabel(step: Step): string {
  const id = str(step.id) ?? '?';
  const kind = kindLabel(str(step.kind) ?? '?');
  const det = detail(step);
  const text = det ? `${id}<br/>${kind}: ${det}` : `${id}<br/>${kind}`;
  return text.replace(/"/g, "'");
}

function mermaidNode(step: Step): string {
  const id = str(step.id) ?? '?';
  const label = `"${mermaidLabel(step)}"`;
  switch (step.kind) {
    case 'gate':
      return `${id}{${label}}`;
    case 'human_gate':
      return `${id}{{${label}}}`;
    case 'loop':
      return `${id}[/${label}/]`;
    case 'subworkflow':
      return `${id}[[${label}]]`;
    default:
      return `${id}[${label}]`;
  }
}

function renderMermaid(playbook: Playbook): string {
  const flow = steps(playbook);
  const lines = ['flowchart TD'];
  for (const line of header(playbook)) lines.push(`  %% ${line}`);

  const bodyMembers = new Set<string>();
  for (const step of flow) for (const b of bodySteps(step)) bodyMembers.add(b);

  for (const step of flow) lines.push(`  ${mermaidNode(step)}`);

  flow.forEach((step, index) => {
    const id = str(step.id);
    if (!id) return;

    const explicit = edges(step);
    for (const [label, target] of explicit) {
      const edgeLabel = label === '→' ? 'next' : label === '✓' ? 'pass' : label === '✗' ? 'fail' : label;
      lines.push(`  ${id} -->|${edgeLabel}| ${target}`);
    }

    const body = bodySteps(step);
    if (body.length > 0) {
      lines.push(`  ${id} -.->|body| ${body[0]}`);
      for (let i = 0; i < body.length - 1; i += 1) lines.push(`  ${body[i]} -.-> ${body[i + 1]}`);
    }
    const exhausted = str(step.on_exhausted);
    if (exhausted) lines.push(`  ${id} -->|exhausted| ${exhausted}`);

    // Implicit fall-through: a step with no explicit out-edge, not driven by a loop body.
    const hasExplicitOut = explicit.length > 0 || body.length > 0 || Boolean(exhausted);
    const nextStep = flow[index + 1];
    const nextId = str(nextStep?.id);
    if (!hasExplicitOut && nextId && !bodyMembers.has(id)) {
      lines.push(`  ${id} -.->|next| ${nextId}`);
    }
  });

  return lines.join('\n');
}

export function renderDiagram(playbook: Playbook, format: DiagramFormat = 'ascii'): string {
  return format === 'mermaid' ? renderMermaid(playbook) : renderAscii(playbook);
}
