import { fanoutInnerSteps, hiddenDescendantIds, topoSort } from '@core/graph'
import { EXEC_STATUS_LABEL, STEP_TYPE_LABEL } from '@core/labels'
import type { RunDetails, StepDefinition, StepExecution } from '@core/types'

const GAP_X = 36
const GAP_Y = 32
const TEXT_W = 248
const TITLE_CHAR = 9
const TITLE_LH = 22
const META_CHAR = 7.6
const PILL_CHAR = 7.4

export type CanvasNode = {
  id: string
  x: number
  y: number
  w: number
  h: number
  title: string
  meta: string
  status: string
  role: 'step' | 'split' | 'item'
  stepId: string
  branchId: string
}

export type CanvasEdge = { id: string; from: string; to: string }

type Laid = { entryId: string | null; exitIds: string[]; width: number; height: number }

type Piece = {
  entryId: string | null
  exitIds: string[]
  width: number
  height: number
  ids: string[]
}

export function layoutRun(details: RunDetails): { nodes: CanvasNode[]; edges: CanvasEdge[]; width: number; height: number } {
  const nodes: CanvasNode[] = []
  const edges: CanvasEdge[] = []
  const laid = layoutChain(details, details.graph.steps, '', null, 0, 0, nodes, edges)
  return { nodes, edges, width: laid.width, height: laid.height }
}

export function nodeSize(title: string, meta: string, status: string): { w: number; h: number } {
  const titleLines = wrapLines(title, TEXT_W, TITLE_CHAR)
  const titleW = Math.max(...titleLines.map((line) => line.length * TITLE_CHAR), 0)
  const metaW = meta.length * META_CHAR
  const pill = EXEC_STATUS_LABEL[status as keyof typeof EXEC_STATUS_LABEL] ?? status
  const pillW = pill.length * PILL_CHAR + 18
  const inner = Math.max(titleW, metaW, pillW, 132)
  const h = 20 + titleLines.length * TITLE_LH + 8 + 18 + 22 + 8
  return { w: Math.ceil(inner + 24), h }
}

function layoutChain(
  details: RunDetails,
  source: StepDefinition[],
  parentBranchId: string,
  entryStepId: string | null,
  originX: number,
  originY: number,
  nodes: CanvasNode[],
  edges: CanvasEdge[]
): Laid {
  const hidden = hiddenDescendantIds(source, entryStepId)
  const local = source.filter((step) => !hidden.has(step.id))
  const sorted = topoSort(local)
  if (!sorted.ok || !sorted.steps.length) return { entryId: null, exitIds: [], width: 0, height: 0 }
  const parentBranch = details.branches.find((branch) => branch.id === parentBranchId)
  const pieces: Piece[] = []
  for (const step of sorted.steps) {
    if (step.iterate && step.id !== entryStepId) {
      pieces.push(fanoutPiece(details, source, step, parentBranchId, nodes, edges))
      continue
    }
    const execution = latestExecution(details.executions, step.id, parentBranchId)
    const item = Boolean(parentBranch && step.id === entryStepId)
    const title = item && parentBranch ? `${parentBranch.itemIndex + 1}. ${parentBranch.label}` : step.name
    const meta = item ? 'элемент' : STEP_TYPE_LABEL[step.type]
    const status = execution?.status ?? (item && parentBranch ? parentBranch.status : 'pending')
    const box = nodeSize(title, meta, status)
    const node = place(nodes, {
      id: `step:${step.id}:${parentBranchId}`,
      x: 0,
      y: 0,
      w: box.w,
      h: box.h,
      title,
      meta,
      status,
      role: item ? 'item' : 'step',
      stepId: step.id,
      branchId: parentBranchId
    })
    pieces.push({ entryId: node.id, exitIds: [node.id], width: box.w, height: box.h, ids: [node.id] })
  }
  const width = Math.max(...pieces.map((piece) => piece.width))
  let y = 0
  let entryId: string | null = null
  let exits: string[] = []
  for (const piece of pieces) {
    shift(nodes, piece.ids, originX + (width - piece.width) / 2, originY + y)
    if (!entryId) entryId = piece.entryId
    if (piece.entryId) {
      for (const exit of exits) link(edges, exit, piece.entryId)
    }
    exits = piece.exitIds
    y += piece.height + GAP_Y
  }
  return { entryId, exitIds: exits, width, height: Math.max(0, y - GAP_Y) }
}

