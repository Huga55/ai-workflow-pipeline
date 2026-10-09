import { useEffect, useRef, useState } from 'react'
import type { Branch, RunDetails } from '@core/types'
import { layoutRun, type CanvasNode } from '@core/run-layout'
import { StatusPill } from './ui'

export type { CanvasNode }

export function RunCanvas({
  details,
  selectedId,
  onSelect
}: {
  details: RunDetails
  selectedId: string | null
  onSelect: (node: CanvasNode) => void
}) {
  const stageRef = useRef<HTMLDivElement>(null)
  const fitKey = useRef('')
  const fit = useRef({ x: 28, y: 28, scale: 1 })
  const [view, setView] = useState(fit.current)
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null)
  const layout = layoutRun(details)
  const worldW = Math.max(640, layout.width + 64)
  const worldH = Math.max(420, layout.height + 64)

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const rect = stage.getBoundingClientRect()
    if (rect.width < 40 || rect.height < 40) return
    const key = `${details.run.id}:${details.branches.length}:${layout.nodes.length}:${layout.width}:${layout.height}`
    if (fitKey.current === key) return
    fitKey.current = key
    const pad = 56
    const scale = clamp(Math.min((rect.width - pad) / Math.max(layout.width, 1), (rect.height - pad) / Math.max(layout.height, 1), 1), 0.2, 1)
    const next = { x: 28, y: 28, scale }
    fit.current = next
    setView(next)
  }, [details.run.id, details.branches.length, layout.nodes.length, layout.width, layout.height])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = stage.getBoundingClientRect()
      const px = event.clientX - rect.left
      const py = event.clientY - rect.top
      setView((current) => {
        const next = clamp(current.scale * (event.deltaY < 0 ? 1.08 : 0.92), 0.2, 1.7)
        const worldX = (px - current.x) / current.scale
        const worldY = (py - current.y) / current.scale
        return { scale: next, x: px - worldX * next, y: py - worldY * next }
      })
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [])

  return (
    <div
      ref={stageRef}
      className="canvas-stage"
      onPointerDown={(event) => {
        if (event.target instanceof Element && event.target.closest('.canvas-node, .canvas-tools')) return
        event.preventDefault()
        window.getSelection()?.removeAllRanges()
        drag.current = { px: event.clientX, py: event.clientY, x: view.x, y: view.y }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        const start = drag.current
        if (!start) return
        window.getSelection()?.removeAllRanges()
        setView((current) => ({ ...current, x: start.x + event.clientX - start.px, y: start.y + event.clientY - start.py }))
      }}
      onPointerUp={() => {
        drag.current = null
      }}
    >
      <div className="canvas-tools">
        <button className="ghost" type="button" onClick={() => setView((current) => ({ ...current, scale: clamp(current.scale * 1.1, 0.2, 1.7) }))}>
          +
        </button>
        <button className="ghost" type="button" onClick={() => setView((current) => ({ ...current, scale: clamp(current.scale / 1.1, 0.2, 1.7) }))}>
          −
        </button>
        <button className="ghost" type="button" onClick={() => setView(fit.current)}>
          Сбросить
        </button>
      </div>
      <div className="canvas-world" style={{ width: worldW, height: worldH, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
        <svg className="canvas-edges" width={worldW} height={worldH}>
          {layout.edges.map((edge) => {
            const from = layout.nodes.find((node) => node.id === edge.from)
            const to = layout.nodes.find((node) => node.id === edge.to)
            if (!from || !to) return null
            return <path key={edge.id} d={edgePath(from, to)} />
          })}
        </svg>
        {layout.nodes.map((node) => (
          <button
            key={node.id}
            className={`canvas-node status-${node.status}${selectedId === node.id ? ' on' : ''}`}
            style={{ left: node.x, top: node.y, width: node.w, height: node.h }}
            type="button"
            title={node.title}
            onPointerDown={(event) => {
              event.stopPropagation()
              window.getSelection()?.removeAllRanges()
            }}
            onClick={() => onSelect(node)}
          >
            <span className="canvas-node-title">{node.title}</span>
            <span className="meta">{node.meta}</span>
            <StatusPill status={node.status} />
          </button>
        ))}
      </div>
    </div>
  )
}

export function branchOf(details: RunDetails, node: CanvasNode): Branch | undefined {
  return details.branches.find((branch) => branch.id === node.branchId)
}

function edgePath(from: CanvasNode, to: CanvasNode): string {
  const x1 = from.x + from.w / 2
  const y1 = from.y + from.h
  const x2 = to.x + to.w / 2
  const y2 = to.y
  const mid = (y1 + y2) / 2
  return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
