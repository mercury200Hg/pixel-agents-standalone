import { useState, useEffect } from 'react'
import type { ToolActivity } from '../types.js'
import type { OfficeState } from '../engine/officeState.js'
import type { SubagentCharacter, ApprovalRequest } from '../../hooks/useExtensionMessages.js'
import { TILE_SIZE, CharacterState } from '../types.js'
import { TOOL_OVERLAY_VERTICAL_OFFSET, CHARACTER_SITTING_OFFSET_PX } from '../../constants.js'
import { vscode } from '../../vscodeApi.js'

interface ToolOverlayProps {
  officeState: OfficeState
  agents: number[]
  agentTools: Record<number, ToolActivity[]>
  subagentCharacters: SubagentCharacter[]
  pendingApprovals: ApprovalRequest[]
  containerRef: React.RefObject<HTMLDivElement | null>
  zoom: number
  panRef: React.RefObject<{ x: number; y: number }>
  onCloseAgent: (id: number) => void
}

const RISK_COLORS: Record<string, string> = {
  read: 'var(--pixel-risk-read)',
  write: 'var(--pixel-risk-write)',
  destructive: 'var(--pixel-risk-destructive)',
}

function ApprovalButtons({ approval }: { approval: ApprovalRequest }) {
  const [hovered, setHovered] = useState<string | null>(null)

  const respond = (decision: 'allow' | 'deny', scope: 'once' | 'session') => {
    vscode.postMessage({ type: 'approvalResponse', requestId: approval.requestId, decision, scope })
  }

  const btnBase: React.CSSProperties = {
    fontSize: '16px',
    padding: '1px 6px',
    border: '1px solid var(--pixel-border)',
    borderRadius: 0,
    cursor: 'pointer',
    color: '#fff',
    lineHeight: 1.2,
  }

  return (
    <div style={{ display: 'flex', gap: 3, marginTop: 3 }}>
      <button
        style={{ ...btnBase, background: hovered === 'allow' ? 'var(--pixel-approve-hover)' : 'var(--pixel-approve-bg)' }}
        onClick={(e) => { e.stopPropagation(); respond('allow', 'once') }}
        onMouseEnter={() => setHovered('allow')}
        onMouseLeave={() => setHovered(null)}
        title="Allow this tool call"
      >
        Allow
      </button>
      <button
        style={{ ...btnBase, background: hovered === 'session' ? 'var(--pixel-approve-hover)' : 'var(--pixel-approve-bg)' }}
        onClick={(e) => { e.stopPropagation(); respond('allow', 'session') }}
        onMouseEnter={() => setHovered('session')}
        onMouseLeave={() => setHovered(null)}
        title="Allow this tool type for the rest of the session"
      >
        Session
      </button>
      <button
        style={{ ...btnBase, background: hovered === 'deny' ? 'var(--pixel-deny-hover)' : 'var(--pixel-deny-bg)' }}
        onClick={(e) => { e.stopPropagation(); respond('deny', 'once') }}
        onMouseEnter={() => setHovered('deny')}
        onMouseLeave={() => setHovered(null)}
        title="Deny this tool call"
      >
        Deny
      </button>
    </div>
  )
}

/** Derive a short human-readable activity string from tools/status */
function getActivityText(
  agentId: number,
  agentTools: Record<number, ToolActivity[]>,
  isActive: boolean,
): string {
  const tools = agentTools[agentId]
  if (tools && tools.length > 0) {
    // Find the latest non-done tool
    const activeTool = [...tools].reverse().find((t) => !t.done)
    if (activeTool) {
      if (activeTool.permissionWait) return 'Needs approval'
      return activeTool.status
    }
    // All tools done but agent still active (mid-turn) — keep showing last tool status
    if (isActive) {
      const lastTool = tools[tools.length - 1]
      if (lastTool) return lastTool.status
    }
  }

  return 'Idle'
}