function fanoutPiece(
  details: RunDetails,
  source: StepDefinition[],
  step: StepDefinition,
  parentBranchId: string,
  nodes: CanvasNode[],
  edges: CanvasEdge[]
): Piece {
  const branches = details.branches
    .filter((branch) => branch.parentBranchId === parentBranchId && branch.sourceStepId === step.id && branch.status !== 'cancelled')
    .sort((a, b) => (a.batch ?? 0) - (b.batch ?? 0) || a.itemIndex - b.itemIndex)
  const groups: Array<typeof branches> = []
  for (const branch of branches) {
    const batch = branch.batch ?? 0
    const last = groups[groups.length - 1]
    if (!last || (last[0].batch ?? 0) !== batch) groups.push([branch])
    else last.push(branch)
  }
  const inner = [step, ...fanoutInnerSteps(step.id, source)]
  const rows = groups.map((group) =>
    group.map((branch) => {
      const mark = nodes.length
      const laid = layoutChain(details, inner, branch.id, step.id, 0, 0, nodes, edges)
      return { laid, ids: nodes.slice(mark).map((node) => node.id) }
    })
  )
  const box = nodeSize(step.name, 'ветвление', splitStatus(details, step.id, parentBranchId))
  const split = place(nodes, {
    id: `split:${step.id}:${parentBranchId}`,
    x: 0,
    y: 0,
    w: box.w,
    h: box.h,
    title: step.name,
    meta: 'ветвление',
    status: splitStatus(details, step.id, parentBranchId),
    role: 'split',
    stepId: step.id,
    branchId: parentBranchId
  })
  const rowWidths = rows.map((row) => (row.length ? row.reduce((sum, child) => sum + child.laid.width, 0) + GAP_X * (row.length - 1) : 0))
  const rowHeights = rows.map((row) => (row.length ? Math.max(...row.map((child) => child.laid.height)) : 0))
  const childrenW = rowWidths.length ? Math.max(...rowWidths) : 0
  const childrenH = rowHeights.reduce((sum, height, index) => sum + height + (index ? GAP_Y : 0), 0)
  const width = Math.max(box.w, childrenW)
  const height = box.h + (rows.length ? GAP_Y + childrenH : 0)
  split.x = (width - box.w) / 2
  let rowY = box.h + GAP_Y
  const children = rows.flat()
  for (let index = 0; index < rows.length; index += 1) {
    let cursor = (width - rowWidths[index]) / 2
    for (const child of rows[index]) {
      shift(nodes, child.ids, cursor, rowY)
      if (child.laid.entryId) link(edges, split.id, child.laid.entryId)
      cursor += child.laid.width + GAP_X
    }
    rowY += rowHeights[index] + GAP_Y
  }
  const ids = [split.id, ...children.flatMap((child) => child.ids)]
  const exitIds = children.length ? children.flatMap((child) => child.laid.exitIds) : [split.id]
  return { entryId: split.id, exitIds, width, height, ids }
}

function place(nodes: CanvasNode[], node: CanvasNode): CanvasNode {
  nodes.push(node)
  return node
}

function shift(nodes: CanvasNode[], ids: string[], dx: number, dy: number): void {
  if (!dx && !dy) return
  const wanted = new Set(ids)
  for (const node of nodes) {
    if (!wanted.has(node.id)) continue
    node.x += dx
    node.y += dy
  }
}

function link(edges: CanvasEdge[], from: string, to: string): void {
  edges.push({ id: `${from}->${to}`, from, to })
}

function splitStatus(details: RunDetails, stepId: string, parentBranchId: string): string {
  const branches = details.branches.filter((branch) => branch.parentBranchId === parentBranchId && branch.sourceStepId === stepId && branch.status !== 'cancelled')
  if (!branches.length) {
    const error = latestExecution(details.executions, stepId, parentBranchId)
    return error?.status === 'failed' ? 'failed' : 'pending'
  }
  if (branches.every((branch) => branch.status === 'completed')) return 'completed'
  if (branches.some((branch) => branch.status === 'failed')) return 'failed'
  if (branches.some((branch) => branch.status === 'running')) return 'running'
  if (branches.some((branch) => branch.status === 'waiting_for_user')) return 'waiting_for_user'
  return 'paused'
}

function latestExecution(executions: StepExecution[], stepId: string, branchId: string): StepExecution | undefined {
  return executions.filter((item) => item.stepId === stepId && item.branchId === branchId).sort((a, b) => b.attempt - a.attempt)[0]
}

function wrapLines(text: string, maxWidth: number, charWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (!words.length) return ['']
  const limit = Math.max(maxWidth, ...words.map((word) => word.length * charWidth))
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length * charWidth <= limit) current = next
    else {
      if (current) lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines
}
