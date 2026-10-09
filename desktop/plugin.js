/**
 * Obsidian Memory — the desktop half of the unified `obsidian-memory` package.
 *
 * One installable folder, two SDKs:
 *   - agent half:     plugin.yaml + dashboard/plugin_api.py  (FastAPI routes
 *                     mounted at /api/plugins/obsidian-memory/)
 *   - desktop half:   this file (page, sidebar nav, palette, keybind, chip)
 *
 * Reaches the SAME backend the dashboard tab uses, through `ctx.rest` — no
 * duplicate Python, one source of truth for vault discovery.
 *
 * Ships OFF by default (`defaultEnabled: false`), matching the Python half's
 * `plugins.enabled` gate. Enable in Capabilities → Plugins.
 *
 * Plain ESM, loaded uncompiled: jsx() calls, not JSX syntax. Only
 * @hermes/plugin-sdk, react and react/jsx-runtime resolve.
 */

import {
  atom,
  Button,
  cn,
  Codicon,
  createBudgetedLoop,
  host,
  KEYBINDS_AREA,
  PALETTE_AREA,
  PanelAction,
  PanelBody,
  PanelDetail,
  PanelEmpty,
  PanelHeader,
  PanelList,
  PanelListRow,
  PanelMeta,
  ROUTES_AREA,
  SegmentedControl,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  Streamdown,
  Tip,
  usePluginI18n,
  useQuery,
  useQueryClient,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'obsidian-memory'
const PATH = '/obsidian'

// ─── i18n ────────────────────────────────────────────────────────────

const EN = {
  nav: 'Obsidian',
  openVault: 'Open Obsidian vault',
  pageTitle: 'Obsidian',
  notes: 'Notes',
  graph: 'Graph',
  searchPlaceholder: 'Search notes…',
  selectNote: 'Select a note to view',
  noNotes: 'No notes found',
  edit: 'Edit',
  save: 'Save',
  cancel: 'Cancel',
  saved: 'Saved',
  saving: 'Saving…',
  linkedFrom: 'Linked from',
  refresh: 'Refresh',
  close: 'Close',
  add: 'Zoom in',
  remove: 'Zoom out',
  discard: 'Reset view',
  graphEmpty: 'No links to graph',
  loadError: 'Could not load the vault',
  folder: 'Folder',
  words: 'Words',
  links: 'Links',
  modified: 'Modified'
}

const LOCALES = {
  en: {
    ...EN,
    stats: (notes, words, folders) => `${notes} notes · ${words.toLocaleString()} words · ${folders} folders`
  }
}

// ─── Data layer ──────────────────────────────────────────────────────

let rest = null

function q(vault) {
  return vault ? `?vault=${encodeURIComponent(vault)}` : ''
}

function vaultListKey() {
  return [ID, 'vaults']
}

function vaultKey(vault) {
  return [ID, 'vault', vault]
}

function noteKey(vault, path) {
  return [ID, 'note', vault, path]
}

// ─── Graph view (canvas, force-directed) ─────────────────────────────

const FOLDER_PALETTE = [
  'var(--ui-accent)',
  'oklch(0.72 0.14 30)',
  'oklch(0.75 0.12 90)',
  'oklch(0.65 0.14 300)',
  'oklch(0.7 0.12 200)',
  'var(--ui-text-tertiary)'
]

function folderColor(folder, folders) {
  const idx = folders.indexOf(folder)
  return FOLDER_PALETTE[(idx >= 0 ? idx : 0) % FOLDER_PALETTE.length]
}

// Pan/zoom lives in an atom so React state changes trigger a redraw without
// rebuilding the simulation.
const graphView = atom({ offsetX: 0, offsetY: 0, scale: 1 })

function GraphView({ folders, graph, onSelect, selected }) {
  const t = usePluginI18n(ID)
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const view = useValue(graphView)
  const [hovered, setHovered] = useState(null)

  // Simulation state kept in refs — the sim runs imperatively on rAF and
  // never triggers a React re-render.
  const sim = useRef({ positions: {}, velocities: {}, settled: false, ticks: 0, size: { w: 800, h: 500 } })

  // Seed positions whenever the node set changes.
  useEffect(() => {
    if (!graph.nodes.length) return
    const s = sim.current
    const { w, h } = s.size
    const cx = w / 2
    const cy = h / 2
    const radius = Math.min(cx, cy) * 0.5
    graph.nodes.forEach((n, i) => {
      if (!s.positions[n.id]) {
        const angle = (2 * Math.PI * i) / graph.nodes.length
        s.positions[n.id] = {
          x: cx + radius * Math.cos(angle) + (Math.random() - 0.5) * 30,
          y: cy + radius * Math.sin(angle) + (Math.random() - 0.5) * 30
        }
        s.velocities[n.id] = { x: 0, y: 0 }
      }
    })
    const ids = new Set(graph.nodes.map(n => n.id))
    for (const k of Object.keys(s.positions)) {
      if (!ids.has(k)) {
        delete s.positions[k]
        delete s.velocities[k]
      }
    }
    s.settled = false
    s.ticks = 0
  }, [graph.nodes])

  // Canvas sizing + ResizeObserver — panes resize constantly.
  useEffect(() => {
    const el = wrapRef.current
    const canvas = canvasRef.current
    if (!el || !canvas) return
    const update = () => {
      const rect = el.getBoundingClientRect()
      const w = Math.floor(rect.width) || 800
      const h = Math.floor(rect.height) || 500
      sim.current.size = { w, h }
      canvas.width = w
      canvas.height = h
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Force simulation + draw loop.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !graph.nodes.length) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const degreeMap = {}
    for (const n of graph.nodes) degreeMap[n.id] = 0
    for (const e of graph.edges) {
      if (degreeMap[e.source] !== undefined) degreeMap[e.source]++
      if (degreeMap[e.target] !== undefined) degreeMap[e.target]++
    }

    let running = true
    const s = sim.current

    const draw = () => {
      if (!running) return
      const { w, h } = s.size
      if (canvas.width !== w) canvas.width = w
      if (canvas.height !== h) canvas.height = h

      // Resolve theme colors once per frame (cheap, follows theme switches).
      const styles = getComputedStyle(canvas)
      const accent = styles.getPropertyValue('--ui-accent').trim() || 'var(--ui-accent)'
      const dim = styles.getPropertyValue('--ui-text-tertiary').trim() || 'rgba(128,128,128,0.4)'

      ctx.clearRect(0, 0, w, h)
      ctx.save()
      ctx.translate(view.offsetX, view.offsetY)
      ctx.scale(view.scale, view.scale)

      // Edges — curved, highlighted when they touch the selected node.
      for (const e of graph.edges) {
        const a = s.positions[e.source]
        const b = s.positions[e.target]
        if (!a || !b) continue
        const mx = (a.x + b.x) / 2
        const my = (a.y + b.y) / 2
        const dx = b.x - a.x
        const dy = b.y - a.y
        const dist = Math.sqrt(dx * dx + dy * dy) || 1
        const curve = Math.min(dist * 0.1, 20)
        const nx = -dy / dist
        const ny = dx / dist
        const cpx = mx + nx * curve
        const cpy = my + ny * curve
        const hl = selected === e.source || selected === e.target
        ctx.strokeStyle = hl ? accent : 'rgba(128,128,128,0.15)'
        ctx.lineWidth = hl ? 1.5 : 0.7
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.quadraticCurveTo(cpx, cpy, b.x, b.y)
        ctx.stroke()
      }

      // Nodes
      for (const n of graph.nodes) {
        const p = s.positions[n.id]
        if (!p) continue
        const deg = degreeMap[n.id] || 0
        const r = Math.max(5, Math.min(16, 4 + deg * 2))
        const color = folderColor(n.folder, folders)
        const sel = selected === n.id
        const hov = hovered === n.id
        if (sel || hov) {
          const grad = ctx.createRadialGradient(p.x, p.y, r, p.x, p.y, r * 2.5)
          grad.addColorStop(0, 'rgba(128,128,128,0.15)')
          grad.addColorStop(1, 'rgba(128,128,128,0)')
          ctx.fillStyle = grad
          ctx.beginPath()
          ctx.arc(p.x, p.y, r * 2.5, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.beginPath()
        ctx.arc(p.x, p.y, r + (sel ? 2 : 0), 0, Math.PI * 2)
        ctx.fillStyle = sel ? accent : color
        ctx.globalAlpha = hov ? 1 : 0.85
        ctx.fill()
        ctx.globalAlpha = 1
        ctx.strokeStyle = 'rgba(0,0,0,0.3)'
        ctx.lineWidth = 1
        ctx.stroke()
        if (hov || sel || r > 7) {
          ctx.fillStyle = dim
          ctx.font = `${sel ? 'bold ' : ''}${Math.max(9, Math.min(12, r))}px system-ui, sans-serif`
          ctx.textAlign = 'center'
          ctx.fillText(n.label, p.x, p.y - r - 4)
        }
      }
      ctx.restore()

      // Physics tick
      if (!s.settled) {
        const pos = s.positions
        const vel = s.velocities
        const damping = 0.82
        const repulsion = 2500
        const attraction = 0.005
        const idealLen = 100
        for (let i = 0; i < graph.nodes.length; i++) {
          for (let j = i + 1; j < graph.nodes.length; j++) {
            const a = pos[graph.nodes[i].id]
            const b = pos[graph.nodes[j].id]
            if (!a || !b) continue
            const dx = b.x - a.x
            const dy = b.y - a.y
            const d2 = dx * dx + dy * dy || 1
            const dist = Math.sqrt(d2)
            const f = Math.min(repulsion / d2, 40)
            const fx = (dx / dist) * f
            const fy = (dy / dist) * f
            vel[graph.nodes[i].id].x -= fx
            vel[graph.nodes[i].id].y -= fy
            vel[graph.nodes[j].id].x += fx
            vel[graph.nodes[j].id].y += fy
          }
        }
        for (const e of graph.edges) {
          const a = pos[e.source]
          const b = pos[e.target]
          if (!a || !b) continue
          const dx = b.x - a.x
          const dy = b.y - a.y
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          const f = (dist - idealLen) * attraction
          vel[e.source].x += (dx / dist) * f
          vel[e.source].y += (dy / dist) * f
          vel[e.target].x -= (dx / dist) * f
          vel[e.target].y -= (dy / dist) * f
        }
        for (const n of graph.nodes) {
          const p = pos[n.id]
          const v = vel[n.id]
          if (!p || !v) continue
          const dx = w / 2 - p.x
          const dy = h / 2 - p.y
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist > 200) {
            v.x += dx * 0.0002
            v.y += dy * 0.0002
          }
          v.x *= damping
          v.y *= damping
          p.x += v.x
          p.y += v.y
          p.x = Math.max(20, Math.min(w - 20, p.x))
          p.y = Math.max(20, Math.min(h - 20, p.y))
        }
        s.ticks++
        if (s.ticks > 200) {
          let maxV = 0
          for (const n of graph.nodes) {
            const v = vel[n.id]
            if (v) maxV = Math.max(maxV, Math.abs(v.x), Math.abs(v.y))
          }
          if (maxV < 0.15) s.settled = true
        }
      }

      requestAnimationFrame(draw)
    }
    requestAnimationFrame(draw)
    return () => {
      running = false
    }
  }, [graph, view, hovered, selected, folders])

  // Mouse interactions — read sim imperatively, never from closures.
  const toGraph = e => {
    const canvas = canvasRef.current
    if (!canvas) return { mx: 0, my: 0 }
    const rect = canvas.getBoundingClientRect()
    const v = graphView.get()
    return {
      mx: (e.clientX - rect.left - v.offsetX) / v.scale,
      my: (e.clientY - rect.top - v.offsetY) / v.scale
    }
  }

  const findNode = (mx, my) => {
    const pos = sim.current.positions
    let best = null
    let bestD = Infinity
    for (const n of graph.nodes) {
      const p = pos[n.id]
      if (!p) continue
      const deg = 0
      const r = Math.max(5, Math.min(16, 4 + deg * 2))
      const d = Math.sqrt((mx - p.x) ** 2 + (my - p.y) ** 2)
      if (d < r + 5 && d < bestD) {
        best = n.id
        bestD = d
      }
    }
    return best
  }

  const drag = useRef(null)

  const onMouseDown = e => {
    const { mx, my } = toGraph(e)
    const hit = findNode(mx, my)
    if (hit) {
      drag.current = { node: hit, sx: e.clientX, sy: e.clientY, ox: sim.current.positions[hit].x, oy: sim.current.positions[hit].y, moved: 0 }
      sim.current.settled = false
      sim.current.ticks = 0
    } else {
      const v = graphView.get()
      drag.current = { canvas: true, sx: e.clientX, sy: e.clientY, ox: v.offsetX, oy: v.offsetY, moved: 0 }
    }
  }

  const onMouseMove = e => {
    const v = graphView.get()
    if (drag.current?.node) {
      const dx = (e.clientX - drag.current.sx) / v.scale
      const dy = (e.clientY - drag.current.sy) / v.scale
      const p = sim.current.positions[drag.current.node]
      if (p) {
        p.x = drag.current.ox + dx
        p.y = drag.current.oy + dy
      }
      const vel = sim.current.velocities[drag.current.node]
      if (vel) {
        vel.x = 0
        vel.y = 0
      }
      drag.current.moved += Math.abs(dx) + Math.abs(dy)
    } else if (drag.current?.canvas) {
      graphView.set({
        offsetX: drag.current.ox + (e.clientX - drag.current.sx),
        offsetY: drag.current.oy + (e.clientY - drag.current.sy),
        scale: v.scale
      })
      drag.current.moved += 1
    } else {
      const { mx, my } = toGraph(e)
      setHovered(findNode(mx, my))
    }
  }

  const onMouseUp = () => {
    if (drag.current?.node && drag.current.moved < 5) onSelect(drag.current.node)
    drag.current = null
  }

  const onWheel = e => {
    e.preventDefault()
    const v = graphView.get()
    graphView.set({ ...v, scale: Math.min(4, Math.max(0.15, v.scale * (e.deltaY > 0 ? 0.92 : 1.08))) })
  }

  if (!graph.nodes.length) {
    return jsx(PanelEmpty, { description: t('graphEmpty'), icon: 'type-hierarchy', title: t('graph') })
  }

  return jsxs('div', {
    className: 'relative h-full min-h-0 w-full',
    ref: wrapRef,
    children: [
      jsx('canvas', {
        className: 'block h-full w-full cursor-grab',
        onMouseDown,
        onMouseLeave: () => {
          drag.current = null
          setHovered(null)
        },
        onMouseMove,
        onMouseUp,
        onWheel,
        ref: canvasRef
      }),
      jsxs('div', {
        className: 'absolute right-2 bottom-2 flex gap-1',
        children: [
          jsx(Button, { 'aria-label': t('add'), onClick: () => { const v = graphView.get(); graphView.set({ ...v, scale: Math.min(4, v.scale * 1.3) }) }, size: 'icon-xs', variant: 'ghost', children: jsx(Codicon, { name: 'add', size: '0.75rem' }) }),
          jsx(Button, { 'aria-label': t('remove'), onClick: () => { const v = graphView.get(); graphView.set({ ...v, scale: Math.max(0.15, v.scale * 0.7) }) }, size: 'icon-xs', variant: 'ghost', children: jsx(Codicon, { name: 'remove', size: '0.75rem' }) }),
          jsx(Button, { 'aria-label': t('discard'), onClick: () => graphView.set({ offsetX: 0, offsetY: 0, scale: 1 }), size: 'icon-xs', variant: 'ghost', children: jsx(Codicon, { name: 'discard', size: '0.75rem' }) })
        ]
      })
    ]
  })
}

// ─── Markdown ────────────────────────────────────────────────────────

function Markdown({ onWikilink, text }) {
  // Convert Obsidian wikilinks to standard markdown links before rendering;
  // the click handler intercepts the obsidian:// scheme.
  const converted = text.replace(
    /\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g,
    (_, name, alias) => `[${alias || name}](obsidian://${encodeURIComponent(name)})`
  )

  return jsx('div', {
    className: 'text-[0.78rem] leading-relaxed text-foreground/90 wrap-anywhere',
    onClick: e => {
      const anchor = e.target.closest?.('a')
      if (!anchor) return
      const href = anchor.getAttribute('href') ?? ''
      if (href.startsWith('obsidian://')) {
        e.preventDefault()
        onWikilink(decodeURIComponent(href.slice('obsidian://'.length)))
      }
    },
    children: jsx(Streamdown, {
      components: {
        a: ({ children, href, ...props }) =>
          href && href.startsWith('obsidian://')
            ? jsx('button', { className: 'cursor-pointer text-(--ui-accent) hover:underline', onClick: () => onWikilink(decodeURIComponent(href.slice('obsidian://'.length))), type: 'button', children })
            : jsx('a', { className: 'text-(--ui-accent) hover:underline', href, rel: 'noopener noreferrer', target: '_blank', ...props, children })
      },
      controls: false,
      mode: 'static',
      parseIncompleteMarkdown: false,
      children: converted
    })
  })
}

// ─── Note detail ─────────────────────────────────────────────────────

function NoteDetail({ note, onBacklink, vault }) {
  const t = usePluginI18n(ID)
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState('')

  if (!note) {
    return jsx(PanelEmpty, { description: t('selectNote'), icon: 'notebook', title: t('pageTitle') })
  }

  const rows = [
    { label: t('folder'), value: note.folder },
    { label: t('words'), value: String(note.word_count) },
    { label: t('links'), value: String(note.links.length) },
    { label: t('modified'), value: new Date(parseFloat(note.modified) * 1000).toLocaleDateString() }
  ]

  const startEdit = () => {
    setDraft(note.content)
    setEditing(true)
    setStatus('')
  }

  const cancelEdit = () => {
    setEditing(false)
    setDraft('')
    setStatus('')
  }

  const save = async () => {
    setStatus(t('saving'))
    try {
      await rest(`/notes/${encodeURIComponent(note.path)}${q(vault)}`, {
        method: 'PUT',
        body: { content: draft }
      })
      setStatus(t('saved'))
      setEditing(false)
      qc.invalidateQueries({ queryKey: noteKey(vault, note.path) })
      qc.invalidateQueries({ queryKey: vaultKey(vault) })
    } catch (err) {
      setStatus(String(err?.message ?? err))
    }
  }

  const body = editing
    ? jsxs('div', {
        className: 'flex flex-col gap-2',
        children: [
          jsxs('div', {
            className: 'flex items-center gap-2',
            children: [
              jsx(PanelAction, { icon: 'save', onClick: save, primary: true, spinning: status === t('saving'), children: t('save') }),
              jsx(PanelAction, { icon: 'close', onClick: cancelEdit, children: t('cancel') }),
              status ? jsx('span', { className: 'text-[0.65rem] text-muted-foreground/70', children: status }) : null
            ]
          }),
          jsx('textarea', {
            className: 'min-h-64 w-full resize-y rounded-md border border-(--ui-stroke-secondary) bg-background/60 p-2.5 font-mono text-[0.72rem] leading-relaxed text-foreground/85 outline-none focus:border-(--ui-accent)',
            onChange: e => setDraft(e.target.value),
            spellCheck: false,
            value: draft
          })
        ]
      })
    : jsxs('div', {
        className: 'flex flex-col gap-3',
        children: [
          note.backlinks.length > 0
            ? jsxs('div', {
                className: 'flex flex-wrap items-center gap-1.5 text-[0.68rem] text-muted-foreground/70',
                children: [
                  jsx('span', { children: `${t('linkedFrom')}:` }),
                  note.backlinks.map(name =>
                    jsx('button', {
                      className: 'text-(--ui-accent) hover:underline',
                      key: name,
                      onClick: () => onBacklink(name),
                      type: 'button',
                      children: name
                    })
                  )
                ]
              })
            : null,
          jsx(Markdown, { onWikilink: onBacklink, text: note.content })
        ]
      })

  return jsxs('div', {
    className: 'flex min-h-0 flex-1 flex-col gap-2',
    children: [
      jsx(PanelHeader, {
        actions: editing ? null : jsx(PanelAction, { icon: 'edit', onClick: startEdit, children: t('edit') }),
        subtitle: note.path,
        title: note.name
      }),
      jsx('div', {
        className: 'flex flex-wrap items-center gap-1.5',
        children: [
          jsx(PanelMeta, { rows }),
          note.tags.map(tag =>
            jsx('span', {
              className: 'inline-flex items-center rounded-full bg-(--ui-accent)/10 px-2 py-0.5 text-[0.62rem] text-(--ui-accent)',
              key: tag,
              children: `#${tag}`
            })
          )
        ]
      }),
      jsx('div', { className: 'min-h-0 flex-1 overflow-y-auto pr-1', children: body })
    ]
  })
}

// ─── Page ────────────────────────────────────────────────────────────

function VaultPage() {
  const t = usePluginI18n(ID)
  const qc = useQueryClient()
  const [vault, setVault] = useState(null)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(null)
  const [view, setView] = useState('notes')
  const [folder, setFolder] = useState(null)
  const [tag, setTag] = useState(null)

  const { data: vaults } = useQuery({ queryFn: () => rest('/vaults'), queryKey: vaultListKey(), staleTime: 30_000 })
  const activeVault = vault ?? vaults?.[0]?.name ?? ''
  const enabled = Boolean(activeVault)

  const { data: notes, isLoading } = useQuery({
    enabled,
    queryFn: () => rest(`/notes${q(activeVault)}`),
    queryKey: vaultKey(activeVault),
    staleTime: 15_000
  })
  const { data: folders } = useQuery({
    enabled,
    queryFn: () => rest(`/folders${q(activeVault)}`),
    queryKey: [ID, 'folders', activeVault],
    staleTime: 30_000
  })
  const { data: tags } = useQuery({
    enabled,
    queryFn: () => rest(`/tags${q(activeVault)}`),
    queryKey: [ID, 'tags', activeVault],
    staleTime: 30_000
  })
  const { data: graph } = useQuery({
    enabled: enabled && view === 'graph',
    queryFn: () => rest(`/graph${q(activeVault)}`),
    queryKey: [ID, 'graph', activeVault],
    staleTime: 60_000
  })
  const { data: note } = useQuery({
    enabled: Boolean(selected && activeVault),
    queryFn: () => rest(`/notes/${encodeURIComponent(selected)}${q(activeVault)}`),
    queryKey: noteKey(activeVault, selected),
    staleTime: 10_000
  })

  const refresh = () => {
    void rest('/refresh', { method: 'POST' }).then(() => qc.invalidateQueries({ queryKey: [ID] }))
  }

  const openNote = name => {
    setSelected(name)
    setView('notes')
  }

  const filtered = (notes ?? []).filter(n => {
    if (search && !n.name.toLowerCase().includes(search.toLowerCase())) return false
    if (folder && n.folder !== folder) return false
    if (tag && !n.tags.includes(tag)) return false
    return true
  })

  if (!vaults?.length && !isLoading) {
    return jsx(PanelEmpty, {
      description: t('loadError'),
      icon: 'warning',
      title: t('pageTitle')
    })
  }

  return jsxs('div', {
    className: 'flex h-full min-h-0 flex-col gap-2 p-3',
    children: [
      // Header: title, vault picker, view switch, refresh
      jsxs('div', {
        className: 'flex shrink-0 items-center justify-between gap-2',
        children: [
          jsxs('div', {
            className: 'flex min-w-0 items-center gap-2',
            children: [
              jsx('h2', { className: 'text-sm font-semibold text-foreground', children: t('pageTitle') }),
              vaults && vaults.length > 1
                ? jsxs('select', {
                    'aria-label': t('allVaults'),
                    className: 'rounded-[4px] border border-(--ui-stroke-secondary) bg-background/60 px-1.5 py-0.5 text-[0.68rem] text-foreground/85 outline-none',
                    onChange: e => {
                      setVault(e.target.value)
                      setSelected(null)
                      setFolder(null)
                      setTag(null)
                      setSearch('')
                    },
                    value: activeVault,
                    children: vaults.map(v =>
                      jsx('option', { value: v.name, children: `${v.name} (${v.note_count})` }, v.name)
                    )
                  })
                : null
            ]
          }),
          jsxs('div', {
            className: 'flex shrink-0 items-center gap-1.5',
            children: [
              jsx(SegmentedControl, {
                onChange: id => setView(id),
                options: [
                  { id: 'notes', label: t('notes') },
                  { id: 'graph', label: t('graph') }
                ],
                value: view
              }),
              jsx(Tip, {
                label: t('refresh'),
                children: jsx('button', {
                  'aria-label': t('refresh'),
                  className: 'inline-flex size-6 items-center justify-center rounded-[4px] text-(--ui-text-tertiary) hover:bg-(--ui-control-active-background) hover:text-foreground',
                  onClick: refresh,
                  type: 'button',
                  children: jsx(Codicon, { name: 'refresh', size: '0.8rem' })
                })
              })
            ]
          })
        ]
      }),
      // Stats line
      jsx('div', {
        className: 'shrink-0 text-[0.65rem] text-muted-foreground/60',
        children: t('stats', notes?.length ?? 0, (notes ?? []).reduce((s, n) => s + n.word_count, 0), folders?.length ?? 0)
      }),
      // Filters
      jsxs('div', {
        className: 'flex shrink-0 flex-wrap items-center gap-1',
        children: [
          jsx('input', {
            className: 'w-40 rounded-[4px] border border-(--ui-stroke-secondary) bg-background/60 px-1.5 py-0.5 text-[0.68rem] text-foreground/85 outline-none placeholder:text-muted-foreground/40 focus:border-(--ui-accent)',
            onChange: e => setSearch(e.target.value),
            placeholder: t('searchPlaceholder'),
            value: search
          }),
          (folders ?? []).map(f =>
            jsx('button', {
              className: cn(
                'rounded-full px-1.5 py-0.5 text-[0.62rem] transition-colors',
                folder === f.name
                  ? 'bg-(--ui-accent)/15 text-(--ui-accent)'
                  : 'bg-foreground/5 text-muted-foreground/70 hover:text-foreground'
              ),
              key: f.name,
              onClick: () => setFolder(folder === f.name ? null : f.name),
              type: 'button',
              children: `${f.name} (${f.count})`
            })
          ),
          (tags ?? []).slice(0, 8).map(tg =>
            jsx('button', {
              className: cn(
                'rounded-full px-1.5 py-0.5 text-[0.62rem] transition-colors',
                tag === tg.tag
                  ? 'bg-(--ui-accent)/15 text-(--ui-accent)'
                  : 'bg-foreground/5 text-muted-foreground/70 hover:text-foreground'
              ),
              key: tg.tag,
              onClick: () => setTag(tag === tg.tag ? null : tg.tag),
              type: 'button',
              children: `#${tg.tag} (${tg.count})`
            })
          )
        ]
      }),
      // Body
      jsx(PanelBody, {
        className: 'min-h-0 flex-1',
        children: view === 'notes'
          ? jsxs('div', {
              className: 'flex min-h-0 flex-1 gap-3 max-[47.5rem]:flex-col',
              children: [
                jsx(PanelList, {
                  className: 'min-[47.5rem]:w-56',
                  children:
                    filtered.length === 0
                      ? jsx('p', { className: 'px-2 py-3 text-[0.68rem] text-muted-foreground/50', children: t('noNotes') })
                      : filtered.map(n =>
                          jsx(PanelListRow, {
                            active: selected === n.path,
                            icon: 'file',
                            key: n.path,
                            meta: `${n.word_count}`,
                            onSelect: () => setSelected(n.path),
                            rowKey: n.path,
                            title: n.name
                          })
                        )
                }),
                jsx(PanelDetail, {
                  className: 'min-[47.5rem]:flex-1',
                  children: jsx(NoteDetail, { note, onBacklink: openNote, vault: activeVault })
                })
              ]
            })
          : jsx('div', {
              className: 'min-h-0 flex-1 rounded-md border border-(--ui-stroke-tertiary)',
              children: jsx(GraphView, {
                folders: (folders ?? []).map(f => f.name),
                graph: graph ?? { edges: [], nodes: [] },
                onSelect: openNote,
                selected
              })
            })
      })
    ]
  })
}

// ─── Statusbar chip ──────────────────────────────────────────────────

function VaultChip() {
  const t = usePluginI18n(ID)
  const { data: vaults } = useQuery({ queryFn: () => rest('/vaults'), queryKey: vaultListKey(), staleTime: 60_000 })
  const count = vaults?.length ?? 0
  if (!count) return null

  return jsx(Tip, {
    label: t('openVault'),
    children: jsx('button', {
      className: 'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] tabular-nums text-(--ui-text-tertiary) transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground',
      onClick: () => host.navigate(PATH),
      type: 'button',
      children: [
        jsx(Codicon, { name: 'notebook', size: '0.7rem' }),
        jsx('span', { children: String(count) })
      ]
    })
  })
}

// ─── Registration ────────────────────────────────────────────────────

export default {
  id: ID,
  name: 'Obsidian Memory',
  description: 'Browse, search, and edit your Obsidian vault notes — graph view, multi-vault support, and inline editing.',
  defaultEnabled: false,
  register(ctx) {
    ctx.i18n.register(LOCALES)
    rest = ctx.rest

    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: PATH },
        render: () => jsx(VaultPage, {})
      },
      {
        id: 'count',
        area: STATUSBAR_AREAS.right,
        order: 90,
        render: () => jsx(VaultChip, {})
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        order: 60,
        data: { codicon: 'notebook', label: ctx.i18n.t('nav'), path: PATH }
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'obsidian.open',
          keywords: ['obsidian', 'vault', 'notes', 'markdown', 'graph'],
          label: ctx.i18n.t('openVault'),
          run: () => host.navigate(PATH)
        }
      },
      {
        id: 'open',
        area: KEYBINDS_AREA,
        data: {
          category: 'view',
          defaults: ['mod+alt+o'],
          id: 'obsidian.open',
          label: ctx.i18n.t('openVault'),
          run: () => host.navigate(PATH)
        }
      }
    ])
  }
}