export function ToolOverlay({
  officeState,
  agents,
  agentTools,
  subagentCharacters,
  pendingApprovals,
  containerRef,
  zoom,
  panRef,
  onCloseAgent,
}: ToolOverlayProps) {
  const [, setTick] = useState(0)
  useEffect(() => {
    let rafId = 0
    const tick = () => {
      setTick((n) => n + 1)
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [])

  const el = containerRef.current
  if (!el) return null
  const rect = el.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const canvasW = Math.round(rect.width * dpr)
  const canvasH = Math.round(rect.height * dpr)
  const layout = officeState.getLayout()
  const mapW = layout.cols * TILE_SIZE * zoom
  const mapH = layout.rows * TILE_SIZE * zoom
  const deviceOffsetX = Math.floor((canvasW - mapW) / 2) + Math.round(panRef.current.x)
  const deviceOffsetY = Math.floor((canvasH - mapH) / 2) + Math.round(panRef.current.y)

  const selectedId = officeState.selectedAgentId
  const hoveredId = officeState.hoveredAgentId

  // All character IDs
  const allIds = [...agents, ...subagentCharacters.map((s) => s.id)]

  return (
    <>
      {allIds.map((id) => {
        const ch = officeState.characters.get(id)
        if (!ch) return null

        const isSelected = selectedId === id
        const isHovered = hoveredId === id
        const isSub = ch.isSubagent
        const showDetails = isSelected || isHovered

        // Position above character
        const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0
        const screenX = (deviceOffsetX + ch.x * zoom) / dpr
        const screenY = (deviceOffsetY + (ch.y + sittingOffset - TOOL_OVERLAY_VERTICAL_OFFSET) * zoom) / dpr

        // Always show name label; show activity details on hover/select
        const displayName = ch.folderName || (isSub ? 'Subtask' : `Agent #${id}`)

        // Check for pending approval for this agent
        const agentApprovals = pendingApprovals.filter((a) => a.agentId === id)
        const hasApproval = agentApprovals.length > 0

        // Get activity text (only needed when showing details)
        let activityText = ''
        let dotColor: string | null = null
        if (showDetails || hasApproval) {
          if (hasApproval) {
            const approval = agentApprovals[0]
            activityText = approval.summary
            dotColor = RISK_COLORS[approval.riskLevel] || 'var(--pixel-status-permission)'
          } else {
            const subHasPermission = isSub && ch.bubbleType === 'permission'
            if (isSub) {
              if (subHasPermission) {
                activityText = 'Needs approval'
              } else {
                const sub = subagentCharacters.find((s) => s.id === id)
                activityText = sub ? sub.label : 'Subtask'
              }
            } else {
              activityText = getActivityText(id, agentTools, ch.isActive)
            }

            const tools = agentTools[id]
            const hasPermission = subHasPermission || tools?.some((t) => t.permissionWait && !t.done)
            const hasActiveTools = tools?.some((t) => !t.done)
            const isActive = ch.isActive

            if (hasPermission) {
              dotColor = 'var(--pixel-status-permission)'
            } else if (isActive && hasActiveTools) {
              dotColor = 'var(--pixel-status-active)'
            }
          }
        }

        // Approval cards are always interactive
        const isInteractive = isSelected || hasApproval

        return (
          <div
            key={id}
            style={{
              position: 'absolute',
              left: screenX,
              top: screenY - 24,
              transform: 'translateX(-50%)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              pointerEvents: isInteractive ? 'auto' : 'none',
              zIndex: hasApproval ? 'var(--pixel-overlay-selected-z)' : isSelected ? 'var(--pixel-overlay-selected-z)' : 'var(--pixel-overlay-z)',
            }}
          >
            {hasApproval ? (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  background: 'var(--pixel-bg)',
                  border: `2px solid ${RISK_COLORS[agentApprovals[0].riskLevel] || 'var(--pixel-border)'}`,
                  borderRadius: 0,
                  padding: '4px 8px',
                  boxShadow: 'var(--pixel-shadow)',
                  maxWidth: 280,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: dotColor || 'var(--pixel-status-permission)',
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      fontSize: '16px',
                      color: 'var(--pixel-text-dim)',
                      flexShrink: 0,
                    }}
                  >
                    {displayName}
                  </span>
                </div>
                <span
                  style={{
                    fontSize: '20px',
                    color: 'var(--vscode-foreground)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    display: 'block',
                    marginTop: 2,
                  }}
                >
                  {activityText}
                </span>
                <ApprovalButtons approval={agentApprovals[0]} />
                {agentApprovals.length > 1 && (
                  <span style={{ fontSize: '14px', color: 'var(--pixel-text-dim)', marginTop: 2 }}>
                    +{agentApprovals.length - 1} more pending
                  </span>
                )}
              </div>
            ) : showDetails ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  background: 'var(--pixel-bg)',
                  border: isSelected
                    ? '2px solid var(--pixel-border-light)'
                    : '2px solid var(--pixel-border)',
                  borderRadius: 0,
                  padding: isSelected ? '3px 6px 3px 8px' : '3px 8px',
                  boxShadow: 'var(--pixel-shadow)',
                  whiteSpace: 'nowrap',
                  maxWidth: 220,
                }}
              >
                {dotColor && (
                  <span
                    className={ch.isActive && dotColor !== 'var(--pixel-status-permission)' ? 'pixel-agents-pulse' : undefined}
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: dotColor,
                      flexShrink: 0,
                    }}
                  />
                )}
                <div style={{ overflow: 'hidden' }}>
                  <span
                    style={{
                      fontSize: isSub ? '20px' : '22px',
                      fontStyle: isSub ? 'italic' : undefined,
                      color: 'var(--vscode-foreground)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      display: 'block',
                    }}
                  >
                    {activityText}
                  </span>
                  <span
                    style={{
                      fontSize: '16px',
                      color: 'var(--pixel-text-dim)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      display: 'block',
                    }}
                  >
                    {displayName}
                  </span>
                </div>
                {isSelected && !isSub && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onCloseAgent(id)
                    }}
                    title="Close agent"
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--pixel-close-text)',
                      cursor: 'pointer',
                      padding: '0 2px',
                      fontSize: '26px',
                      lineHeight: 1,
                      marginLeft: 2,
                      flexShrink: 0,
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.color = 'var(--pixel-close-hover)'
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.color = 'var(--pixel-close-text)'
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            ) : (
              <div
                style={{
                  background: 'var(--pixel-bg)',
                  border: '1px solid var(--pixel-border)',
                  padding: '1px 6px',
                  boxShadow: 'var(--pixel-shadow)',
                  whiteSpace: 'nowrap',
                }}
              >
                <span
                  style={{
                    fontSize: '16px',
                    color: 'var(--pixel-text-dim)',
                  }}
                >
                  {displayName}
                </span>
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}
