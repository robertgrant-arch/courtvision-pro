'use client';

import React, {
  useState, useEffect, useRef, useCallback, useMemo,
  forwardRef, useImperativeHandle, Suspense,
} from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import dynamic from 'next/dynamic';

// ── Types ─────────────────────────────────────────────────────────────────────

type CourtType = 'half' | 'full';
type PlayType = 'Horns' | 'Floppy' | 'Spain PnR' | 'BLOB' | 'SLOB' | 'Transition' | 'Custom';
type ActionType = 'cut' | 'screen' | 'dribble' | 'pass' | 'handoff';
type Tool = 'select' | 'cut' | 'pass' | 'dribble' | 'screen' | 'handoff' | 'place-offense' | 'place-defense' | 'text' | 'eraser';
type SituationType = 'BLOB' | 'SLOB' | 'Halfcourt' | 'Transition' | 'Custom';
type FormationName = 'Blank' | 'Horns' | '5-Out' | '4-Out-1-In' | 'Box' | 'Stack' | '1-4 High';

interface Pos { x: number; y: number; }
interface Player { id: string; team: 'offense' | 'defense'; label: string; positions: Record<number, Pos>; notes?: string; }
interface PlayAction { id: string; type: ActionType; fromPlayerId: string; toPlayerId?: string; toPosition?: Pos; frameIndex: number; note?: string; }
interface Frame { index: number; durationMs: number; autoAdvance?: boolean; }
interface Annotation { id: string; text: string; x: number; y: number; frameIndex: number; }
interface Play {
  id: string; name: string; court: CourtType; type: PlayType; situation: SituationType;
  tags: string[]; notes: string; players: Player[]; frames: Frame[];
  actions: PlayAction[]; annotations: Annotation[]; createdAt: string; updatedAt: string;
}
interface Selection { type: 'player' | 'action' | 'frame' | null; id: string | null; }
interface CreatePlayOpts {
  court: CourtType; type: PlayType; situation: SituationType;
  formation: FormationName; name: string; tags: string[]; notes: string;
}

// ── Utils ─────────────────────────────────────────────────────────────────────

function nanoid(): string {
  return Math.random().toString(36).slice(2, 11) + Math.random().toString(36).slice(2, 6);
}

function exportPNG(canvas: HTMLCanvasElement, name: string) {
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = `${name}.png`;
  a.click();
}

// ── Court Drawing ──────────────────────────────────────────────────────────────

interface CB { x: number; y: number; width: number; height: number; }

