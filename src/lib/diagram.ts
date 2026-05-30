/**
 * Deterministic renderers for a playbook's control flow.
 *
 *  - `ascii`   : a top-to-bottom annotated step list with explicit edges. Robust
 *                and terminal-friendly; relies on document order for the implicit
 *                happy-path (whose exact semantics are intentionally informal).
 *  - `mermaid` : a `flowchart` graph (renders on GitHub/docs). Explicit edges are
 *                solid+labelled; implicit fall-through is dotted.
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

const GLYPH: Record<string, string> = {
  actor_call: '●',
  tool_call: '⚙',
  evaluator: '⊙',
  gate: '◇',
  human_gate: '▢',
  router: '⤨',
  map: '⊞',
  replicate: '⧉',
  join: '⊕',
  reduce: '⊟',
  loop: '↻',
  artifact_op: '✎',
  subworkflow: '⊡',
};

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

/** Explicit single-target edges, as `[label, target]`. */
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

function renderAscii(playbook: Playbook): string {
  const flow = steps(playbook);
  const lines = header(playbook);
  const entry = str(flow[0]?.id);
  lines.push(`steps run top-to-bottom unless an arrow redirects${entry ? ` · entry: ${entry}` : ''}`);
  lines.push('');

  const idWidth = Math.min(
    Math.max(0, ...flow.map((s) => (str(s.id) ?? '').length)),
    28,
  );
  const usedKinds = new Set<string>();

  flow.forEach((step, index) => {
    const id = str(step.id) ?? `?${index}`;
    const kind = str(step.kind) ?? '?';
    usedKinds.add(kind);
    const glyph = GLYPH[kind] ?? '·';
    const det = detail(step);
    const edgeStrs = edges(step).map(([label, target]) =>
      label === '→' ? `→ ${target}` : `${label}→${target}`,
    );

    const isLast = index === flow.length - 1;
    const terminal = edgeStrs.length === 0 && bodySteps(step).length === 0 && isLast;

    const left = `  ${glyph} ${id.padEnd(idWidth)}  ${kind.padEnd(11)}`;
    const right = [det, ...edgeStrs, terminal ? '■ end' : ''].filter(Boolean).join('   ');
    lines.push(right ? `${left} ${right}` : left.trimEnd());

    const body = bodySteps(step);
    if (body.length > 0) {
      const indent = ' '.repeat(left.length - 11);
      lines.push(`${indent}body: ${body.join(' → ')}`);
    }
    const exhausted = str(step.on_exhausted);
    if (exhausted) {
      const indent = ' '.repeat(left.length - 11);
      lines.push(`${indent}exhausted → ${exhausted}`);
    }
  });

  lines.push('');
  lines.push(
    'legend: ' +
      [...usedKinds]
        .filter((k) => GLYPH[k])
        .map((k) => `${GLYPH[k]} ${k}`)
        .join('   '),
  );
  return lines.join('\n');
}

function mermaidLabel(step: Step): string {
  const id = str(step.id) ?? '?';
  const kind = str(step.kind) ?? '?';
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