function drawHalfCourt(ctx: CanvasRenderingContext2D, b: CB, mini = false) {
  const { x, y, width: W, height: H } = b, lw = mini ? 1 : 2;
  const gr = ctx.createLinearGradient(x, y, x + W, y + H);
  gr.addColorStop(0, '#c49a5a'); gr.addColorStop(0.4, '#b8864e'); gr.addColorStop(1, '#b07a42');
  ctx.fillStyle = gr; ctx.beginPath(); ctx.roundRect(x, y, W, H, mini ? 4 : 8); ctx.fill();
  ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = lw;
  ctx.beginPath(); ctx.roundRect(x, y, W, H, mini ? 4 : 8); ctx.stroke();
  const pW = W * (16 / 50), pH = H * (19 / 47), pX = x + (W - pW) / 2;
  ctx.fillStyle = 'rgba(160,100,40,0.45)'; ctx.fillRect(pX, y, pW, pH); ctx.strokeRect(pX, y, pW, pH);
  const ftY = y + pH, fcR = W * (6 / 50), fcX = x + W / 2;
  ctx.beginPath(); ctx.moveTo(pX, ftY); ctx.lineTo(pX + pW, ftY); ctx.stroke();
  ctx.beginPath(); ctx.arc(fcX, ftY, fcR, 0, Math.PI, false); ctx.stroke();
  ctx.save(); ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.arc(fcX, ftY, fcR, Math.PI, Math.PI * 2, false); ctx.stroke(); ctx.restore();
  const bkX = x + W / 2, bkY = y + H * (5.25 / 47);
  ctx.beginPath(); ctx.arc(bkX, bkY, W * (4 / 50), 0, Math.PI, false); ctx.stroke();
  const tR = W * (23.75 / 50), cX2 = W * (3 / 50);
  const lcX = x + cX2, rcX = x + W - cX2, clY = y + H * (14 / 47);
  ctx.beginPath(); ctx.moveTo(lcX, y); ctx.lineTo(lcX, clY); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(rcX, y); ctx.lineTo(rcX, clY); ctx.stroke();
  const la = Math.atan2(clY - bkY, lcX - bkX), ra = Math.atan2(clY - bkY, rcX - bkX);
  ctx.beginPath(); ctx.arc(bkX, bkY, tR, ra, la, false); ctx.stroke();
  const bbY = y + H * (1.2 / 47), bbHW = W * (3 / 50);
  ctx.lineWidth = mini ? 2 : 3; ctx.beginPath(); ctx.moveTo(bkX - bbHW, bbY); ctx.lineTo(bkX + bbHW, bbY); ctx.stroke();
  ctx.lineWidth = lw; ctx.beginPath(); ctx.arc(bkX, bkY, W * (0.75 / 50), 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

function drawArrow(ctx: CanvasRenderingContext2D, from: Pos, to: Pos, type: string, color: string, sel: boolean) {
  const dx = to.x - from.x, dy = to.y - from.y, len = Math.hypot(dx, dy);
  if (len < 2) return;
  ctx.save(); ctx.strokeStyle = color; ctx.fillStyle = color;
  ctx.globalAlpha = sel ? 1 : 0.85; ctx.lineWidth = sel ? 3 : 2;
  if (type === 'pass') { ctx.setLineDash([8, 5]); }
  else if (type === 'dribble') {
    const ux = dx / len, uy = dy / len, amp = 6, steps = Math.floor(len / 18) * 2;
    ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(from.x, from.y);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, s = i % 2 === 0 ? 1 : -1;
      ctx.lineTo(from.x + dx * t + uy * amp * s, from.y + dy * t - ux * amp * s);
    }
    ctx.lineTo(to.x, to.y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(to.x, to.y);
    const a = Math.atan2(dy, dx);
    ctx.lineTo(to.x - 12 * Math.cos(a - 0.45), to.y - 12 * Math.sin(a - 0.45));
    ctx.lineTo(to.x - 12 * Math.cos(a + 0.45), to.y - 12 * Math.sin(a + 0.45));
    ctx.closePath(); ctx.fill(); ctx.restore(); return;
  } else if (type === 'screen') {
    ctx.setLineDash([]);
    const sf = 0.85, sp = { x: from.x + dx * sf, y: from.y + dy * sf }, pl = 18;
    const ux = dx / len, uy = dy / len;
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(sp.x, sp.y); ctx.stroke();
    ctx.lineWidth = sel ? 4 : 3;
    ctx.beginPath(); ctx.moveTo(sp.x - uy * pl, sp.y + ux * pl); ctx.lineTo(sp.x + uy * pl, sp.y - ux * pl); ctx.stroke();
    ctx.restore(); return;
  } else { ctx.setLineDash([]); }
  ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
  ctx.setLineDash([]);
  const a = Math.atan2(dy, dx);
  ctx.beginPath(); ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - 12 * Math.cos(a - 0.45), to.y - 12 * Math.sin(a - 0.45));
  ctx.lineTo(to.x - 12 * Math.cos(a + 0.45), to.y - 12 * Math.sin(a + 0.45));
  ctx.closePath(); ctx.fill(); ctx.restore();
}

// ── Formations ─────────────────────────────────────────────────────────────────

interface FP { label: string; team: 'offense' | 'defense'; x: number; y: number; }
const FORMATIONS: Record<FormationName, FP[]> = {
  Blank: [],
  Horns: [
    {label:'PG',team:'offense',x:0.50,y:0.52},{label:'SG',team:'offense',x:0.78,y:0.46},
    {label:'SF',team:'offense',x:0.22,y:0.46},{label:'PF',team:'offense',x:0.65,y:0.30},
    {label:'C',team:'offense',x:0.35,y:0.30},
  ],
  '5-Out': [
    {label:'PG',team:'offense',x:0.50,y:0.58},{label:'SG',team:'offense',x:0.82,y:0.44},
    {label:'SF',team:'offense',x:0.82,y:0.72},{label:'PF',team:'offense',x:0.18,y:0.72},
    {label:'C',team:'offense',x:0.18,y:0.44},
  ],
  '4-Out-1-In': [
    {label:'PG',team:'offense',x:0.50,y:0.58},{label:'SG',team:'offense',x:0.80,y:0.44},
    {label:'SF',team:'offense',x:0.80,y:0.72},{label:'PF',team:'offense',x:0.20,y:0.72},
    {label:'C',team:'offense',x:0.50,y:0.18},
  ],
  Box: [
    {label:'PG',team:'offense',x:0.50,y:0.58},{label:'SG',team:'offense',x:0.65,y:0.25},
    {label:'SF',team:'offense',x:0.35,y:0.25},{label:'PF',team:'offense',x:0.65,y:0.40},
    {label:'C',team:'offense',x:0.35,y:0.40},
  ],
  Stack: [
    {label:'PG',team:'offense',x:0.50,y:0.60},{label:'SG',team:'offense',x:0.62,y:0.30},
    {label:'SF',team:'offense',x:0.50,y:0.38},{label:'PF',team:'offense',x:0.62,y:0.46},
    {label:'C',team:'offense',x:0.50,y:0.54},
  ],
  '1-4 High': [
    {label:'PG',team:'offense',x:0.50,y:0.58},{label:'SG',team:'offense',x:0.76,y:0.36},
    {label:'SF',team:'offense',x:0.60,y:0.36},{label:'PF',team:'offense',x:0.40,y:0.36},
    {label:'C',team:'offense',x:0.24,y:0.36},
  ],
};
const FORMATION_NAMES: FormationName[] = ['Blank','Horns','5-Out','4-Out-1-In','Box','Stack','1-4 High'];

// ── Preset Plays ───────────────────────────────────────────────────────────────

function mkPlay(id:string,name:string,court:CourtType,type:PlayType,situation:SituationType,tags:string[],notes:string,players:Player[],actions:PlayAction[]): Play {
  const d = '2024-01-01T00:00:00.000Z';
  return {id,name,court,type,situation,tags,notes,players,actions,annotations:[],frames:[{index:0,durationMs:1500},{index:1,durationMs:1500}],createdAt:d,updatedAt:d};
}

const PRESET_PLAYS: Play[] = [
  mkPlay('preset-horns','Horns PnR','half','Horns','Halfcourt',['PnR','Horns'],'PG attacks PnR with big at elbow.',
    [{id:'p1',team:'offense',label:'PG',positions:{0:{x:0.50,y:0.52},1:{x:0.44,y:0.38}}},{id:'p2',team:'offense',label:'SG',positions:{0:{x:0.78,y:0.46},1:{x:0.82,y:0.68}}},{id:'p3',team:'offense',label:'SF',positions:{0:{x:0.22,y:0.46},1:{x:0.18,y:0.68}}},{id:'p4',team:'offense',label:'PF',positions:{0:{x:0.65,y:0.30},1:{x:0.58,y:0.42}}},{id:'p5',team:'offense',label:'C',positions:{0:{x:0.35,y:0.30},1:{x:0.35,y:0.30}}}],
    [{id:'a1',type:'dribble',fromPlayerId:'p1',toPosition:{x:0.44,y:0.38},frameIndex:0},{id:'a2',type:'screen',fromPlayerId:'p4',toPlayerId:'p1',frameIndex:0},{id:'a3',type:'cut',fromPlayerId:'p2',toPosition:{x:0.82,y:0.68},frameIndex:0}]),
  mkPlay('preset-floppy','Floppy','half','Floppy','Halfcourt',['Curl','Flare'],'Two players read defense off down screens.',
    [{id:'f1',team:'offense',label:'PG',positions:{0:{x:0.50,y:0.62},1:{x:0.50,y:0.62}}},{id:'f2',team:'offense',label:'SG',positions:{0:{x:0.30,y:0.10},1:{x:0.72,y:0.42}}},{id:'f3',team:'offense',label:'SF',positions:{0:{x:0.70,y:0.10},1:{x:0.20,y:0.60}}},{id:'f4',team:'offense',label:'PF',positions:{0:{x:0.35,y:0.30},1:{x:0.35,y:0.30}}},{id:'f5',team:'offense',label:'C',positions:{0:{x:0.65,y:0.30},1:{x:0.65,y:0.30}}}],
    [{id:'fa1',type:'screen',fromPlayerId:'f4',toPlayerId:'f2',frameIndex:0},{id:'fa2',type:'screen',fromPlayerId:'f5',toPlayerId:'f3',frameIndex:0},{id:'fa3',type:'cut',fromPlayerId:'f2',toPosition:{x:0.72,y:0.42},frameIndex:0},{id:'fa5',type:'pass',fromPlayerId:'f1',toPlayerId:'f2',frameIndex:1}]),
  mkPlay('preset-spain','Spain PnR','half','Spain PnR','Halfcourt',['Spain','PnR'],'PnR with back-screen on roller defender.',
    [{id:'s1',team:'offense',label:'PG',positions:{0:{x:0.50,y:0.55},1:{x:0.40,y:0.40}}},{id:'s2',team:'offense',label:'SG',positions:{0:{x:0.78,y:0.50},1:{x:0.78,y:0.50}}},{id:'s3',team:'offense',label:'SF',positions:{0:{x:0.22,y:0.50},1:{x:0.22,y:0.50}}},{id:'s4',team:'offense',label:'PF',positions:{0:{x:0.62,y:0.32},1:{x:0.50,y:0.22}}},{id:'s5',team:'offense',label:'C',positions:{0:{x:0.38,y:0.32},1:{x:0.38,y:0.32}}}],
    [{id:'sa1',type:'screen',fromPlayerId:'s4',toPlayerId:'s1',frameIndex:0},{id:'sa2',type:'dribble',fromPlayerId:'s1',toPosition:{x:0.40,y:0.40},frameIndex:0},{id:'sa3',type:'screen',fromPlayerId:'s5',toPlayerId:'s4',frameIndex:0},{id:'sa5',type:'pass',fromPlayerId:'s1',toPlayerId:'s4',frameIndex:1}]),
];

// ── Store ───────────────────────────────────────────────────────────────────────

function clonePlay(p: Play): Play { return JSON.parse(JSON.stringify(p)); }
function touchPlay(p: Play): Play { return { ...p, updatedAt: new Date().toISOString() }; }
function mutatePlays(plays: Play[], id: string, fn: (p: Play) => Play): Play[] {
  return plays.map(p => p.id === id ? touchPlay(fn(p)) : p);
}
function pushHist(stack: Play[][], plays: Play[]): Play[][] {
  return [...stack, plays.map(clonePlay)].slice(-30);
}

interface St {
  plays: Play[]; view: 'library' | 'editor'; activePlayId: string | null;
  currentFrame: number; selection: Selection; activeTool: Tool;
  isAnimating: boolean; animFrame: number;
  searchQuery: string; filterSituation: string | null; sortBy: 'recent' | 'az' | 'type';
  undoStack: Play[][]; redoStack: Play[][]; quizPlayId: string | null; show3D: boolean;
  setView(v: 'library' | 'editor'): void;
  openPlay(id: string): void;
  backToLibrary(): void;
  createPlay(o: CreatePlayOpts): string;
  duplicatePlay(id: string): void;
  deletePlay(id: string): void;
  updatePlayMeta(id: string, u: Partial<Pick<Play, 'name' | 'tags' | 'notes' | 'type' | 'situation' | 'court'>>): void;
  setActiveTool(t: Tool): void;
  setCurrentFrame(f: number): void;
  setSelection(s: Selection): void;
  addPlayer(pid: string, p: Omit<Player, 'id'>): void;
  updatePlayer(pid: string, plid: string, u: Partial<Omit<Player, 'id'>>): void;
  movePlayer(pid: string, plid: string, fi: number, pos: Pos): void;
  deletePlayer(pid: string, plid: string): void;
  addAction(pid: string, a: Omit<PlayAction, 'id'>): void;
  updateAction(pid: string, aid: string, u: Partial<Omit<PlayAction, 'id'>>): void;
  deleteAction(pid: string, aid: string): void;
  addFrame(pid: string): void;
  duplicateFrame(pid: string, fi: number): void;
  deleteFrame(pid: string, fi: number): void;
  updateFrame(pid: string, fi: number, u: Partial<Frame>): void;
  addAnnotation(pid: string, a: Omit<Annotation, 'id'>): void;
  undo(): void; redo(): void;
  setSearchQuery(q: string): void;
  setFilterSituation(s: string | null): void;
  setSortBy(s: 'recent' | 'az' | 'type'): void;
  setIsAnimating(v: boolean): void;
  setAnimFrame(f: number): void;
  openQuiz(id: string): void;
  closeQuiz(): void;
  setShow3D(v: boolean): void;
}

const useStore = create<St>()(persist((set, get) => ({
  plays: PRESET_PLAYS.map(clonePlay),
  view: 'library', activePlayId: null, currentFrame: 0,
  selection: { type: null, id: null }, activeTool: 'select',
  isAnimating: false, animFrame: 0,
  searchQuery: '', filterSituation: null, sortBy: 'recent',
  undoStack: [], redoStack: [], quizPlayId: null, show3D: false,

  setView: v => set({ view: v }),
  openPlay: id => set({ view: 'editor', activePlayId: id, currentFrame: 0, selection: { type: null, id: null }, activeTool: 'select', undoStack: [], redoStack: [] }),
  backToLibrary: () => set({ view: 'library', activePlayId: null, isAnimating: false, show3D: false }),

  createPlay: opts => {
    const id = nanoid(), fp = FORMATIONS[opts.formation] ?? [], now = new Date().toISOString();
    const players: Player[] = fp.map(f => ({ id: nanoid(), team: f.team, label: f.label, positions: { 0: { x: f.x, y: f.y } } }));
    const play: Play = { id, name: opts.name || 'Untitled Play', court: opts.court, type: opts.type, situation: opts.situation, tags: opts.tags, notes: opts.notes, players, frames: [{ index: 0, durationMs: 1500 }], actions: [], annotations: [], createdAt: now, updatedAt: now };
    set(s => ({ plays: [play, ...s.plays], view: 'editor', activePlayId: id, currentFrame: 0, selection: { type: null, id: null }, activeTool: 'select', undoStack: [], redoStack: [] }));
    return id;
  },
  duplicatePlay: id => {
    const src = get().plays.find(p => p.id === id); if (!src) return;
    const now = new Date().toISOString();
    set(s => ({ plays: [{ ...clonePlay(src), id: nanoid(), name: `${src.name} (copy)`, createdAt: now, updatedAt: now }, ...s.plays] }));
  },
  deletePlay: id => set(s => ({ plays: s.plays.filter(p => p.id !== id), activePlayId: s.activePlayId === id ? null : s.activePlayId, view: s.activePlayId === id ? 'library' : s.view })),
  updatePlayMeta: (id, u) => set(s => ({ plays: mutatePlays(s.plays, id, p => ({ ...p, ...u })) })),

  setActiveTool: t => set({ activeTool: t }),
  setCurrentFrame: f => set({ currentFrame: f, selection: { type: null, id: null } }),
  setSelection: s => set({ selection: s }),

  addPlayer: (pid, pd) => set(s => {
    const prev = s.plays, pl = { id: nanoid(), ...pd };
    return { plays: mutatePlays(prev, pid, p => ({ ...p, players: [...p.players, pl] })), undoStack: pushHist(s.undoStack, prev), redoStack: [] };
  }),
  updatePlayer: (pid, plid, u) => set(s => ({ plays: mutatePlays(s.plays, pid, p => ({ ...p, players: p.players.map(pl => pl.id === plid ? { ...pl, ...u } : pl) })) })),
  movePlayer: (pid, plid, fi, pos) => set(s => {
    const prev = s.plays;
    return { plays: mutatePlays(prev, pid, p => ({ ...p, players: p.players.map(pl => pl.id === plid ? { ...pl, positions: { ...pl.positions, [fi]: pos } } : pl) })), undoStack: pushHist(s.undoStack, prev), redoStack: [] };
  }),
  deletePlayer: (pid, plid) => set(s => {
    const prev = s.plays;
    return { plays: mutatePlays(prev, pid, p => ({ ...p, players: p.players.filter(pl => pl.id !== plid), actions: p.actions.filter(a => a.fromPlayerId !== plid && a.toPlayerId !== plid) })), undoStack: pushHist(s.undoStack, prev), redoStack: [], selection: { type: null, id: null } };
  }),

  addAction: (pid, ad) => set(s => {
    const prev = s.plays, na = { id: nanoid(), ...ad };
    return { plays: mutatePlays(prev, pid, p => ({ ...p, actions: [...p.actions, na] })), undoStack: pushHist(s.undoStack, prev), redoStack: [] };
  }),
  updateAction: (pid, aid, u) => set(s => ({ plays: mutatePlays(s.plays, pid, p => ({ ...p, actions: p.actions.map(a => a.id === aid ? { ...a, ...u } : a) })) })),
  deleteAction: (pid, aid) => set(s => {
    const prev = s.plays;
    return { plays: mutatePlays(prev, pid, p => ({ ...p, actions: p.actions.filter(a => a.id !== aid) })), undoStack: pushHist(s.undoStack, prev), redoStack: [], selection: { type: null, id: null } };
  }),

  addFrame: pid => set(s => {
    const prev = s.plays;
    return { plays: mutatePlays(prev, pid, p => { const ni = p.frames.length, li = ni - 1; return { ...p, frames: [...p.frames, { index: ni, durationMs: 1500 }], players: p.players.map(pl => ({ ...pl, positions: { ...pl.positions, [ni]: pl.positions[li] ?? pl.positions[0] ?? { x: 0.5, y: 0.5 } } })) }; }), undoStack: pushHist(s.undoStack, prev), redoStack: [] };
  }),
  duplicateFrame: (pid, fi) => set(s => {
    const prev = s.plays;
    return { plays: mutatePlays(prev, pid, p => { const ni = p.frames.length; return { ...p, frames: [...p.frames, { index: ni, durationMs: 1500 }], players: p.players.map(pl => ({ ...pl, positions: { ...pl.positions, [ni]: { ...(pl.positions[fi] ?? { x: 0.5, y: 0.5 }) } } })), actions: [...p.actions, ...p.actions.filter(a => a.frameIndex === fi).map(a => ({ ...a, id: nanoid(), frameIndex: ni }))] }; }), undoStack: pushHist(s.undoStack, prev), redoStack: [] };
  }),
  deleteFrame: (pid, fi) => set(s => {
    const prev = s.plays;
    const plays = mutatePlays(prev, pid, p => {
      if (p.frames.length <= 1) return p;
      const frames = p.frames.filter(f => f.index !== fi).map((f, i) => ({ ...f, index: i }));
      const actions = p.actions.filter(a => a.frameIndex !== fi).map(a => ({ ...a, frameIndex: a.frameIndex > fi ? a.frameIndex - 1 : a.frameIndex }));
      const players = p.players.map(pl => { const np: Record<number, Pos> = {}; Object.entries(pl.positions).forEach(([k, v]) => { const ki = +k; if (ki !== fi) np[ki > fi ? ki - 1 : ki] = v; }); return { ...pl, positions: np }; });
      return { ...p, frames, actions, players };
    });
    const nf = Math.min(s.currentFrame, plays.find(p => p.id === pid)!.frames.length - 1);
    return { plays, currentFrame: nf, undoStack: pushHist(s.undoStack, prev), redoStack: [] };
  }),
  updateFrame: (pid, fi, u) => set(s => ({ plays: mutatePlays(s.plays, pid, p => ({ ...p, frames: p.frames.map(f => f.index === fi ? { ...f, ...u } : f) })) })),
  addAnnotation: (pid, ad) => set(s => ({ plays: mutatePlays(s.plays, pid, p => ({ ...p, annotations: [...(p.annotations ?? []), { id: nanoid(), ...ad }] })) })),

  undo: () => set(s => { if (!s.undoStack.length) return s; const prev = s.plays.map(clonePlay), stack = [...s.undoStack], r = stack.pop()!; return { plays: r, undoStack: stack, redoStack: [...s.redoStack, prev] }; }),
  redo: () => set(s => { if (!s.redoStack.length) return s; const prev = s.plays.map(clonePlay), stack = [...s.redoStack], r = stack.pop()!; return { plays: r, undoStack: [...s.undoStack, prev], redoStack: stack }; }),

  setSearchQuery: q => set({ searchQuery: q }),
  setFilterSituation: s => set({ filterSituation: s }),
  setSortBy: s => set({ sortBy: s }),
  setIsAnimating: v => set({ isAnimating: v }),
  setAnimFrame: f => set({ animFrame: f }),
  openQuiz: id => set({ quizPlayId: id }),
  closeQuiz: () => set({ quizPlayId: null }),
  setShow3D: v => set({ show3D: v }),
}), { name: 'cvpro-v2', partialize: s => ({ plays: s.plays, sortBy: s.sortBy }) }));

// ── UI Components ───────────────────────────────────────────────────────────────

const PLAY_TYPES: PlayType[] = ['Custom','Horns','Floppy','Spain PnR','BLOB','SLOB','Transition'];
const SITUATIONS: SituationType[] = ['Halfcourt','BLOB','SLOB','Transition','Custom'];
const ACTION_TYPES: ActionType[] = ['cut','pass','dribble','screen','handoff'];
const TOOLS: { key: Tool; label: string; shortcut: string }[] = [
  {key:'select',label:'Select',shortcut:'V'},{key:'cut',label:'Cut',shortcut:'C'},
  {key:'pass',label:'Pass',shortcut:'P'},{key:'dribble',label:'Dribble',shortcut:'D'},
  {key:'screen',label:'Screen',shortcut:'S'},{key:'handoff',label:'Handoff',shortcut:'H'},
  {key:'place-offense',label:'+O',shortcut:'O'},{key:'place-defense',label:'+X',shortcut:'X'},
  {key:'text',label:'Text',shortcut:'T'},{key:'eraser',label:'Erase',shortcut:'E'},
];

const SIT_CLS: Record<string, string> = {
  Halfcourt: 'bg-blue-900/60 text-blue-300', BLOB: 'bg-purple-900/60 text-purple-300',
  SLOB: 'bg-indigo-900/60 text-indigo-300', Transition: 'bg-green-900/60 text-green-300',
  Custom: 'bg-slate-700 text-slate-300',
};

// ── New Play Modal ──────────────────────────────────────────────────────────────

function NewPlayModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { createPlay } = useStore();
  const [step, setStep] = useState(0);
  const [court, setCourt] = useState<CourtType>('half');
  const [formation, setFormation] = useState<FormationName>('Horns');
  const [name, setName] = useState('');
  const [type, setType] = useState<PlayType>('Custom');
  const [situation, setSituation] = useState<SituationType>('Halfcourt');

  if (!open) return null;

  const handleCreate = () => {
    createPlay({ court, formation, name: name || 'Untitled Play', type, situation, tags: [], notes: '' });
    onClose(); setStep(0); setName('');
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
          <h2 className="text-white font-bold">New Play — Step {step + 1}/3</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white">✕</button>
        </div>
        <div className="p-6 space-y-4">
          {step === 0 && (
            <>
              <p className="text-slate-400 text-sm">Choose court type:</p>
              <div className="flex gap-3">
                {(['half', 'full'] as CourtType[]).map(c => (
                  <button key={c} onClick={() => setCourt(c)}
                    className={`flex-1 py-3 rounded-xl border text-sm font-semibold transition-all ${court === c ? 'border-orange-500 bg-orange-500/20 text-orange-400' : 'border-slate-700 text-slate-400 hover:border-slate-600'}`}
                  >{c === 'half' ? 'Half Court' : 'Full Court'}</button>
                ))}
              </div>
            </>
          )}
          {step === 1 && (
            <>
              <p className="text-slate-400 text-sm">Choose formation:</p>
              <div className="grid grid-cols-2 gap-2">
                {FORMATION_NAMES.map(f => (
                  <button key={f} onClick={() => setFormation(f)}
                    className={`py-2 px-3 rounded-lg border text-sm transition-all ${formation === f ? 'border-orange-500 bg-orange-500/20 text-orange-400' : 'border-slate-700 text-slate-400 hover:border-slate-600'}`}
                  >{f}</button>
                ))}
              </div>
            </>
          )}
          {step === 2 && (
            <>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="Play name"
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:border-orange-500 focus:outline-none" />
              <select value={type} onChange={e => setType(e.target.value as PlayType)}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm">
                {PLAY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <select value={situation} onChange={e => setSituation(e.target.value as SituationType)}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm">
                {SITUATIONS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </>
          )}
        </div>
        <div className="flex gap-3 px-6 pb-6">
          {step > 0 && <button onClick={() => setStep(step - 1)} className="flex-1 py-2.5 rounded-xl border border-slate-600 text-slate-300 text-sm">Back</button>}
          {step < 2 ? (
            <button onClick={() => setStep(step + 1)} className="flex-1 py-2.5 rounded-xl bg-orange-500 text-white text-sm font-semibold">Next</button>
          ) : (
            <button onClick={handleCreate} className="flex-1 py-2.5 rounded-xl bg-orange-500 text-white text-sm font-semibold">Create Play</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Library View ────────────────────────────────────────────────────────────────

function LibraryView() {
  const { plays, searchQuery, filterSituation, sortBy, setSearchQuery, setFilterSituation, setSortBy, openPlay, duplicatePlay, deletePlay } = useStore();
  const [showNew, setShowNew] = useState(false);

  let filtered = plays.filter(p => {
    if (searchQuery && !p.name.toLowerCase().includes(searchQuery.toLowerCase()) && !p.tags.some(t => t.toLowerCase().includes(searchQuery.toLowerCase()))) return false;
    if (filterSituation && p.situation !== filterSituation) return false;
    return true;
  });
  if (sortBy === 'az') filtered.sort((a, b) => a.name.localeCompare(b.name));
  else if (sortBy === 'type') filtered.sort((a, b) => a.type.localeCompare(b.type));
  else filtered.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold">🏀 CourtVision <span className="text-orange-500">Pro</span></h1>
            <p className="text-slate-400 text-sm mt-1">Design, animate & teach basketball plays</p>
          </div>
          <button onClick={() => setShowNew(true)} className="px-5 py-2.5 bg-orange-500 hover:bg-orange-400 rounded-xl text-white font-semibold text-sm transition-all">
            + New Play
          </button>
        </div>

        <div className="flex gap-3 mb-6">
          <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search plays..."
            className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-sm text-white placeholder-slate-500 focus:border-orange-500 focus:outline-none" />
          <select value={filterSituation ?? ''} onChange={e => setFilterSituation(e.target.value || null)}
            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white">
            <option value="">All Situations</option>
            {SITUATIONS.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={sortBy} onChange={e => setSortBy(e.target.value as any)}
            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white">
            <option value="recent">Recent</option><option value="az">A–Z</option><option value="type">Type</option>
          </select>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(play => (
            <div key={play.id} onClick={() => openPlay(play.id)}
              className="bg-slate-800 border border-slate-700 rounded-xl p-4 cursor-pointer hover:border-orange-500/50 transition-all group">
              <div className="flex items-start justify-between mb-2">
                <h3 className="text-white font-semibold">{play.name}</h3>
                <span className={`text-[10px] px-2 py-0.5 rounded-full ${SIT_CLS[play.situation] || SIT_CLS.Custom}`}>{play.situation}</span>
              </div>
              <p className="text-slate-400 text-xs mb-3 line-clamp-2">{play.notes || 'No notes'}</p>
              <div className="flex items-center justify-between">
                <div className="flex gap-1">
                  {play.tags.slice(0, 3).map(t => <span key={t} className="text-[10px] px-1.5 py-0.5 bg-slate-700 rounded text-slate-400">{t}</span>)}
                </div>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={e => { e.stopPropagation(); duplicatePlay(play.id); }} className="text-slate-400 hover:text-white text-xs px-2 py-1 rounded bg-slate-700">⚇</button>
                  <button onClick={e => { e.stopPropagation(); if (confirm('Delete this play?')) deletePlay(play.id); }} className="text-red-400 hover:text-red-300 text-xs px-2 py-1 rounded bg-slate-700">✕</button>
                </div>
              </div>
            </div>
          ))}
        </div>
        {filtered.length === 0 && <p className="text-center text-slate-500 py-16">No plays found. Create one!</p>}
      </div>
      <NewPlayModal open={showNew} onClose={() => setShowNew(false)} />
    </div>
  );
}

// ── CourtCanvas ─────────────────────────────────────────────────────────────────

const PR = 18, HR = 22;

function CourtCanvas({ play, frameIndex }: { play: Play; frameIndex: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { activeTool, selection, isAnimating, animFrame, setSelection, movePlayer, addAction, addPlayer, addAnnotation, deleteAction, deletePlayer } = useStore();
  const [drag, setDrag] = useState<{ id: string; pos: Pos } | null>(null);
  const [actionDraw, setActionDraw] = useState<{ fromId: string; start: Pos; cur: Pos } | null>(null);
  const PAD = 24;

  const getBounds = useCallback(() => {
    const c = canvasRef.current; if (!c) return { x: PAD, y: PAD, width: 100, height: 100 };
    return { x: PAD, y: PAD, width: c.width - PAD * 2, height: c.height - PAD * 2 };
  }, []);
  const toPixel = useCallback((nx: number, ny: number) => { const b = getBounds(); return { x: b.x + nx * b.width, y: b.y + ny * b.height }; }, [getBounds]);
  const toNorm = useCallback((px: number, py: number) => { const b = getBounds(); return { x: Math.max(0, Math.min(1, (px - b.x) / b.width)), y: Math.max(0, Math.min(1, (py - b.y) / b.height)) }; }, [getBounds]);

  const getPos = useCallback((p: Player, fi: number): Pos => p.positions[fi] ?? p.positions[0] ?? { x: 0.5, y: 0.5 }, []);
  const findPlayerAt = useCallback((px: number, py: number) => {
    const fi = isAnimating ? animFrame : frameIndex;
    for (const p of play.players) { const pos = getPos(p, fi); const { x, y } = toPixel(pos.x, pos.y); if (Math.hypot(px - x, py - y) <= HR) return p; }
    return null;
  }, [play.players, frameIndex, animFrame, isAnimating, getPos, toPixel]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H); ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, W, H);
    drawHalfCourt(ctx, getBounds());
    const fi = isAnimating ? animFrame : frameIndex;
    play.actions.filter(a => a.frameIndex === fi).forEach(action => {
      const fp = play.players.find(p => p.id === action.fromPlayerId); if (!fp) return;
      const fpos = getPos(fp, fi), fpx = toPixel(fpos.x, fpos.y);
      let tpos: Pos | null = null;
      if (action.toPlayerId) { const tp = play.players.find(p => p.id === action.toPlayerId); if (tp) tpos = getPos(tp, fi); }
      else if (action.toPosition) tpos = action.toPosition;
      if (!tpos) return;
      const tpx = toPixel(tpos.x, tpos.y);
      const isSel = selection.type === 'action' && selection.id === action.id;
      drawArrow(ctx, fpx, tpx, action.type, isSel ? '#f97316' : '#fbbf24', isSel);
    });
    if (actionDraw) {
      const fp = toPixel(actionDraw.start.x, actionDraw.start.y), tp = toPixel(actionDraw.cur.x, actionDraw.cur.y);
      ctx.save(); ctx.globalAlpha = 0.6; drawArrow(ctx, fp, tp, activeTool, '#f97316', false); ctx.restore();
    }
    play.players.forEach(p => {
      const pos = drag?.id === p.id ? drag.pos : getPos(p, fi);
      const { x, y } = toPixel(pos.x, pos.y);
      const isSel = selection.type === 'player' && selection.id === p.id;
      ctx.save(); ctx.shadowColor = p.team === 'offense' ? 'rgba(59,130,246,0.4)' : 'rgba(239,68,68,0.4)'; ctx.shadowBlur = isSel ? 14 : 6;
      ctx.beginPath(); ctx.arc(x, y, PR, 0, Math.PI * 2); ctx.fillStyle = p.team === 'offense' ? '#2563eb' : '#dc2626'; ctx.fill();
      if (isSel) { ctx.strokeStyle = '#f97316'; ctx.lineWidth = 2.5; ctx.stroke(); }
      ctx.restore();
      ctx.font = `bold ${p.label.length > 2 ? '9' : '11'}px system-ui`; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(p.label, x, y);
    });
  }, [play, frameIndex, animFrame, isAnimating, selection, drag, actionDraw, activeTool, getBounds, toPixel, getPos]);

  useEffect(() => {
    const c = containerRef.current; if (!c) return;
    const obs = new ResizeObserver(() => {
      const canvas = canvasRef.current; if (!canvas) return;
      const w = c.clientWidth, h = w * (47 / 50) + PAD * 2;
      if (canvas.width !== w || canvas.height !== h) { canvas.width = Math.max(w, 100); canvas.height = Math.max(h, 100); draw(); }
    }); obs.observe(c); return () => obs.disconnect();
  }, [draw]);
  useEffect(() => { draw(); }, [draw]);

  const getCanvasPos = (e: React.MouseEvent) => {
    const canvas = canvasRef.current!; const rect = canvas.getBoundingClientRect();
    return { px: (e.clientX - rect.left) * (canvas.width / rect.width), py: (e.clientY - rect.top) * (canvas.height / rect.height) };
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (isAnimating) return; const { px, py } = getCanvasPos(e); const norm = toNorm(px, py);
    if (activeTool === 'select') {
      const p = findPlayerAt(px, py);
      if (p) { setSelection({ type: 'player', id: p.id }); setDrag({ id: p.id, pos: getPos(p, frameIndex) }); }
      else setSelection({ type: null, id: null });
    } else if (['cut','pass','dribble','screen','handoff'].includes(activeTool)) {
      const p = findPlayerAt(px, py);
      if (p) setActionDraw({ fromId: p.id, start: getPos(p, frameIndex), cur: norm });
    } else if (activeTool === 'place-offense') {
      addPlayer(play.id, { team: 'offense', label: String(play.players.filter(p => p.team === 'offense').length + 1), positions: { [frameIndex]: norm } });
    } else if (activeTool === 'place-defense') {
      addPlayer(play.id, { team: 'defense', label: 'X' + String(play.players.filter(p => p.team === 'defense').length + 1), positions: { [frameIndex]: norm } });
    } else if (activeTool === 'eraser') {
      const p = findPlayerAt(px, py); if (p) { deletePlayer(play.id, p.id); return; }
    }
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (isAnimating) return; const { px, py } = getCanvasPos(e); const norm = toNorm(px, py);
    if (drag) setDrag({ ...drag, pos: norm });
    if (actionDraw) setActionDraw(prev => prev ? { ...prev, cur: norm } : null);
  };
  const onMouseUp = (e: React.MouseEvent) => {
    if (isAnimating) return; const { px, py } = getCanvasPos(e);
    if (drag) { movePlayer(play.id, drag.id, frameIndex, drag.pos); setDrag(null); }
    if (actionDraw) {
      const target = findPlayerAt(px, py); const norm = toNorm(px, py);
      addAction(play.id, { type: activeTool as ActionType, fromPlayerId: actionDraw.fromId, toPlayerId: target?.id, toPosition: !target ? norm : undefined, frameIndex });
      setActionDraw(null);
    }
  };

  return (
    <div ref={containerRef} className="flex-1 relative overflow-hidden">
      <canvas ref={canvasRef} className="w-full h-full block" onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp}
        onMouseLeave={() => { if (drag) { movePlayer(play.id, drag.id, frameIndex, drag.pos); setDrag(null); } setActionDraw(null); }} />
    </div>
  );
}

// ── EditorView ──────────────────────────────────────────────────────────────────

function EditorView() {
  const { plays, activePlayId, currentFrame, activeTool, selection, isAnimating, animFrame,
    backToLibrary, setActiveTool, setCurrentFrame, setSelection, setIsAnimating, setAnimFrame,
    addFrame, duplicateFrame, deleteFrame, updatePlayMeta, undo, redo, openQuiz } = useStore();
  const play = plays.find(p => p.id === activePlayId);
  const animRef = useRef<number>(0);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const map: Record<string, string> = { v:'select',c:'cut',p:'pass',d:'dribble',s:'screen',h:'handoff',o:'place-offense',x:'place-defense',t:'text',e:'eraser' };
      const tool = map[e.key.toLowerCase()];
      if (tool) setActiveTool(tool as Tool);
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, [setActiveTool, undo, redo]);

  const startAnimation = () => {
    if (!play || play.frames.length < 2) return;
    setIsAnimating(true); setAnimFrame(0);
    let fi = 0;
    const step = () => {
      fi++;
      if (fi >= play.frames.length) { setIsAnimating(false); return; }
      setAnimFrame(fi);
      animRef.current = window.setTimeout(step, play.frames[fi]?.durationMs ?? 1500);
    };
    animRef.current = window.setTimeout(step, play.frames[0]?.durationMs ?? 1500);
  };
  const stopAnimation = () => { clearTimeout(animRef.current); setIsAnimating(false); };

  if (!play) return (<div className="min-h-screen bg-slate-900 flex items-center justify-center text-slate-400">
    <div className="text-center"><p className="text-4xl mb-4">🏀</p><p>No play selected</p>
      <button onClick={backToLibrary} className="mt-4 px-4 py-2 bg-orange-500 rounded-lg text-white text-sm">Back to Library</button>
    </div></div>);

  return (
    <div className="h-screen bg-slate-900 flex flex-col overflow-hidden">
      {/* Top Bar */}
      <div className="flex items-center gap-3 px-4 py-2.5 bg-slate-900 border-b border-slate-800">
        <button onClick={backToLibrary} className="text-slate-400 hover:text-white text-sm">← Library</button>
        <input value={play.name} onChange={e => updatePlayMeta(play.id, { name: e.target.value })}
          className="bg-transparent text-white font-semibold text-sm border-b border-transparent hover:border-slate-600 focus:border-orange-500 focus:outline-none px-1" />
        <span className="text-slate-500 text-xs">{play.type} · {play.situation}</span>
        <div className="flex-1" />
        <button onClick={() => isAnimating ? stopAnimation() : startAnimation()}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${isAnimating ? 'bg-red-500 text-white' : 'bg-orange-500 text-white'}`}>
          {isAnimating ? '■ Stop' : '▶ Animate'}
        </button>
        <button onClick={() => openQuiz(play.id)} className="px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 text-xs hover:border-orange-500">
          Quiz
        </button>
        <button onClick={() => undo()} className="px-2 py-1.5 rounded-lg border border-slate-700 text-slate-400 text-xs">↩</button>
        <button onClick={() => redo()} className="px-2 py-1.5 rounded-lg border border-slate-700 text-slate-400 text-xs">↪</button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Tool Palette */}
        <div className="w-12 shrink-0 bg-slate-900 border-r border-slate-800 flex flex-col items-center gap-1 py-2">
          {TOOLS.map(t => (
            <button key={t.key} onClick={() => setActiveTool(t.key)} title={`${t.label} (${t.shortcut})`}
              className={`w-9 h-9 rounded-lg text-[10px] font-semibold flex items-center justify-center transition-all
                ${activeTool === t.key ? 'bg-orange-500/20 text-orange-400 border border-orange-500' : 'text-slate-500 hover:text-white hover:bg-slate-800 border border-transparent'}`}>
              {t.shortcut}
            </button>
          ))}
        </div>

        {/* Canvas */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          <div className="flex-1 overflow-hidden flex items-center justify-center bg-slate-950 p-4">
            <CourtCanvas play={play} frameIndex={currentFrame} />
          </div>

          {/* Frame Timeline */}
          <div className="flex items-center gap-2 px-4 py-2.5 bg-slate-900 border-t border-slate-800 overflow-x-auto">
            <span className="text-slate-500 text-xs shrink-0">Frames:</span>
            {play.frames.map(frame => (
              <div key={frame.index} className="relative group">
                <button onClick={() => { setCurrentFrame(frame.index); setSelection({ type: 'frame', id: String(frame.index) }); }}
                  className={`h-10 min-w-[52px] px-3 rounded-lg border text-xs font-semibold transition-all
                    ${currentFrame === frame.index ? 'border-orange-500 bg-orange-500/20 text-orange-400' : 'border-slate-700 bg-slate-800 text-slate-400 hover:border-slate-600'}`}>
                  <span className="text-[10px] text-slate-500 font-normal">F{frame.index + 1}</span><br/>{Math.round(frame.durationMs / 100) / 10}s
                </button>
                {play.frames.length > 1 && (
                  <button onClick={() => deleteFrame(play.id, frame.index)}
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 text-white text-[9px] opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">✕</button>
                )}
              </div>
            ))}
            <button onClick={() => addFrame(play.id)} className="h-10 min-w-[40px] px-2 rounded-lg border border-dashed border-slate-700 text-slate-500 hover:border-orange-500/50 hover:text-orange-400 text-xs font-bold">+</button>
            {play.frames.length > 0 && (
              <button onClick={() => duplicateFrame(play.id, currentFrame)} className="h-10 px-2 rounded-lg border border-slate-700 text-slate-500 hover:text-white text-[10px]">⧉</button>
            )}
          </div>
        </div>

        {/* Inspector Panel */}
        <div className="w-[260px] shrink-0 border-l border-slate-800 bg-slate-900 overflow-y-auto p-4">
          <h3 className="text-slate-400 text-xs font-medium uppercase tracking-wider mb-3">Inspector</h3>
          {!selection.type && (
            <div className="space-y-3">
              <div className="text-slate-300 text-sm font-semibold">{play.name}</div>
              <div className="text-slate-500 text-xs">{play.type} · {play.situation}</div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="bg-slate-800 rounded-lg px-2 py-1.5"><span className="text-slate-500 text-[10px]">Players</span><br/><span className="text-white font-semibold">{play.players.length}</span></div>
                <div className="bg-slate-800 rounded-lg px-2 py-1.5"><span className="text-slate-500 text-[10px]">Frames</span><br/><span className="text-white font-semibold">{play.frames.length}</span></div>
                <div className="bg-slate-800 rounded-lg px-2 py-1.5"><span className="text-slate-500 text-[10px]">Actions</span><br/><span className="text-white font-semibold">{play.actions.length}</span></div>
                <div className="bg-slate-800 rounded-lg px-2 py-1.5"><span className="text-slate-500 text-[10px]">Court</span><br/><span className="text-white font-semibold">{play.court === 'half' ? 'Half' : 'Full'}</span></div>
              </div>
              <textarea value={play.notes} onChange={e => updatePlayMeta(play.id, { notes: e.target.value })} placeholder="Coaching notes..."
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-orange-500 resize-none" rows={4} />
            </div>
          )}
          {selection.type === 'player' && (() => {
            const sp = play.players.find(p => p.id === selection.id);
            if (!sp) return null;
            return (
              <div className="space-y-3">
                <div className="text-white text-sm font-semibold">Player: {sp.label}</div>
                <div className="text-slate-400 text-xs">Team: {sp.team}</div>
                <button onClick={() => useStore.getState().deletePlayer(play.id, sp.id)}
                  className="w-full py-2 rounded-lg bg-red-900/30 border border-red-800/50 text-red-400 text-xs">Delete Player</button>
              </div>
            );
          })()}
          {selection.type === 'action' && (() => {
            const sa = play.actions.find(a => a.id === selection.id);
            if (!sa) return null;
            return (
              <div className="space-y-3">
                <div className="text-white text-sm font-semibold">Action: {sa.type}</div>
                <div className="text-slate-400 text-xs">Frame {sa.frameIndex + 1}</div>
                <button onClick={() => useStore.getState().deleteAction(play.id, sa.id)}
                  className="w-full py-2 rounded-lg bg-red-900/30 border border-red-800/50 text-red-400 text-xs">Delete Action</button>
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}

// ==================== MAIN PAGE ====================
export default function Page() {
  const { view, activePlayId } = useStore();

  return (
    <div className="h-screen bg-slate-950 text-white flex flex-col">
      {view === 'editor' && activePlayId ? (
        <EditorView />
      ) : (
        <LibraryView />
      )}
    </div>
  );
}
